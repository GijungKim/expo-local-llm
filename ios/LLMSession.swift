import ExpoModulesCore
import Foundation

class LLMSession: SharedObject {
  private var nativeSession: Any?
  private var streamTask: Task<Void, Never>?
  private var registeredTools: [String: Any] = [:]  // name -> DynamicTool (type-erased)
  private var continuationStore: Any?  // ToolContinuationStore (type-erased for availability)
  private var toolConfigs: [ToolConfig] = []
  private var sessionInstructions: String?
  private var toolTimeout: TimeInterval = 30

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

    // Build instructions, appending JSON schema guidance if structured output requested
    var instructions = config.instructions ?? ""
    if config.responseFormat == "json" {
      let schemaClause: String
      if let schema = config.schema,
         let data = try? JSONSerialization.data(withJSONObject: schema, options: .prettyPrinted),
         let schemaStr = String(data: data, encoding: .utf8) {
        schemaClause = "Respond ONLY with a valid JSON object matching this schema:\n\(schemaStr)"
      } else {
        schemaClause = "Respond ONLY with a valid JSON object."
      }
      if instructions.isEmpty {
        instructions = schemaClause
      } else {
        instructions += "\n\n\(schemaClause)"
      }
    }
    sessionInstructions = instructions.isEmpty ? nil : instructions
    toolTimeout = config.toolTimeout ?? 30

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

    var tools: [any Tool] = []
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
      tools.append(tool)
    }

    nativeSession = FoundationModelBridge.createSession(
      instructions: sessionInstructions,
      tools: tools
    )
  }

  // MARK: - Generation

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
    if #available(iOS 26, *), let store = continuationStore as? ToolContinuationStore {
      store.cancelAll()
    }
  }
}
