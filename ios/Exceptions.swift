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
