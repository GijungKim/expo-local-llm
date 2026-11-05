package expo.modules.localllm

import android.graphics.Bitmap
import android.util.Log
import com.google.mlkit.genai.common.DownloadStatus
import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.common.GenAiException
import com.google.mlkit.genai.prompt.GenerateContentRequest
import com.google.mlkit.genai.prompt.Generation
import com.google.mlkit.genai.prompt.GenerativeModel
import com.google.mlkit.genai.prompt.ImagePart
import com.google.mlkit.genai.prompt.TextPart
import expo.modules.kotlin.exception.CodedException
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
    private const val LOG_TAG = "ExpoLocalLlm"

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
        Log.w(LOG_TAG, "Gemini Nano availability check failed", e)
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
              throw ModelDownloadException("Failed to download model: ${status.e.message}")
            }
          }
        }
      } catch (e: CancellationException) {
        throw e
      } catch (e: ModelDownloadException) {
        throw e
      } catch (e: Exception) {
        throw ModelDownloadException("Failed to download model: ${e.message}")
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

  private suspend fun prepareRequest(prompt: LocalPrompt, fullText: String): PreparedRequest {
    var bitmap: Bitmap? = null
    try {
      bitmap = prompt.image?.let { decodeRequestImage(it) }
      val request = buildGenerateContentRequest(
        prompt.textWithImageLabel(fullText),
        bitmap,
        temperature,
        maxTokens,
        topK
      )
      return PreparedRequest(request, bitmap)
    } catch (error: Throwable) {
      bitmap?.takeUnless(Bitmap::isRecycled)?.recycle()
      throw error
    }
  }

  private fun getOrCreateModel(generation: ActiveGeneration): GenerativeModel =
    synchronized(stateLock) {
      if (!isCurrentLocked(generation)) {
        throw CancellationException("Generation was cancelled")
      }
      model ?: Generation.getClient().also { model = it }
    }

  private fun isCurrentLocked(generation: ActiveGeneration): Boolean =
    activeGeneration === generation && generation.acceptsOutput

  internal suspend fun respond(prompt: LocalPrompt, requestId: String? = null): String {
    val generation = beginGeneration(GenerationKind.RESPOND, requestId)
    val completion = CompletableDeferred<String>()
    val job = scope.launch(start = CoroutineStart.LAZY) {
      try {
        val fullPrompt = synchronized(stateLock) {
          if (!isCurrentLocked(generation)) {
            throw CancellationException("Generation was cancelled")
          }
          history.buildPrompt(addingUserMessage = prompt.text)
        }
        val prepared = prepareRequest(prompt, fullPrompt)
        val text = try {
          getOrCreateModel(generation)
            .generateContent(prepared.handOffToSDK())
            .candidates
            .firstOrNull()
            ?.text
            .orEmpty()
        } finally {
          prepared.recycleIfUnsubmitted()
        }
        synchronized(stateLock) {
          if (!isCurrentLocked(generation)) {
            throw CancellationException("Generation was cancelled")
          }
          history.addExchange(prompt.text, text)
        }
        completion.complete(text)
      } catch (error: CancellationException) {
        completion.completeExceptionally(error)
      } catch (error: Exception) {
        completion.completeExceptionally(mapImageRequestError(error, prompt))
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
  internal suspend fun streamResponse(prompt: LocalPrompt, requestId: String? = null): String {
    val generation = beginGeneration(GenerationKind.STREAM, requestId)
    val completion = CompletableDeferred<String>()
    val job = scope.launch(start = CoroutineStart.LAZY) {
      var accumulated = ""
      try {
        val fullPrompt = synchronized(stateLock) {
          if (!isCurrentLocked(generation)) {
            throw CancellationException("Generation was cancelled")
          }
          history.buildPrompt(addingUserMessage = prompt.text)
        }
        val prepared = prepareRequest(prompt, fullPrompt)
        try {
          getOrCreateModel(generation).generateContentStream(prepared.handOffToSDK()).collect { chunk ->
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
        } finally {
          prepared.recycleIfUnsubmitted()
        }

        synchronized(stateLock) {
          if (isCurrentLocked(generation)) {
            history.addExchange(prompt.text, accumulated)
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
        val failure = mapImageRequestError(error, prompt)
        synchronized(stateLock) {
          if (isCurrentLocked(generation)) {
            emit("streamError", mapOf(
              "error" to failure.message,
              "code" to failure.code,
              "requestId" to generation.requestId
            ))
          }
        }
        completion.completeExceptionally(failure)
      }
    }
    job.invokeOnCompletion { error ->
      if (!completion.isCompleted) {
        if (error is CancellationException) {
          completion.complete("")
        } else {
          completion.completeExceptionally(
            error ?: GenerationException(LocalLLMErrorCode.GENERATION_FAILED, "Stream ended without a result", null)
          )
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

private class PreparedRequest(
  private val request: GenerateContentRequest,
  bitmap: Bitmap?
) {
  private val image = RequestImage(bitmap)

  fun handOffToSDK(): GenerateContentRequest {
    image.handOffToSDK()
    return request
  }

  fun recycleIfUnsubmitted() = image.recycleIfUnsubmitted()
}

internal fun buildGenerateContentRequest(
  text: String,
  bitmap: Bitmap?,
  temperature: Float?,
  maxTokens: Int?,
  topK: Int?
): GenerateContentRequest {
  val textPart = TextPart(text)
  val builder = if (bitmap == null) {
    GenerateContentRequest.Builder(textPart)
  } else {
    // beta2 exposes exactly this multimodal constructor. Multipart Content,
    // needed for multiple images, first appears in beta3 and requires a newer
    // Kotlin toolchain than the library's supported Expo versions.
    GenerateContentRequest.Builder(ImagePart(bitmap), textPart)
  }
  return builder.apply {
    this.temperature = temperature
    maxOutputTokens = maxTokens
    this.topK = topK
  }.build()
}

internal fun mapImageRequestError(error: Exception, prompt: LocalPrompt): CodedException {
  if (error is CodedException) {
    return error
  }
  if (
    prompt.image != null &&
    error is GenAiException &&
    error.errorCode == GenAiException.ErrorCode.INVALID_INPUT_IMAGE
  ) {
    return ImageInvalidException(
      "The on-device model rejected image \"${prompt.image.label}\"; try a smaller or different image",
      error
    )
  }
  return generationException(error)
}
