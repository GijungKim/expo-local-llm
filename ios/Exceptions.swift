import ExpoModulesCore

class NotSupportedException: Exception {
  override var reason: String {
    "Foundation Models requires iOS 26 or later"
  }
}

class SessionInvalidException: Exception {
  override var reason: String {
    "LLM session is invalid or has been destroyed"
  }
}

class StreamException: GenericException<String> {
  override var reason: String {
    "Stream error: \(param ?? "Unknown")"
  }
}

class ToolTimeoutException: Exception {
  override var reason: String {
    "Tool call timed out waiting for JavaScript response"
  }
}

class ToolCallException: GenericException<String> {
  override var reason: String {
    "Tool call error: \(param ?? "Unknown")"
  }
}

class ToolNotFoundException: GenericException<String> {
  override var reason: String {
    "No pending tool call found with ID: \(param ?? "Unknown")"
  }
}

class ToolNotSupportedException: Exception {
  override var reason: String {
    "Tool calling is not supported on this platform"
  }
}
