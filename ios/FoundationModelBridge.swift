import FoundationModels

@available(iOS 26, *)
enum FoundationModelBridge {
  struct StreamHandle<Element> {
    let stream: AsyncThrowingStream<Element, Error>
    private let producer: Task<Void, Never>

    init(
      stream: AsyncThrowingStream<Element, Error>,
      producer: Task<Void, Never>
    ) {
      self.stream = stream
      self.producer = producer
    }

    func waitForProducer() async {
      await producer.value
    }

    func cancelAndWaitForProducer() async {
      producer.cancel()
      await producer.value
    }
  }

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

  static func createSession(
    instructions: String?,
    dynamicTools: [DynamicTool] = [],
    transcript: Any? = nil
  ) -> LanguageModelSession {
    let tools: [any Tool] = dynamicTools
    if let transcript = transcript as? Transcript {
      // The transcript already contains the original instructions and all
      // completed turns. This initializer restores exactly that state.
      return LanguageModelSession(tools: tools, transcript: transcript)
    }
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

  static func transcript(from session: Any?) -> Any? {
    (session as? LanguageModelSession)?.transcript
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

  static func stream(
    session: Any,
    prompt: String,
    options: FoundationModels.GenerationOptions
  ) -> StreamHandle<String> {
    guard let session = session as? LanguageModelSession else {
      return finishedStream(throwing: SessionInvalidException())
    }

    let (stream, continuation) = AsyncThrowingStream<String, Error>.makeStream()
    let producer = Task {
      do {
        let responseStream = session.streamResponse(to: prompt, options: options)
        for try await partial in responseStream {
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
    continuation.onTermination = { _ in producer.cancel() }
    return StreamHandle(stream: stream, producer: producer)
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
  ) -> StreamHandle<PartialSnapshot> {
    guard let session = session as? LanguageModelSession else {
      return finishedStream(throwing: SessionInvalidException())
    }

    let (stream, continuation) = AsyncThrowingStream<PartialSnapshot, Error>.makeStream()
    let producer = Task {
      do {
        let responseStream = session.streamResponse(
          to: prompt,
          schema: schema,
          includeSchemaInPrompt: includeSchemaInPrompt,
          options: options
        )
        for try await snapshot in responseStream {
          let content = snapshot.content
          continuation.yield(PartialSnapshot(json: content.jsonString, complete: content.isComplete))
        }
        continuation.finish()
      } catch {
        continuation.finish(throwing: error)
      }
    }
    continuation.onTermination = { _ in producer.cancel() }
    return StreamHandle(stream: stream, producer: producer)
  }

  private static func finishedStream<Element>(
    throwing error: Error
  ) -> StreamHandle<Element> {
    let producer = Task<Void, Never> {}
    let stream = AsyncThrowingStream<Element, Error> { continuation in
      continuation.finish(throwing: error)
    }
    return StreamHandle(stream: stream, producer: producer)
  }
}
