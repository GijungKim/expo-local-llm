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
    "Android cannot compile runtime JS schemas into the Kotlin types required by ML Kit structured output",
    null
  )

class ToolNotSupportedException(message: String = "The selected Android model does not support native function calling") :
  CodedException("ERR_TOOL_NOT_SUPPORTED", message, null)

class ImageInvalidException(message: String, cause: Throwable? = null) :
  CodedException("ERR_IMAGE_INVALID", message, cause)

class ToolFailedException(message: String) :
  CodedException("ERR_TOOL_FAILED", message, null)

class ToolInvalidException(message: String) :
  CodedException("ERR_SCHEMA_INVALID", message, null)

class ToolNotFoundException(callId: String) :
  CodedException("ERR_TOOL_FAILED", "No pending tool call: $callId", null)
