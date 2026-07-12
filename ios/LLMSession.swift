import ExpoModulesCore
import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

/// Result of a finished stream task: the final text plus whether the stream
/// ended because the user cancelled it (partial text, no `streamComplete`).
private struct StreamOutcome {
  let text: String
  let cancelled: Bool
}

class LLMSession: SharedObject {
  private var nativeSession: Any?
  private var streamTask: Task<StreamOutcome, Error>?
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

    // Build a constrained-decoding schema if structured output is requested.
    if config.responseFormat == "json", let schemaDict = config.schema {
      generationSchema = try GenerationSchemaBuilder.build(properties: schemaDict)
    }

    if let tools = config.tools, !tools.isEmpty {
      toolConfigs = tools
      let store = ToolContinuationStore()
      continuationStore = store
      rebuildTools(store: store)
    } else {
      nativeSession = FoundationModelBridge.createSession(instructions: sessionInstructions)
    }
  }

  /// Clear the conversation transcript (keeps instructions, tools, schema,
  /// and generation options). Cancels any in-flight stream and pending tool
  /// calls — the model weights are OS-shared, so this is cheap.
  func reset() throws {
    guard #available(iOS 26, *) else {
      throw NotSupportedException()
    }
    streamTask?.cancel()
    streamTask = nil
    if let store = continuationStore as? ToolContinuationStore, !toolConfigs.isEmpty {
      rebuildTools(store: store)
    } else {
      nativeSession = FoundationModelBridge.createSession(instructions: sessionInstructions)
    }
  }

  // MARK: - Tool Management

  func registerTool(config: ToolConfig) {
    guard #available(iOS 26, *) else { return }

    toolConfigs.removeAll { $0.name == config.name }
    toolConfigs.append(config)

    let store: ToolContinuationStore
    if let existing = continuationStore as? ToolContinuationStore {
      store = existing
    } else {
      store = ToolContinuationStore()
      continuationStore = store
    }

    rebuildTools(store: store)
  }

  func unregisterTool(name: String) {
    guard #available(iOS 26, *) else { return }

    toolConfigs.removeAll { $0.name == name }
    registeredTools.removeValue(forKey: name)

    if let store = continuationStore as? ToolContinuationStore {
      rebuildTools(store: store)
    }
  }

  func resolveToolCall(callId: String, result: String) throws {
    guard #available(iOS 26, *) else {
      throw NotSupportedException()
    }
    guard let store = continuationStore as? ToolContinuationStore else {
      throw ToolNotFoundException(callId)
    }
    if !store.resolve(callId: callId, result: result) {
      throw ToolNotFoundException(callId)
    }
  }

  func rejectToolCall(callId: String, error: String) throws {
    guard #available(iOS 26, *) else {
      throw NotSupportedException()
    }
    guard let store = continuationStore as? ToolContinuationStore else {
      throw ToolNotFoundException(callId)
    }
    if !store.reject(callId: callId, error: DynamicToolError.handlerFailed(error)) {
      throw ToolNotFoundException(callId)
    }
  }

  // MARK: - Session Rebuild

  @available(iOS 26, *)
  private func rebuildTools(store: ToolContinuationStore) {
    // Cancel any pending tool calls from the old session
    store.cancelAll()

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
        guard let self else { return }
        // Parse the JSON string into a dictionary for the JS event
        var args: [String: Any] = [:]
        if let data = argumentsJSON.data(using: .utf8),
           let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
          args = parsed
        }
        self.emit(event: "toolCall", arguments: [
          "callId": callId,
          "toolName": toolName,
          "arguments": args,
        ])
      }
      registeredTools[config.name] = tool
      dynamicTools.append(tool)
    }

    nativeSession = FoundationModelBridge.createSession(
      instructions: sessionInstructions,
      dynamicTools: dynamicTools
    )
  }

  // MARK: - Generation

  @available(iOS 26, *)
  private func makeOptions() -> FoundationModels.GenerationOptions {
    FoundationModelBridge.makeOptions(temperature: temperature, maxTokens: maxTokens, topK: topK)
  }

  func respond(to prompt: String) async throws -> String {
    guard #available(iOS 26, *), let session = nativeSession else {
      throw NotSupportedException()
    }
    let options = makeOptions()
    if let schema = generationSchema as? GenerationSchema {
      return try await FoundationModelBridge.respond(
        session: session,
        prompt: prompt,
        schema: schema,
        includeSchemaInPrompt: includeSchemaInPrompt,
        options: options
      )
    }
    return try await FoundationModelBridge.respond(session: session, prompt: prompt, options: options)
  }

  /// Stream a response, emitting `token`/`partial` events along the way.
  /// Resolves with the final text when the stream completes, or with the
  /// partial text produced so far if the stream is cancelled. Emits
  /// `streamComplete` only on natural completion, `streamError` on failure.
  func streamResponse(prompt: String) async throws -> String {
    guard #available(iOS 26, *), let session = nativeSession else {
      throw NotSupportedException()
    }

    streamTask?.cancel()

    let task: Task<StreamOutcome, Error>
    if let schema = generationSchema as? GenerationSchema {
      task = makeSchemaStreamTask(session: session, prompt: prompt, schema: schema)
    } else {
      task = makeTextStreamTask(session: session, prompt: prompt)
    }
    streamTask = task

    do {
      let outcome = try await task.value
      if !outcome.cancelled {
        emit(event: "streamComplete", arguments: [
          "text": outcome.text
        ])
      }
      return outcome.text
    } catch {
      emit(event: "streamError", arguments: [
        "error": error.localizedDescription
      ])
      throw StreamException(error.localizedDescription)
    }
  }

  @available(iOS 26, *)
  private func makeTextStreamTask(session: Any, prompt: String) -> Task<StreamOutcome, Error> {
    let options = makeOptions()
    return Task {
      var lastContent = ""
      do {
        let stream = FoundationModelBridge.stream(session: session, prompt: prompt, options: options)
        for try await content in stream {
          let newToken = String(content.dropFirst(lastContent.count))
          lastContent = content
          self.emit(event: "token", arguments: [
            "token": newToken,
            "accumulated": content
          ])
        }
      } catch {
        if Task.isCancelled || error is CancellationError {
          return StreamOutcome(text: lastContent, cancelled: true)
        }
        throw error
      }
      return StreamOutcome(text: lastContent, cancelled: Task.isCancelled)
    }
  }

  @available(iOS 26, *)
  private func makeSchemaStreamTask(session: Any, prompt: String, schema: GenerationSchema) -> Task<StreamOutcome, Error> {
    let useIncludeSchemaInPrompt = includeSchemaInPrompt
    let options = makeOptions()
    return Task {
      var lastJSON = ""
      do {
        let stream = FoundationModelBridge.stream(
          session: session,
          prompt: prompt,
          schema: schema,
          includeSchemaInPrompt: useIncludeSchemaInPrompt,
          options: options
        )
        for try await snapshot in stream {
          lastJSON = snapshot.json
          self.emit(event: "partial", arguments: [
            "json": snapshot.json,
            "complete": snapshot.complete,
          ])
        }
      } catch {
        if Task.isCancelled || error is CancellationError {
          return StreamOutcome(text: lastJSON, cancelled: true)
        }
        throw error
      }
      return StreamOutcome(text: lastJSON, cancelled: Task.isCancelled)
    }
  }

  func cancelStream() {
    streamTask?.cancel()
    streamTask = nil
  }

  deinit {
    streamTask?.cancel()
    if #available(iOS 26, *), let store = continuationStore as? ToolContinuationStore {
      store.cancelAll()
    }
  }
}
