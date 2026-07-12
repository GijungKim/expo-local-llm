import FoundationModels

@available(iOS 26, *)
enum FoundationModelBridge {
  static func checkAvailability() -> ModelAvailability {
    switch SystemLanguageModel.default.availability {
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

  static func createSession(instructions: String?, dynamicTools: [DynamicTool] = []) -> LanguageModelSession {
    let tools: [any Tool] = dynamicTools
    if tools.isEmpty {
      if let instructions {
        return LanguageModelSession(instructions: instructions)
      }
      return LanguageModelSession()
    } else {
      if let instructions {
        return LanguageModelSession(tools: tools, instructions: instructions)
      }
      return LanguageModelSession(tools: tools)
    }
  }

  /// Map the module's JS-facing generation options onto Apple's. `topK`
  /// selects top-K random sampling; all-nil values leave Apple defaults.
  static func makeOptions(temperature: Double?, maxTokens: Int?, topK: Int?) -> FoundationModels.GenerationOptions {
    var sampling: FoundationModels.GenerationOptions.SamplingMode?
    if let topK {
      sampling = .random(top: topK)
    }
    return FoundationModels.GenerationOptions(
      sampling: sampling,
      temperature: temperature,
      maximumResponseTokens: maxTokens
    )
  }

  static func respond(session: Any, prompt: String, options: FoundationModels.GenerationOptions) async throws -> String {
    guard let session = session as? LanguageModelSession else {
      throw SessionInvalidException()
    }
    let response = try await session.respond(to: prompt, options: options)
    return response.content
  }

  static func respond(
    session: Any,
    prompt: String,
    schema: GenerationSchema,
    includeSchemaInPrompt: Bool,
    options: FoundationModels.GenerationOptions
  ) async throws -> String {
    guard let session = session as? LanguageModelSession else {
      throw SessionInvalidException()
    }
    let response = try await session.respond(
      to: prompt,
      schema: schema,
      includeSchemaInPrompt: includeSchemaInPrompt,
      options: options
    )
    return response.content.jsonString
  }

  static func stream(session: Any, prompt: String, options: FoundationModels.GenerationOptions) -> AsyncThrowingStream<String, Error> {
    guard let session = session as? LanguageModelSession else {
      return AsyncThrowingStream { $0.finish(throwing: SessionInvalidException()) }
    }
    return AsyncThrowingStream { continuation in
      let task = Task {
        do {
          let stream = session.streamResponse(to: prompt, options: options)
          for try await partial in stream {
            continuation.yield(partial.content)
          }
          continuation.finish()
        } catch {
          continuation.finish(throwing: error)
        }
      }
      // Without this, cancelling the consumer leaves the producer running
      // the model to completion (battery/thermal cost, and the session
      // stays busy, rejecting the next prompt).
      continuation.onTermination = { _ in task.cancel() }
    }
  }

  struct PartialSnapshot {
    let json: String
    let complete: Bool
  }

  static func stream(
    session: Any,
    prompt: String,
    schema: GenerationSchema,
    includeSchemaInPrompt: Bool,
    options: FoundationModels.GenerationOptions
  ) -> AsyncThrowingStream<PartialSnapshot, Error> {
    guard let session = session as? LanguageModelSession else {
      return AsyncThrowingStream { $0.finish(throwing: SessionInvalidException()) }
    }
    return AsyncThrowingStream { continuation in
      let task = Task {
        do {
          let stream = session.streamResponse(
            to: prompt,
            schema: schema,
            includeSchemaInPrompt: includeSchemaInPrompt,
            options: options
          )
          for try await snapshot in stream {
            let content = snapshot.content
            continuation.yield(PartialSnapshot(json: content.jsonString, complete: content.isComplete))
          }
          continuation.finish()
        } catch {
          continuation.finish(throwing: error)
        }
      }
      continuation.onTermination = { _ in task.cancel() }
    }
  }
}
