package expo.modules.localllm

import android.graphics.Bitmap
import android.util.Log
import com.google.mlkit.genai.common.DownloadStatus
import com.google.mlkit.genai.common.GenAiException
import com.google.mlkit.genai.prompt.Content
import com.google.mlkit.genai.prompt.GenerateContentRequest
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

class LLMSession(
  config: SessionConfig
) : SharedObject() {
  private val history = ConversationHistory(config.instructions)
  private val androidModel = AndroidModel.parse(config.androidModel)
  private var tools = NativeTool.declarations(config.tools.orEmpty())
  private val toolTimeoutMillis = (config.toolTimeout ?: 30.0).let {
    if (!it.isFinite() || it <= 0 || it > Long.MAX_VALUE / 1000.0) {
      throw ToolInvalidException("toolTimeout must be a finite positive number of seconds")
    }
    (it * 1000).toLong().coerceAtLeast(1)
  }
  private val temperature = config.options?.temperature
  private val maxTokens = config.options?.maxTokens
  private val topK = config.options?.topK
  private val lifecycle = GenerationLifecycle()
  private val stateLock = lifecycle.lock
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  private var model: GenerativeModel? = null
  private val activeGeneration get() = lifecycle.active
  private var modelResetPending = false
  private val disposed get() = lifecycle.disposed

  companion object {
    private const val LOG_TAG = "ExpoLocalLlm"

    @Volatile
    private var cachedAvailability = mapOf<AndroidModel, ModelAvailability>()
    private val availabilityMutex = Mutex()

    internal fun getCachedAvailability(selection: AndroidModel): ModelAvailability =
      cachedAvailability[selection] ?: ModelAvailability.unknown

    internal suspend fun refreshAvailability(selection: AndroidModel): ModelAvailability = availabilityMutex.withLock {
      var client: GenerativeModel? = null
      val availability = try {
        val activeClient = selection.client().also { client = it }
        modelAvailability(activeClient.checkStatus())
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
      cachedAvailability = cachedAvailability + (selection to availability)
      availability
    }

    internal suspend fun readiness(selection: AndroidModel): Map<String, String> = availabilityMutex.withLock {
      val client = selection.client()
      try {
        modelReadiness(client).also {
          cachedAvailability = cachedAvailability + (selection to ModelAvailability.valueOf(it.getValue("availability")))
        }
      } finally { client.close() }
    }

    internal suspend fun downloadModel(selection: AndroidModel, onProgress: (Float) -> Unit) = availabilityMutex.withLock {
      var client: GenerativeModel? = null
      try {
        val activeClient = selection.client().also { client = it }
        onProgress(0f)
        cachedAvailability = cachedAvailability + (selection to ModelAvailability.downloading)
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

  private fun beginGeneration(kind: GenerationKind, requestId: String?) = lifecycle.begin(kind, requestId)

  private fun attachJob(generation: ActiveGeneration, job: Job) = lifecycle.attach(generation, job)

  private fun finishGeneration(generation: ActiveGeneration) {
    val oldModel = synchronized(stateLock) {
      if (activeGeneration === generation) {
        lifecycle.finish(generation)
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

  private fun invalidateGeneration(generation: ActiveGeneration) = lifecycle.invalidate(generation)

  private suspend fun prepareRequest(prompt: LocalPrompt, fullText: String): PreparedRequest {
    var bitmaps = emptyList<Bitmap>()
    try {
      bitmaps = decodeRequestImages(prompt.images)
      val request = buildGenerateContentRequest(
        fullText,
        prompt.imageSections().zip(bitmaps),
        temperature,
        maxTokens,
        topK
      )
      return PreparedRequest(request, bitmaps)
    } catch (error: Throwable) {
      bitmaps.forEach { bitmap ->
        if (!bitmap.isRecycled) {
          bitmap.recycle()
        }
      }
      throw error
    }
  }

  private fun getOrCreateModel(generation: ActiveGeneration): GenerativeModel =
    synchronized(stateLock) {
      if (!isCurrentLocked(generation)) {
        throw CancellationException("Generation was cancelled")
      }
      model ?: androidModel.client().also { model = it }
    }

  private fun isCurrentLocked(generation: ActiveGeneration): Boolean =
    lifecycle.isCurrent(generation)

  internal suspend fun respond(prompt: LocalPrompt, requestId: String? = null): String {
    val generation = beginGeneration(GenerationKind.RESPOND, requestId)
    val completion = CompletableDeferred<String>()
    val job = scope.launch(start = CoroutineStart.LAZY) {
      try {
        val text = if (synchronized(stateLock) { tools.isNotEmpty() || history.hasToolProtocol }) {
          runToolTurns(generation, prompt) {}.also {
            synchronized(stateLock) {
              if (!isCurrentLocked(generation)) throw CancellationException("Generation cancelled")
              history.addToolExchange(requireNotNull(generation.exchange))
            }
          }
        } else {
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
          text
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
        val protocol = synchronized(stateLock) { tools.isNotEmpty() || history.hasToolProtocol }
        if (protocol) {
          runToolTurns(generation, prompt) { accumulated = it }
        } else {
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
        }

        lifecycle.finishOutput(generation) {
          if (protocol) history.addToolExchange(requireNotNull(generation.exchange))
          else history.addExchange(prompt.text, accumulated)
          emit("streamComplete", mapOf(
            "text" to accumulated,
            "requestId" to generation.requestId
          ))
        }
        completion.complete(accumulated)
      } catch (error: CancellationException) {
        completion.complete(accumulated)
      } catch (error: Exception) {
        val failure = mapImageRequestError(error, prompt)
        lifecycle.finishOutput(generation) {
          emit("streamError", mapOf(
            "error" to failure.message,
            "code" to failure.code,
            "requestId" to generation.requestId
          ))
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

  private suspend fun runToolTurns(
    generation: ActiveGeneration,
    prompt: LocalPrompt,
    onAccumulated: (String) -> Unit
  ): String {
    val (registered, previous) = synchronized(stateLock) {
      if (!isCurrentLocked(generation)) throw CancellationException("Generation cancelled")
      tools.toMap() to history.contents()
    }
    val client = getOrCreateModel(generation)
    if (registered.isNotEmpty()) {
      requireToolSupport(client)
    }
    val bitmaps = decodeRequestImages(prompt.images)
    val ownership = RequestImages(bitmaps)
    try {
      val user = Content.Builder().setRole(Content.Role.USER).text(prompt.text).apply {
        prompt.imageSections().zip(bitmaps).forEach { (section, bitmap) ->
          addPart(TextPart(section.labelText))
          addPart(ImagePart(bitmap))
        }
      }.build()
      val exchange = mutableListOf(user)
      val transcript = mutableListOf<TranscriptTurn>(prompt.transcriptTurn())
      val budget = ToolBudget()
      var accumulated = ""
      while (true) {
        val request = GenerateContentRequest.Builder(previous + exchange).apply {
          temperature = this@LLMSession.temperature
          maxOutputTokens = maxTokens
          topK = this@LLMSession.topK
          setTools(registered.values.map { it.declaration })
        }.build()
        synchronized(stateLock) {
          if (!isCurrentLocked(generation)) throw CancellationException("Generation cancelled")
          ownership.handOffToSDK()
        }
        val response = if (generation.kind == GenerationKind.STREAM) {
          val callback = ToolStreamingCallback { text ->
            synchronized(stateLock) {
              if (!isCurrentLocked(generation)) return@ToolStreamingCallback
              accumulated += text
              onAccumulated(accumulated)
              emit("token", mapOf("token" to text, "accumulated" to accumulated, "requestId" to generation.requestId))
            }
          }
          try { client.generateContent(request, callback) }
          finally { callback.close() }
        } else client.generateContent(request)
        synchronized(stateLock) {
          if (!isCurrentLocked(generation)) throw CancellationException("Generation cancelled")
        }
        val candidate = response.candidates.firstOrNull() ?: throw ToolFailedException("Missing model candidate")
        val calls = budget.validateBatch(candidate.functionCalls, registered, candidate.finishReason)
        if (generation.kind == GenerationKind.RESPOND) accumulated += candidate.text
        val modelTurn = TranscriptTurn.Model(candidate.text, calls.map { it.call })
        exchange.add(modelTurn.content())
        transcript.add(modelTurn)
        if (calls.isEmpty()) {
          synchronized(stateLock) {
            if (!isCurrentLocked(generation)) throw CancellationException("Generation cancelled")
            generation.exchange = transcript
          }
          return accumulated
        }
        val resultTurn = serviceToolBatch(calls, generation.pending, toolTimeoutMillis) { id, validated ->
          synchronized(stateLock) {
            if (!isCurrentLocked(generation)) throw CancellationException("Generation cancelled")
            emit("toolCall", mapOf(
              "callId" to id,
              "toolName" to validated.call.name,
              "arguments" to validated.arguments,
              "requestId" to generation.requestId
            ))
          }
        }
        transcript.add(resultTurn)
        exchange.add(resultTurn.content())
      }
    } finally { ownership.recycleIfUnsubmitted() }
  }

  fun registerTool(config: ToolConfig) {
    val tool = NativeTool(config)
    changeTools { tools = tools + (tool.name to tool) }
  }

  fun unregisterTool(name: String) { changeTools { tools = tools - name } }

  private fun changeTools(change: () -> Unit) {
    val (job, oldModel) = synchronized(stateLock) {
      if (disposed) return
      change()
      val generation = activeGeneration
      generation?.let(lifecycle::invalidate)
      if (generation == null) {
        null to model.also { model = null }
      } else {
        modelResetPending = true
        generation.job to null
      }
    }
    job?.cancel()
    oldModel?.close()
  }

  fun resolveToolCall(callId: String, result: String) = synchronized(stateLock) {
    val generation = activeGeneration
    if (generation == null || !isCurrentLocked(generation) || !generation.pending.resolve(callId, result)) {
      throw ToolNotFoundException(callId)
    }
  }

  fun rejectToolCall(callId: String, error: String) = synchronized(stateLock) {
    val generation = activeGeneration
    if (generation == null || !isCurrentLocked(generation) || !generation.pending.reject(callId, error)) {
      throw ToolNotFoundException(callId)
    }
  }

  fun cancelStream() { lifecycle.cancelStream()?.cancel() }

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
      generation?.let(lifecycle::invalidate)
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
        lifecycle.release()
        val generation = activeGeneration
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
  bitmaps: List<Bitmap>
) {
  private val images = RequestImages(bitmaps)

  fun handOffToSDK(): GenerateContentRequest {
    images.handOffToSDK()
    return request
  }

  fun recycleIfUnsubmitted() = images.recycleIfUnsubmitted()
}

internal fun buildGenerateContentRequest(
  text: String,
  images: List<Pair<ImagePromptSection, Bitmap>>,
  temperature: Float?,
  maxTokens: Int?,
  topK: Int?
): GenerateContentRequest {
  val content = Content.Builder().addPart(TextPart(text)).apply {
    images.forEach { (section, bitmap) ->
      addPart(TextPart(section.labelText))
      addPart(ImagePart(bitmap))
    }
  }.build()
  val builder = GenerateContentRequest.Builder(content)
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
    prompt.images.isNotEmpty() &&
    error is GenAiException &&
    error.errorCode == GenAiException.ErrorCode.INVALID_INPUT_IMAGE
  ) {
    val labels = prompt.images.joinToString { image -> "\"${image.label}\"" }
    val imageDescription = if (prompt.images.size == 1) "image $labels" else "images $labels"
    return ImageInvalidException(
      "The on-device model rejected $imageDescription; try smaller or different images",
      error
    )
  }
  return generationException(error)
}
