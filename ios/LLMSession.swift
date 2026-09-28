import ExpoModulesCore
import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

/// Result of a finished generation task. A cancelled stream returns the
/// partial content collected before cancellation and emits no completion.
private struct GenerationOutcome {
  let text: String
  let cancelled: Bool
}

private enum GenerationKind {
  case respond
  case stream
}

private enum PendingRebuild {
  case preserve(Any?)
  case reset
}

private final class ActiveGeneration {
  let kind: GenerationKind
  let sessionEpoch: UInt64
  let requestId: String
  let baselineTranscript: Any?
  var acceptsOutput = true
  var completed = false
  var task: Task<GenerationOutcome, Error>?

  init(
    kind: GenerationKind,
    sessionEpoch: UInt64,
    requestId: String,
    baselineTranscript: Any?
  ) {
    self.kind = kind
    self.sessionEpoch = sessionEpoch
    self.requestId = requestId
    self.baselineTranscript = baselineTranscript
  }
}

class LLMSession: SharedObject {
  private let stateLock = NSLock()
  private var nativeSession: Any?
  private var activeGeneration: ActiveGeneration?
  private var sessionEpoch: UInt64 = 0
  private var pendingRebuild: PendingRebuild?
  private var disposed = false
  private var registeredTools: [String: Any] = [:]  // name -> DynamicTool (type-erased)
  private var continuationStore: Any?  // ToolContinuationStore (type-erased for availability)
  private var toolConfigs: [ToolConfig] = []
  private var sessionInstructions: String?
  private var toolTimeout: TimeInterval = 30
  private var generationSchema: Any?  // GenerationSchema (type-erased for availability)
  private var includeSchemaInPrompt: Bool = true
  private var temperature: Double?
  private var maxTokens: Int?
  private var topK: Int?

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

    let instructions = config.instructions ?? ""
    sessionInstructions = instructions.isEmpty ? nil : instructions
    toolTimeout = config.toolTimeout ?? 30
    includeSchemaInPrompt = config.includeSchemaInPrompt ?? true
    temperature = config.options?.temperature
    maxTokens = config.options?.maxTokens
    topK = config.options?.topK

    if config.responseFormat == "json", let schemaDict = config.schema {
      generationSchema = try GenerationSchemaBuilder.build(properties: schemaDict)
    }

    toolConfigs = config.tools ?? []
    stateLock.lock()
    rebuildSessionLocked()
    stateLock.unlock()
  }

  /// Clear the conversation transcript (keeps instructions, tools, schema,
  /// and generation options). Any old producer is invalidated before the new
  /// native session becomes visible, so it cannot emit into the reset session.
  func reset() throws {
    guard #available(iOS 26, *) else {
      throw NotSupportedException()
    }

    stateLock.lock()
    guard !disposed else {
      stateLock.unlock()
      throw SessionInvalidException()
    }
    let task = invalidateForRebuildLocked(preservingTranscript: false)
    stateLock.unlock()
    task?.cancel()
  }

  // MARK: - Tool Management

  func registerTool(config: ToolConfig) {
    guard #available(iOS 26, *) else { return }

    stateLock.lock()
    guard !disposed else {
      stateLock.unlock()
      return
    }
    toolConfigs.removeAll { $0.name == config.name }
    toolConfigs.append(config)
    let task = invalidateForRebuildLocked(preservingTranscript: true)
    stateLock.unlock()
    task?.cancel()
  }

  func unregisterTool(name: String) {
    guard #available(iOS 26, *) else { return }

    stateLock.lock()
    guard !disposed else {
      stateLock.unlock()
      return
    }
    toolConfigs.removeAll { $0.name == name }
    let task = invalidateForRebuildLocked(preservingTranscript: true)
    stateLock.unlock()
    task?.cancel()
  }

  func resolveToolCall(callId: String, result: String) throws {
    guard #available(iOS 26, *) else {
      throw NotSupportedException()
    }
    stateLock.lock()
    let store = continuationStore as? ToolContinuationStore
    stateLock.unlock()
    guard let store, store.resolve(callId: callId, result: result) else {
      throw ToolNotFoundException(callId)
    }
  }

  func rejectToolCall(callId: String, error: String) throws {
    guard #available(iOS 26, *) else {
      throw NotSupportedException()
    }
    stateLock.lock()
    let store = continuationStore as? ToolContinuationStore
    stateLock.unlock()
    guard let store,
          store.reject(callId: callId, error: DynamicToolError.handlerFailed(error)) else {
      throw ToolNotFoundException(callId)
    }
  }

  // MARK: - Session Rebuild

  @available(iOS 26, *)
  private func rebuildSessionLocked(transcript: Any? = nil) {
    (continuationStore as? ToolContinuationStore)?.close()

    let store = ToolContinuationStore()
    continuationStore = store
    sessionEpoch &+= 1
    let toolEpoch = sessionEpoch
    var dynamicTools: [DynamicTool] = []
    registeredTools.removeAll()

    for config in toolConfigs {
      let tool = DynamicTool(
        name: config.name,
        description: config.description,
        parameterSchema: config.parameters,
        timeoutSeconds: toolTimeout,
        continuationStore: store
      ) { [weak self] callId, toolName, argumentsJSON in
        self?.emitToolCall(
          callId: callId,
          toolName: toolName,
          argumentsJSON: argumentsJSON,
          sessionEpoch: toolEpoch
        ) ?? false
      }
      registeredTools[config.name] = tool
      dynamicTools.append(tool)
    }

    nativeSession = FoundationModelBridge.createSession(
      instructions: sessionInstructions,
      dynamicTools: dynamicTools,
      transcript: transcript
    )
  }

  private func emitToolCall(
    callId: String,
    toolName: String,
    argumentsJSON: String,
    sessionEpoch: UInt64
  ) -> Bool {
    var arguments: [String: Any] = [:]
    if let data = argumentsJSON.data(using: .utf8),
       let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
      arguments = parsed
    }

    stateLock.lock()
    guard let activeGeneration,
          activeGeneration.acceptsOutput,
          activeGeneration.sessionEpoch == sessionEpoch else {
      stateLock.unlock()
      return false
    }
    // Capture the invoking generation's identity now. Once queued, JS filters
    // this immutable value rather than relying on later native state checks.
    let requestId = activeGeneration.requestId
    stateLock.unlock()
    emit(event: "toolCall", payload: [
      "callId": callId,
      "toolName": toolName,
      "arguments": arguments,
      "requestId": requestId,
    ])
    return true
  }

  // MARK: - Generation State

  @available(iOS 26, *)
  private func beginGeneration(
    kind: GenerationKind,
    requestId: String?
  ) throws -> (
    generation: ActiveGeneration,
    session: Any,
    schema: GenerationSchema?,
    includeSchemaInPrompt: Bool,
    options: FoundationModels.GenerationOptions
  ) {
    stateLock.lock()
    defer { stateLock.unlock() }

    guard !disposed, nativeSession != nil else {
      throw SessionInvalidException()
    }
    guard activeGeneration == nil else {
      throw SessionBusyException()
    }
    let nativeSession = nativeSession!

    let generation = ActiveGeneration(
      kind: kind,
      sessionEpoch: sessionEpoch,
      requestId: requestId ?? UUID().uuidString,
      baselineTranscript: FoundationModelBridge.transcript(from: nativeSession)
    )
    activeGeneration = generation
    let options = FoundationModelBridge.makeOptions(
      temperature: temperature,
      maxTokens: maxTokens,
      topK: topK
    )
    return (
      generation,
      nativeSession,
      generationSchema as? GenerationSchema,
      includeSchemaInPrompt,
      options
    )
  }

  private func attach(task: Task<GenerationOutcome, Error>, to generation: ActiveGeneration) {
    stateLock.lock()
    generation.task = task
    let shouldCancel = activeGeneration !== generation || !generation.acceptsOutput
    stateLock.unlock()
    if shouldCancel {
      task.cancel()
    }
  }

  private func invalidateActiveGenerationLocked(
    clearSlot: Bool
  ) -> Task<GenerationOutcome, Error>? {
    let generation = activeGeneration
    generation?.acceptsOutput = false
    if clearSlot {
      activeGeneration = nil
    }
    return generation?.task
  }

  @available(iOS 26, *)
  private func invalidateForRebuildLocked(
    preservingTranscript: Bool
  ) -> Task<GenerationOutcome, Error>? {
    let generation = activeGeneration
    generation?.acceptsOutput = false
    if generation != nil {
      // A producer may be suspended inside a native tool call. Close the old
      // store now so teardown never waits for the JavaScript timeout.
      (continuationStore as? ToolContinuationStore)?.close()
    }
    let transcript: Any?
    if generation?.completed == true {
      transcript = FoundationModelBridge.transcript(from: nativeSession)
    } else {
      transcript = generation?.baselineTranscript ?? FoundationModelBridge.transcript(from: nativeSession)
    }
    let requestedRebuild: PendingRebuild = preservingTranscript ? .preserve(transcript) : .reset
    if generation == nil {
      rebuildSessionLocked(transcript: preservingTranscript ? transcript : nil)
      pendingRebuild = nil
    } else {
      // The old LanguageModelSession remains isolated until its producer has
      // fully stopped. The busy slot prevents a new turn from reusing it.
      if case .reset = pendingRebuild {
        // Reset has stronger semantics than a later tool update/cancellation.
      } else {
        pendingRebuild = requestedRebuild
      }
    }
    return generation?.task
  }

  private func cancel(generation: ActiveGeneration) {
    stateLock.lock()
    let task: Task<GenerationOutcome, Error>?
    if activeGeneration === generation, !generation.completed {
      generation.acceptsOutput = false
      if #available(iOS 26, *) {
        (continuationStore as? ToolContinuationStore)?.close()
        // Foundation Models owns its transcript. Replace the native session
        // only after its current producer has fully torn down.
        if case .reset = pendingRebuild {
          // Preserve reset's explicit history-clearing semantics.
        } else {
          pendingRebuild = .preserve(generation.baselineTranscript)
        }
      }
      task = generation.task
    } else {
      // A completed stream has already committed its transcript. A late
      // caller cancellation must not roll that completed turn back.
      task = nil
    }
    stateLock.unlock()
    task?.cancel()
  }

  private func finish(generation: ActiveGeneration) {
    stateLock.lock()
    if activeGeneration === generation {
      activeGeneration = nil
      if !disposed, let pendingRebuild, #available(iOS 26, *) {
        switch pendingRebuild {
        case .preserve(let transcript):
          rebuildSessionLocked(transcript: transcript)
        case .reset:
          rebuildSessionLocked()
        }
      }
      pendingRebuild = nil
    }
    stateLock.unlock()
  }

  private func isActive(generation: ActiveGeneration) -> Bool {
    stateLock.lock()
    let result = activeGeneration === generation && generation.acceptsOutput
    stateLock.unlock()
    return result
  }

  private func markCompletedIfActive(generation: ActiveGeneration) -> Bool {
    stateLock.lock()
    guard activeGeneration === generation, generation.acceptsOutput else {
      stateLock.unlock()
      return false
    }
    generation.completed = true
    stateLock.unlock()
    return true
  }

  private func emitIfActive(
    generation: ActiveGeneration,
    event: String,
    arguments: [String: Any]
  ) -> Bool {
    stateLock.lock()
    guard activeGeneration === generation, generation.acceptsOutput else {
      stateLock.unlock()
      return false
    }
    var payload = arguments
    payload["requestId"] = generation.requestId
    stateLock.unlock()
    emit(event: event, payload: payload)
    return true
  }

  // MARK: - Generation

  func respond(to prompt: String, requestId: String? = nil) async throws -> String {
    guard #available(iOS 26, *) else {
      throw NotSupportedException()
    }
    let context = try beginGeneration(kind: .respond, requestId: requestId)
    let task = Task { [weak self] () throws -> GenerationOutcome in
      guard let self, self.isActive(generation: context.generation), !Task.isCancelled else {
        throw CancellationError()
      }
      let text: String
      if let schema = context.schema {
        text = try await FoundationModelBridge.respond(
          session: context.session,
          prompt: prompt,
          schema: schema,
          includeSchemaInPrompt: context.includeSchemaInPrompt,
          options: context.options
        )
      } else {
        text = try await FoundationModelBridge.respond(
          session: context.session,
          prompt: prompt,
          options: context.options
        )
      }
      guard self.isActive(generation: context.generation), !Task.isCancelled else {
        throw CancellationError()
      }
      return GenerationOutcome(text: text, cancelled: false)
    }
    attach(task: task, to: context.generation)
    defer {
      task.cancel()
      finish(generation: context.generation)
    }

    return try await withTaskCancellationHandler {
      (try await task.value).text
    } onCancel: { [weak self] in
      self?.cancel(generation: context.generation)
    }
  }

  /// Stream a response, emitting `token`/`partial` events along the way.
  /// Cancellation resolves with the partial text and emits no completion.
  func streamResponse(prompt: String, requestId: String? = nil) async throws -> String {
    guard #available(iOS 26, *) else {
      throw NotSupportedException()
    }
    let context = try beginGeneration(kind: .stream, requestId: requestId)
    let task: Task<GenerationOutcome, Error>
    if let schema = context.schema {
      task = makeSchemaStreamTask(
        generation: context.generation,
        session: context.session,
        prompt: prompt,
        schema: schema,
        includeSchemaInPrompt: context.includeSchemaInPrompt,
        options: context.options
      )
    } else {
      task = makeTextStreamTask(
        generation: context.generation,
        session: context.session,
        prompt: prompt,
        options: context.options
      )
    }
    attach(task: task, to: context.generation)
    defer {
      task.cancel()
      finish(generation: context.generation)
    }

    do {
      let outcome = try await withTaskCancellationHandler {
        try await task.value
      } onCancel: { [weak self] in
        self?.cancel(generation: context.generation)
      }
      if !outcome.cancelled, markCompletedIfActive(generation: context.generation) {
        _ = emitIfActive(
          generation: context.generation,
          event: "streamComplete",
          arguments: ["text": outcome.text]
        )
      }
      return outcome.text
    } catch {
      if (error is CancellationError || !isActive(generation: context.generation)),
         !Task.isCancelled {
        // Cancellation before the producer starts has no partial snapshot.
        return ""
      }
      if error is CancellationError || !isActive(generation: context.generation) {
        throw error
      }
      _ = emitIfActive(
        generation: context.generation,
        event: "streamError",
        arguments: ["error": error.localizedDescription]
      )
      throw StreamException(error.localizedDescription)
    }
  }

  @available(iOS 26, *)
  private func makeTextStreamTask(
    generation: ActiveGeneration,
    session: Any,
    prompt: String,
    options: FoundationModels.GenerationOptions
  ) -> Task<GenerationOutcome, Error> {
    Task { [weak self] in
      var lastContent = ""
      let handle = FoundationModelBridge.stream(
        session: session,
        prompt: prompt,
        options: options
      )
      do {
        for try await content in handle.stream {
          guard let self,
                !Task.isCancelled,
                self.isActive(generation: generation) else {
            await handle.cancelAndWaitForProducer()
            return GenerationOutcome(text: lastContent, cancelled: true)
          }
          let newToken = String(content.dropFirst(lastContent.count))
          lastContent = content
          guard self.emitIfActive(
            generation: generation,
            event: "token",
            arguments: ["token": newToken, "accumulated": content]
          ) else {
            await handle.cancelAndWaitForProducer()
            return GenerationOutcome(text: lastContent, cancelled: true)
          }
        }
        await handle.waitForProducer()
      } catch {
        await handle.cancelAndWaitForProducer()
        if Task.isCancelled || error is CancellationError || self?.isActive(generation: generation) != true {
          return GenerationOutcome(text: lastContent, cancelled: true)
        }
        throw error
      }
      return GenerationOutcome(
        text: lastContent,
        cancelled: Task.isCancelled || self?.isActive(generation: generation) != true
      )
    }
  }

  @available(iOS 26, *)
  private func makeSchemaStreamTask(
    generation: ActiveGeneration,
    session: Any,
    prompt: String,
    schema: GenerationSchema,
    includeSchemaInPrompt: Bool,
    options: FoundationModels.GenerationOptions
  ) -> Task<GenerationOutcome, Error> {
    Task { [weak self] in
      var lastJSON = ""
      let handle = FoundationModelBridge.stream(
        session: session,
        prompt: prompt,
        schema: schema,
        includeSchemaInPrompt: includeSchemaInPrompt,
        options: options
      )
      do {
        for try await snapshot in handle.stream {
          guard let self,
                !Task.isCancelled,
                self.isActive(generation: generation) else {
            await handle.cancelAndWaitForProducer()
            return GenerationOutcome(text: lastJSON, cancelled: true)
          }
          lastJSON = snapshot.json
          guard self.emitIfActive(
            generation: generation,
            event: "partial",
            arguments: ["json": snapshot.json, "complete": snapshot.complete]
          ) else {
            await handle.cancelAndWaitForProducer()
            return GenerationOutcome(text: lastJSON, cancelled: true)
          }
        }
        await handle.waitForProducer()
      } catch {
        await handle.cancelAndWaitForProducer()
        if Task.isCancelled || error is CancellationError || self?.isActive(generation: generation) != true {
          return GenerationOutcome(text: lastJSON, cancelled: true)
        }
        throw error
      }
      return GenerationOutcome(
        text: lastJSON,
        cancelled: Task.isCancelled || self?.isActive(generation: generation) != true
      )
    }
  }

  func cancelStream() {
    stateLock.lock()
    let generation = activeGeneration?.kind == .stream && activeGeneration?.completed == false
      ? activeGeneration
      : nil
    generation?.acceptsOutput = false
    if generation != nil, #available(iOS 26, *) {
      // Settle any tool invocation already waiting on JavaScript before
      // waiting for the model producer to observe cancellation.
      (continuationStore as? ToolContinuationStore)?.close()
      // Discard only the cancelled attempt after the old producer has torn
      // down; its pre-request transcript retains every completed prior turn.
      // The busy slot prevents the replacement session being used early.
      if case .reset = pendingRebuild {
        // An explicit reset must still clear all completed history.
      } else {
        pendingRebuild = .preserve(generation?.baselineTranscript)
      }
    }
    let task = generation?.task
    stateLock.unlock()
    task?.cancel()
  }

  @available(iOS 26, *)
  private func cancelPendingToolCalls(in store: Any?) {
    (store as? ToolContinuationStore)?.close()
  }

  private func dispose() {
    stateLock.lock()
    guard !disposed else {
      stateLock.unlock()
      return
    }
    disposed = true
    pendingRebuild = nil
    let task = invalidateActiveGenerationLocked(clearSlot: true)
    let store = continuationStore
    continuationStore = nil
    nativeSession = nil
    registeredTools.removeAll()
    stateLock.unlock()

    task?.cancel()
    if #available(iOS 26, *) {
      cancelPendingToolCalls(in: store)
    }
  }

  override func sharedObjectDidRelease() {
    dispose()
    super.sharedObjectDidRelease()
  }

  deinit {
    dispose()
  }
}
