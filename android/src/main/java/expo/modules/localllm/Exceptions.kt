package expo.modules.localllm

import expo.modules.kotlin.exception.CodedException

class NotSupportedException :
  CodedException("ERR_NOT_SUPPORTED", "On-device LLM is not available on this device", null)

class SessionInvalidException :
  CodedException("ERR_SESSION_INVALID", "LLM session is invalid or has been destroyed", null)

class StreamException(message: String) :
  CodedException("ERR_STREAM", message, null)

class ToolNotSupportedException :
  CodedException("ERR_TOOL_NOT_SUPPORTED", "Tool calling is not supported on Android yet", null)
