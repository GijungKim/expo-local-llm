import FoundationModels

@available(iOS 26, *)
enum FoundationModelBridge {
  static func checkAvailability() -> ModelAvailability {
    let availability = SystemLanguageModel.default.availability
    switch availability {
    case .available:
      return .available
    case .unavailable(let reason):
      switch reason {
      case .deviceNotEligible:
        return .notEligible
      case .modelNotReady:
        return .notReady
      case .appleIntelligenceNotEnabled:
        return .notEnabled
      @unknown default:
        return .unknown
      }
    @unknown default:
      return .unknown
    }
  }

  static func createSession(instructions: String?) -> LanguageModelSession {
    if let instructions {
      return LanguageModelSession(instructions: instructions)
    }
    return LanguageModelSession()
  }

  static func respond(session: Any, prompt: String) async throws -> String {
    guard let session = session as? LanguageModelSession else {
      throw SessionInvalidException()
    }
    let response = try await session.respond(to: prompt)
    return response.content
  }

  static func stream(session: Any, prompt: String) -> AsyncThrowingStream<String, Error> {
    guard let session = session as? LanguageModelSession else {
      return AsyncThrowingStream { $0.finish(throwing: SessionInvalidException()) }
    }
    return AsyncThrowingStream { continuation in
      Task {
        do {
          let stream = session.streamResponse(to: prompt)
          for try await partial in stream {
            continuation.yield(partial.content)
          }
          continuation.finish()
        } catch {
          continuation.finish(throwing: error)
        }
      }
    }
  }
}
