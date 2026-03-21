import Foundation
import FoundationModels

// MARK: - Tool errors

enum DynamicToolError: LocalizedError {
  case timeout
  case handlerFailed(String)

  var errorDescription: String? {
    switch self {
    case .timeout:
      return "Tool call timed out waiting for JavaScript response"
    case .handlerFailed(let message):
      return "Tool handler error: \(message)"
    }
  }
}

// MARK: - Generable arguments wrapper

/// A fixed @Generable struct that wraps tool parameters as a JSON string.
/// The tool's description tells the model what JSON shape to produce.
@available(iOS 26, *)
@Generable
struct DynamicArguments {
  @Guide(description: "A JSON object string containing the tool's parameters")
  var parametersJSON: String
}

// MARK: - DynamicTool

/// A generic Tool conformance that delegates execution back to JavaScript.
/// When the model invokes this tool, it serializes arguments and sends an event
/// to JS, then awaits a result via Swift async continuations.
@available(iOS 26, *)
final class DynamicTool: Tool {
  let name: String
  let description: String

  typealias Arguments = DynamicArguments

  /// Callback invoked when the model calls this tool.
  /// Parameters: (callId, toolName, argumentsJSON) -> Void
  private let onToolCall: @Sendable (String, String, String) -> Void

  /// Pending continuations keyed by callId, awaiting JS results.
  private let continuationStore: ToolContinuationStore

  /// Timeout in seconds for JS to respond.
  private let timeoutSeconds: TimeInterval

  init(
    name: String,
    description: String,
    parameterSchema: [String: Any],
    timeoutSeconds: TimeInterval = 30,
    continuationStore: ToolContinuationStore,
    onToolCall: @Sendable @escaping (String, String, String) -> Void
  ) {
    self.name = name
    // Embed the parameter schema in the description so the model knows
    // what JSON shape to produce for parametersJSON.
    let schemaDesc = DynamicTool.buildSchemaDescription(from: parameterSchema)
    self.description = "\(description)\n\nThe parametersJSON must be a JSON object with these fields:\n\(schemaDesc)"
    self.onToolCall = onToolCall
    self.continuationStore = continuationStore
    self.timeoutSeconds = timeoutSeconds
  }

  func call(arguments: DynamicArguments) async throws -> String {
    let callId = UUID().uuidString

    // Send event to JS
    onToolCall(callId, name, arguments.parametersJSON)

    // Wait for JS to resolve this call
    return try await withCheckedThrowingContinuation { continuation in
      continuationStore.store(callId: callId, continuation: continuation)

      // Schedule timeout
      Task {
        try? await Task.sleep(for: .seconds(timeoutSeconds))
        if let timedOut = continuationStore.remove(callId: callId) {
          timedOut.resume(throwing: DynamicToolError.timeout)
        }
      }
    }
  }

  /// Builds a human-readable schema description from the parameter dictionary.
  private static func buildSchemaDescription(from schema: [String: Any]) -> String {
    var lines: [String] = []
    for (key, value) in schema {
      if let param = value as? [String: Any] {
        let type = param["type"] as? String ?? "string"
        let desc = param["description"] as? String ?? ""
        var line = "- \(key) (\(type)): \(desc)"
        if let enumValues = param["enum"] as? [String] {
          line += " [possible values: \(enumValues.joined(separator: ", "))]"
        }
        lines.append(line)
      }
    }
    return lines.joined(separator: "\n")
  }
}

// MARK: - ToolContinuationStore

/// Thread-safe store for pending tool call continuations.
@available(iOS 26, *)
final class ToolContinuationStore: @unchecked Sendable {
  private var continuations: [String: CheckedContinuation<String, Error>] = [:]
  private let lock = NSLock()

  func store(callId: String, continuation: CheckedContinuation<String, Error>) {
    lock.lock()
    continuations[callId] = continuation
    lock.unlock()
  }

  func remove(callId: String) -> CheckedContinuation<String, Error>? {
    lock.lock()
    let cont = continuations.removeValue(forKey: callId)
    lock.unlock()
    return cont
  }

  /// Resolve a pending continuation with a result string.
  func resolve(callId: String, result: String) -> Bool {
    guard let continuation = remove(callId: callId) else { return false }
    continuation.resume(returning: result)
    return true
  }

  /// Reject a pending continuation with an error.
  func reject(callId: String, error: Error) -> Bool {
    guard let continuation = remove(callId: callId) else { return false }
    continuation.resume(throwing: error)
    return true
  }

  /// Cancel all pending continuations (e.g., on session teardown).
  func cancelAll() {
    lock.lock()
    let pending = continuations
    continuations.removeAll()
    lock.unlock()
    for (_, continuation) in pending {
      continuation.resume(throwing: CancellationError())
    }
  }
}
