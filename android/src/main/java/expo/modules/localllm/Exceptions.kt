package expo.modules.localllm

import expo.modules.kotlin.exception.CodedException

class NotSupportedException :
  CodedException("ERR_NOT_SUPPORTED", "On-device LLM is not available on this device", null)

class SessionInvalidException :
  CodedException("ERR_SESSION_INVALID", "LLM session is invalid or has been destroyed", null)

/** A generation failure, carrying one of the stable codes from [LocalLLMErrorCode]. */
class GenerationException(code: LocalLLMErrorCode, message: String, cause: Throwable?) :
  CodedException(code.value, message, cause)

class ModelDownloadException(message: String) :
  CodedException("ERR_MODEL_DOWNLOAD_FAILED", message, null)

class SessionBusyException :
  CodedException("ERR_SESSION_BUSY", "This LLM session already has a generation in progress", null)

class ResponseFormatNotSupportedException :
  CodedException(
    "ERR_RESPONSE_FORMAT_NOT_SUPPORTED",
    "Structured JSON output is not supported on Android yet",
    null
  )

class ToolNotSupportedException :
  CodedException("ERR_TOOL_NOT_SUPPORTED", "Tool calling is not supported on Android yet", null)
