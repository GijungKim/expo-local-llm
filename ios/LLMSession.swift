import ExpoModulesCore
import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

class LLMSession: SharedObject {
  private var nativeSession: Any?
  private var streamTask: Task<Void, Never>?
  private var registeredTools: [String: Any] = [:]  // name -> DynamicTool (type-erased)
  private var continuationStore: Any?  // ToolContinuationStore (type-erased for availability)
  private var toolConfigs: [ToolConfig] = []
  private var sessionInstructions: String?
  private var toolTimeout: TimeInterval = 30
  private var generationSchema: Any?  // GenerationSchema (type-erased for availability)
  private var includeSchemaInPrompt: Bool = true

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

  func respond(to prompt: String) async throws -> String {
    guard #available(iOS 26, *), let session = nativeSession else {
      throw NotSupportedException()
    }
    if let schema = generationSchema as? GenerationSchema {
      return try await FoundationModelBridge.respond(
        session: session,
        prompt: prompt,
        schema: schema,
        includeSchemaInPrompt: includeSchemaInPrompt
      )
    }
    return try await FoundationModelBridge.respond(session: session, prompt: prompt)
  }

  func startStream(prompt: String) throws {
    guard #available(iOS 26, *), let session = nativeSession else {
      throw NotSupportedException()
    }

    streamTask?.cancel()

    if let schema = generationSchema as? GenerationSchema {
      startSchemaStream(session: session, prompt: prompt, schema: schema)
    } else {
      startTextStream(session: session, prompt: prompt)
    }
  }

  @available(iOS 26, *)
  private func startTextStream(session: Any, prompt: String) {
    let weakSelf = self
    streamTask = Task {
      var lastContent = ""
      do {
        let stream = FoundationModelBridge.stream(session: session, prompt: prompt)
        for try await content in stream {
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

  @available(iOS 26, *)
  private func startSchemaStream(session: Any, prompt: String, schema: GenerationSchema) {
    let weakSelf = self
    let useIncludeSchemaInPrompt = includeSchemaInPrompt
    streamTask = Task {
      var lastJSON = ""
      do {
        let stream = FoundationModelBridge.stream(
          session: session,
          prompt: prompt,
          schema: schema,
          includeSchemaInPrompt: useIncludeSchemaInPrompt
        )
        for try await snapshot in stream {
          lastJSON = snapshot.json
          weakSelf.emit(event: "partial", arguments: [
            "json": snapshot.json,
            "complete": snapshot.complete,
          ])
        }
        weakSelf.emit(event: "streamComplete", arguments: [
          "text": lastJSON
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
    if #available(iOS 26, *), let store = continuationStore as? ToolContinuationStore {
      store.cancelAll()
    }
  }
}
