package expo.modules.localllm

import com.google.mlkit.genai.common.GenAiException

/** Stable error codes shared with iOS and declared in TypeScript as `LocalLLMErrorCode`. */
enum class LocalLLMErrorCode(val value: String) {
  CONTEXT_WINDOW_EXCEEDED("ERR_CONTEXT_WINDOW_EXCEEDED"),
  RATE_LIMITED("ERR_RATE_LIMITED"),
  MODEL_UNAVAILABLE("ERR_MODEL_UNAVAILABLE"),
  GENERATION_FAILED("ERR_GENERATION_FAILED")
}

/** Classify an ML Kit failure so JavaScript can branch on a code rather than a message. */
fun generationErrorCode(error: Throwable): LocalLLMErrorCode {
  val genAiError = error as? GenAiException ?: return LocalLLMErrorCode.GENERATION_FAILED
  return when (genAiError.errorCode) {
    GenAiException.ErrorCode.REQUEST_TOO_LARGE -> LocalLLMErrorCode.CONTEXT_WINDOW_EXCEEDED
    GenAiException.ErrorCode.BUSY,
    GenAiException.ErrorCode.PER_APP_BATTERY_USE_QUOTA_EXCEEDED,
    GenAiException.ErrorCode.BACKGROUND_USE_BLOCKED -> LocalLLMErrorCode.RATE_LIMITED
    GenAiException.ErrorCode.NOT_AVAILABLE,
    GenAiException.ErrorCode.AICORE_INCOMPATIBLE,
    GenAiException.ErrorCode.NEEDS_SYSTEM_UPDATE,
    GenAiException.ErrorCode.NOT_ENOUGH_DISK_SPACE -> LocalLLMErrorCode.MODEL_UNAVAILABLE
    else -> LocalLLMErrorCode.GENERATION_FAILED
  }
}

fun generationException(error: Throwable): GenerationException =
  GenerationException(generationErrorCode(error), error.message ?: "Generation failed", error)
