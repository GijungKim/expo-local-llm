import ExpoModulesCore
import Foundation

class LLMSession: SharedObject {
  private var nativeSession: Any?
  private var streamTask: Task<Void, Never>?

  static func checkAvailability() -> ModelAvailability {
    guard #available(iOS 26, *) else {
      return .notEligible
    }
    return FoundationModelBridge.checkAvailability()
  }

  func setup(config: SessionConfig) throws {
    guard #available(iOS 26, *) else {
      throw NotSupportedException()
    }
    nativeSession = FoundationModelBridge.createSession(instructions: config.instructions)
  }

  func respond(to prompt: String) async throws -> String {
    guard #available(iOS 26, *), let session = nativeSession else {
      throw NotSupportedException()
    }
    return try await FoundationModelBridge.respond(session: session, prompt: prompt)
  }

  func startStream(prompt: String) throws {
    guard #available(iOS 26, *), let session = nativeSession else {
      throw NotSupportedException()
    }

    streamTask?.cancel()

    let weakSelf = self
    streamTask = Task {
      var lastContent = ""
      do {
        let stream = FoundationModelBridge.stream(session: session, prompt: prompt)
        for try await content in stream {
          // content is already the full accumulated text from Foundation Models
          let newToken = String(content.dropFirst(lastContent.count))
          lastContent = content
          weakSelf.emit(event: "token", arguments: [
            "token": newToken,
            "accumulated": content
          ])
        }
        weakSelf.emit(event: "streamComplete", arguments: [
          "text": lastContent
        ])
      } catch {
        if Task.isCancelled { return }
        weakSelf.emit(event: "streamError", arguments: [
          "error": error.localizedDescription
        ])
      }
    }
  }

  func cancelStream() {
    streamTask?.cancel()
    streamTask = nil
  }

  deinit {
    streamTask?.cancel()
  }
}
