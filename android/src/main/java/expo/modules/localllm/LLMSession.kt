package expo.modules.localllm

import android.content.Context
import com.google.ai.edge.localagent.GenerativeModel
import com.google.ai.edge.localagent.GenerationConfig
import com.google.ai.edge.localagent.LocalAgent
import expo.modules.kotlin.sharedobjects.SharedObject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

class LLMSession(
  private val context: Context,
  config: SessionConfig
) : SharedObject() {
  private val history = ConversationHistory(config.instructions)
  private val temperature = config.options?.temperature
  private val maxTokens = config.options?.maxTokens
  private val topK = config.options?.topK
  private var model: GenerativeModel? = null
  private var streamJob: Job? = null
  private val scope = CoroutineScope(Dispatchers.Main)

  companion object {
    fun checkAvailability(context: Context): ModelAvailability {
      return try {
        val status = LocalAgent.getFeatureStatus(context)
        when {
          status.isAvailable -> ModelAvailability.available
          status.isDownloading -> ModelAvailability.downloading
          status.isDownloadRequired -> ModelAvailability.downloadRequired
          else -> ModelAvailability.notEligible
        }
      } catch (e: Exception) {
        ModelAvailability.notEligible
      }
    }

    suspend fun downloadModel(context: Context, onProgress: (Float) -> Unit) {
      try {
        // TODO: ML Kit GenAI download API may provide progress callbacks
        // once the SDK stabilizes. For now, report start/complete.
        onProgress(0f)
        LocalAgent.downloadModel(context)
        onProgress(1f)
      } catch (e: Exception) {
        throw StreamException("Failed to download model: ${e.message}")
      }
    }
  }

  private suspend fun getOrCreateModel(): GenerativeModel {
    if (model == null) {
      val configBuilder = GenerationConfig.Builder()
      temperature?.let { configBuilder.temperature = it }
      maxTokens?.let { configBuilder.maxOutputTokens = it.coerceAtMost(256) }
      topK?.let { configBuilder.topK = it }

      model = LocalAgent.createGenerativeModel(
        context = context,
        generationConfig = configBuilder.build()
      )
    }
    return model!!
  }

  suspend fun respond(prompt: String): String {
    val genModel = getOrCreateModel()
    history.addUserMessage(prompt)
    val fullPrompt = history.buildPrompt()
    val response = genModel.generateContent(fullPrompt)
    val text = response.text ?: ""
    history.addAssistantMessage(text)
    return text
  }

  /**
   * Stream a response, emitting `token` events along the way. Resolves with
   * the final text when the stream completes, or with the partial text
   * produced so far if the stream is cancelled. Emits `streamComplete` only
   * on natural completion, `streamError` on failure.
   */
  suspend fun streamResponse(prompt: String): String {
    streamJob?.cancel()
    history.addUserMessage(prompt)
    val fullPrompt = history.buildPrompt()

    var accumulated = ""
    var failure: Exception? = null
    var completed = false
    val job = scope.launch {
      try {
        val genModel = getOrCreateModel()
        genModel.generateContentStream(fullPrompt).collect { chunk ->
          val token = chunk.text ?: ""
          accumulated += token
          emit("token", mapOf(
            "token" to token,
            "accumulated" to accumulated
          ))
        }
        completed = true
      } catch (e: CancellationException) {
        // User-initiated cancellation — not an error
        throw e
      } catch (e: Exception) {
        failure = e
        emit("streamError", mapOf("error" to (e.message ?: "Unknown error")))
      }
    }
    streamJob = job
    job.join()

    failure?.let { throw StreamException(it.message ?: "Unknown error") }
    if (accumulated.isNotEmpty()) {
      history.addAssistantMessage(accumulated)
    }
    if (completed) {
      emit("streamComplete", mapOf("text" to accumulated))
    }
    return accumulated
  }

  fun cancelStream() {
    streamJob?.cancel()
    streamJob = null
  }

  /**
   * Clear the conversation history (keeps instructions and generation
   * options). Cancels any in-flight stream.
   */
  fun reset() {
    streamJob?.cancel()
    streamJob = null
    history.clear()
  }

  override fun deallocate() {
    super.deallocate()
    streamJob?.cancel()
    model = null
    scope.cancel()
  }
}
