package expo.modules.localllm

import com.google.mlkit.genai.common.DownloadStatus
import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.prompt.GenerateContentRequest
import com.google.mlkit.genai.prompt.Generation
import com.google.mlkit.genai.prompt.GenerativeModel
import com.google.mlkit.genai.prompt.TextPart
import expo.modules.kotlin.sharedobjects.SharedObject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.util.UUID

class LLMSession(
  config: SessionConfig
) : SharedObject() {
  private enum class GenerationKind { RESPOND, STREAM }

  private class ActiveGeneration(
    val kind: GenerationKind,
    val requestId: String
  ) {
    var acceptsOutput = true
    var job: Job? = null
  }

  private val history = ConversationHistory(config.instructions)
  private val temperature = config.options?.temperature
  private val maxTokens = config.options?.maxTokens
  private val topK = config.options?.topK
  private val stateLock = Any()
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  private var model: GenerativeModel? = null
  private var activeGeneration: ActiveGeneration? = null
  private var modelResetPending = false
  private var disposed = false

  companion object {
    @Volatile
    private var cachedAvailability = ModelAvailability.unknown
    private val availabilityMutex = Mutex()

    fun getCachedAvailability(): ModelAvailability = cachedAvailability

    suspend fun refreshAvailability(): ModelAvailability = availabilityMutex.withLock {
      var client: GenerativeModel? = null
      val availability = try {
        val activeClient = Generation.getClient().also { client = it }
        when (activeClient.checkStatus()) {
          FeatureStatus.AVAILABLE -> ModelAvailability.available
          FeatureStatus.DOWNLOADING -> ModelAvailability.downloading
          FeatureStatus.DOWNLOADABLE -> ModelAvailability.downloadRequired
          FeatureStatus.UNAVAILABLE -> ModelAvailability.notEligible
          else -> ModelAvailability.unknown
        }
      } catch (e: CancellationException) {
        throw e
      } catch (e: Exception) {
        // SDK/API failures do not prove that the device is ineligible.
        ModelAvailability.unknown
      } finally {
        // Generation.getClient() creates an independent engine-backed client.
        client?.close()
      }
      cachedAvailability = availability
      availability
    }

    suspend fun downloadModel(onProgress: (Float) -> Unit) = availabilityMutex.withLock {
      var client: GenerativeModel? = null
      try {
        val activeClient = Generation.getClient().also { client = it }
        onProgress(0f)
        cachedAvailability = ModelAvailability.downloading
        var bytesToDownload: Long? = null
        activeClient.download().collect { status ->
          when (status) {
            is DownloadStatus.DownloadStarted -> bytesToDownload = status.bytesToDownload
            is DownloadStatus.DownloadProgress -> {
              bytesToDownload?.takeIf { it > 0 }?.let { total ->
                onProgress((status.totalBytesDownloaded.toFloat() / total).coerceIn(0f, 1f))
              }
            }
            DownloadStatus.DownloadCompleted -> onProgress(1f)
            is DownloadStatus.DownloadFailed -> {
              throw StreamException("Failed to download model: ${status.e.message}")
            }
          }
        }
      } catch (e: CancellationException) {
        throw e
      } catch (e: StreamException) {
        throw e
      } catch (e: Exception) {
        throw StreamException("Failed to download model: ${e.message}")
      } finally {
        client?.close()
      }
    }
  }

  private fun beginGeneration(kind: GenerationKind, requestId: String?): ActiveGeneration = synchronized(stateLock) {
    if (disposed) {
      throw SessionInvalidException()
    }
    if (activeGeneration != null) {
      throw SessionBusyException()
    }
    ActiveGeneration(kind, requestId ?: UUID.randomUUID().toString()).also { activeGeneration = it }
  }

  private fun attachJob(generation: ActiveGeneration, job: Job) {
    val shouldCancel = synchronized(stateLock) {
      generation.job = job
      activeGeneration !== generation || !generation.acceptsOutput
    }
    if (shouldCancel) {
      job.cancel()
    }
  }

  private fun finishGeneration(generation: ActiveGeneration) {
    val oldModel = synchronized(stateLock) {
      if (activeGeneration === generation) {
        activeGeneration = null
        if (modelResetPending) {
          modelResetPending = false
          model.also { model = null }
        } else {
          null
        }
      } else {
        null
      }
    }
    oldModel?.close()
  }

  private fun invalidateGeneration(generation: ActiveGeneration): Job? = synchronized(stateLock) {
    if (activeGeneration === generation) {
      generation.acceptsOutput = false
    }
    generation.job
  }

  private fun createRequest(prompt: String): GenerateContentRequest =
    GenerateContentRequest.Builder(TextPart(prompt)).apply {
      temperature = this@LLMSession.temperature
      maxOutputTokens = this@LLMSession.maxTokens
      topK = this@LLMSession.topK
    }.build()

  private fun getOrCreateModel(generation: ActiveGeneration): GenerativeModel =
    synchronized(stateLock) {
      if (!isCurrentLocked(generation)) {
        throw CancellationException("Generation was cancelled")
      }
      model ?: Generation.getClient().also { model = it }
    }

  private fun isCurrentLocked(generation: ActiveGeneration): Boolean =
    activeGeneration === generation && generation.acceptsOutput

  suspend fun respond(prompt: String, requestId: String? = null): String {
    val generation = beginGeneration(GenerationKind.RESPOND, requestId)
    val completion = CompletableDeferred<String>()
    val job = scope.launch(start = CoroutineStart.LAZY) {
      try {
        val fullPrompt = synchronized(stateLock) {
          if (!isCurrentLocked(generation)) {
            throw CancellationException("Generation was cancelled")
          }
          history.buildPrompt(addingUserMessage = prompt)
        }
        val response = getOrCreateModel(generation).generateContent(createRequest(fullPrompt))
        val text = response.candidates.firstOrNull()?.text.orEmpty()
        synchronized(stateLock) {
          if (!isCurrentLocked(generation)) {
            throw CancellationException("Generation was cancelled")
          }
          history.addExchange(prompt, text)
        }
        completion.complete(text)
      } catch (error: Throwable) {
        completion.completeExceptionally(error)
      }
    }
    job.invokeOnCompletion { error ->
      if (!completion.isCompleted) {
        completion.completeExceptionally(error ?: CancellationException("Generation ended without a result"))
      }
    }
    attachJob(generation, job)
    job.start()

    return try {
      job.join()
      completion.await()
    } finally {
      withContext(NonCancellable) {
        if (!job.isCompleted) {
          invalidateGeneration(generation)?.cancel()
        }
        job.cancelAndJoin()
        finishGeneration(generation)
      }
    }
  }

  /**
   * Stream a response, emitting `token` events along the way. Resolves with
   * the final text when the stream completes, or with the partial text
   * produced so far if the stream is cancelled. Emits `streamComplete` only
   * on natural completion, `streamError` on failure.
   */
  suspend fun streamResponse(prompt: String, requestId: String? = null): String {
    val generation = beginGeneration(GenerationKind.STREAM, requestId)
    val completion = CompletableDeferred<String>()
    val job = scope.launch(start = CoroutineStart.LAZY) {
      var accumulated = ""
      try {
        val fullPrompt = synchronized(stateLock) {
          if (!isCurrentLocked(generation)) {
            throw CancellationException("Generation was cancelled")
          }
          history.buildPrompt(addingUserMessage = prompt)
        }
        getOrCreateModel(generation).generateContentStream(createRequest(fullPrompt)).collect { chunk ->
          val token = chunk.candidates.firstOrNull()?.text.orEmpty()
          synchronized(stateLock) {
            if (!isCurrentLocked(generation)) {
              throw CancellationException("Generation was cancelled")
            }
            accumulated += token
            emit("token", mapOf(
              "token" to token,
              "accumulated" to accumulated,
              "requestId" to generation.requestId
            ))
          }
        }

        synchronized(stateLock) {
          if (isCurrentLocked(generation)) {
            history.addExchange(prompt, accumulated)
            emit("streamComplete", mapOf(
              "text" to accumulated,
              "requestId" to generation.requestId
            ))
          }
        }
        completion.complete(accumulated)
      } catch (error: CancellationException) {
        completion.complete(accumulated)
      } catch (error: Exception) {
        synchronized(stateLock) {
          if (isCurrentLocked(generation)) {
            emit("streamError", mapOf(
              "error" to (error.message ?: "Unknown error"),
              "requestId" to generation.requestId
            ))
          }
        }
        completion.completeExceptionally(StreamException(error.message ?: "Unknown error"))
      }
    }
    job.invokeOnCompletion { error ->
      if (!completion.isCompleted) {
        if (error is CancellationException) {
          completion.complete("")
        } else {
          completion.completeExceptionally(error ?: StreamException("Stream ended without a result"))
        }
      }
    }
    attachJob(generation, job)
    job.start()

    return try {
      job.join()
      completion.await()
    } finally {
      withContext(NonCancellable) {
        if (!job.isCompleted) {
          invalidateGeneration(generation)?.cancel()
        }
        job.cancelAndJoin()
        finishGeneration(generation)
      }
    }
  }

  fun cancelStream() {
    val job = synchronized(stateLock) {
      activeGeneration
        ?.takeIf { it.kind == GenerationKind.STREAM }
        ?.also { it.acceptsOutput = false }
        ?.job
    }
    job?.cancel()
  }

  /**
   * Clear the conversation history (keeps instructions and generation
   * options). Cancels any in-flight generation.
   */
  fun reset() {
    val (job, oldModel) = synchronized(stateLock) {
      if (disposed) {
        throw SessionInvalidException()
      }
      val generation = activeGeneration
      generation?.acceptsOutput = false
      history.clear()
      if (generation == null) {
        modelResetPending = false
        null to model.also { model = null }
      } else {
        // Keep the busy slot and current client until its producer has fully
        // stopped. finishGeneration closes it before another turn can start.
        modelResetPending = true
        generation.job to null
      }
    }
    job?.cancel()
    oldModel?.close()
  }

  override fun sharedObjectDidRelease() {
    var shouldRelease = false
    val (job, oldModel) = synchronized(stateLock) {
      if (disposed) {
        null to null
      } else {
        shouldRelease = true
        disposed = true
        val generation = activeGeneration
        generation?.acceptsOutput = false
        if (generation == null) {
          modelResetPending = false
          null to model.also { model = null }
        } else {
          // Do not close an engine-backed client while its producer is still
          // unwinding. The request's non-cancellable finally block owns close.
          modelResetPending = true
          generation.job to null
        }
      }
    }
    if (!shouldRelease) return
    job?.cancel()
    oldModel?.close()
    scope.cancel()
    super.sharedObjectDidRelease()
  }
}
