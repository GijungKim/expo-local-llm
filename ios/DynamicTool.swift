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
  /// Returns whether the invocation was accepted for delivery to JavaScript.
  private let onToolCall: @Sendable (String, String, String) -> Bool

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
    onToolCall: @Sendable @escaping (String, String, String) -> Bool
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

    return try await withTaskCancellationHandler {
      // Store the continuation before notifying JS. Otherwise a synchronous
      // JS handler can resolve the call before there is anything to resume.
      return try await withCheckedThrowingContinuation { continuation in
        guard continuationStore.store(callId: callId, continuation: continuation) else {
          return
        }

        // Schedule timeout — cancelled by the store when the call resolves,
        // so it doesn't linger for the full duration after a fast handler.
        let timeoutSeconds = self.timeoutSeconds
        let timeoutTask = Task { [continuationStore] in
          try? await Task.sleep(for: .seconds(timeoutSeconds))
          guard !Task.isCancelled else { return }
          if let timedOut = continuationStore.remove(callId: callId) {
            timedOut.resume(throwing: DynamicToolError.timeout)
          }
        }
        continuationStore.attachTimeout(callId: callId, task: timeoutTask)

        if Task.isCancelled {
          _ = continuationStore.reject(callId: callId, error: CancellationError())
        } else if !onToolCall(callId, name, arguments.parametersJSON) {
          // A reset/release can invalidate this generation before its native
          // tool callback reaches JS. Never leave that continuation pending.
          _ = continuationStore.reject(callId: callId, error: CancellationError())
        }
      }
    } onCancel: { [continuationStore] in
      // Cancelling/resetting a generation must also release any native tool
      // call suspended on a JavaScript result.
      _ = continuationStore.reject(callId: callId, error: CancellationError())
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
  private struct Pending {
    let continuation: CheckedContinuation<String, Error>
    var timeoutTask: Task<Void, Never>?
  }

  private var pending: [String: Pending] = [:]
  private var closed = false
  private let lock = NSLock()

  @discardableResult
  func store(callId: String, continuation: CheckedContinuation<String, Error>) -> Bool {
    lock.lock()
    guard !closed else {
      lock.unlock()
      continuation.resume(throwing: CancellationError())
      return false
    }
    pending[callId] = Pending(continuation: continuation, timeoutTask: nil)
    lock.unlock()
    return true
  }

  /// Attach the timeout task for a call so it can be cancelled on resolve.
  /// If the call already resolved, the task is cancelled immediately.
  func attachTimeout(callId: String, task: Task<Void, Never>) {
    lock.lock()
    if pending[callId] != nil {
      pending[callId]?.timeoutTask = task
      lock.unlock()
    } else {
      lock.unlock()
      task.cancel()
    }
  }

  func remove(callId: String) -> CheckedContinuation<String, Error>? {
    lock.lock()
    let entry = pending.removeValue(forKey: callId)
    lock.unlock()
    entry?.timeoutTask?.cancel()
    return entry?.continuation
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

  /// Permanently close this session store and cancel all pending calls. Late
  /// registrations are rejected immediately instead of waiting for timeout.
  func close() {
    lock.lock()
    closed = true
    let entries = pending
    pending.removeAll()
    lock.unlock()
    for (_, entry) in entries {
      entry.timeoutTask?.cancel()
      entry.continuation.resume(throwing: CancellationError())
    }
  }
}
