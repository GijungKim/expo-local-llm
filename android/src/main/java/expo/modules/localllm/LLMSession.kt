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

  fun startStream(prompt: String) {
    streamJob?.cancel()
    history.addUserMessage(prompt)
    val fullPrompt = history.buildPrompt()

    streamJob = scope.launch {
      try {
        val genModel = getOrCreateModel()
        var accumulated = ""
        val responseStream = genModel.generateContentStream(fullPrompt)
        responseStream.collect { chunk ->
          val token = chunk.text ?: ""
          accumulated += token
          emit("token", mapOf(
            "token" to token,
            "accumulated" to accumulated
          ))
        }
        history.addAssistantMessage(accumulated)
        emit("streamComplete", mapOf("text" to accumulated))
      } catch (e: CancellationException) {
        // User-initiated cancellation — not an error
      } catch (e: Exception) {
        emit("streamError", mapOf("error" to (e.message ?: "Unknown error")))
      }
    }
  }

  fun cancelStream() {
    streamJob?.cancel()
    streamJob = null
  }

  override fun deallocate() {
    super.deallocate()
    streamJob?.cancel()
    model = null
    scope.cancel()
  }
}
