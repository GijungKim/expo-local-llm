import ExpoModulesCore

// Expo's `Exception` and `GenericException` are `@unchecked Sendable`.
// Swift requires subclasses to restate that conformance.
class NotSupportedException: Exception, @unchecked Sendable {
  override var reason: String {
    "Foundation Models requires iOS 26 or later"
  }
}

class ImageNotSupportedException: Exception, @unchecked Sendable {
  override var code: String {
    "ERR_IMAGE_NOT_SUPPORTED"
  }

  override var reason: String {
    "Image prompts require iOS 27 or later and a vision-capable Apple Foundation Model"
  }
}

class ImageInvalidException: GenericException<String>, @unchecked Sendable {
  override var code: String {
    "ERR_IMAGE_INVALID"
  }

  override var reason: String {
    param
  }
}

class SessionInvalidException: Exception, @unchecked Sendable {
  override var reason: String {
    "LLM session is invalid or has been destroyed"
  }
}

class SessionBusyException: Exception, @unchecked Sendable {
  override var code: String {
    "ERR_SESSION_BUSY"
  }

  override var reason: String {
    "This LLM session already has a generation in progress"
  }
}

class ToolTimeoutException: Exception, @unchecked Sendable {
  override var reason: String {
    "Tool call timed out waiting for JavaScript response"
  }
}

class ToolCallException: GenericException<String>, @unchecked Sendable {
  override var reason: String {
    "Tool call error: \(param)"
  }
}

class ToolNotFoundException: GenericException<String>, @unchecked Sendable {
  override var reason: String {
    "No pending tool call found with ID: \(param)"
  }
}

class ToolNotSupportedException: Exception, @unchecked Sendable {
  override var reason: String {
    "Tool calling is not supported on this platform"
  }
}
