import Foundation
import FoundationModels

// Runs the library's Foundation Models code against the real system model on
// macOS. Compiled together with ios/DynamicTool.swift,
// ios/GenerationSchemaBuilder.swift and ios/GenerationErrorCodes.swift.

private final class Recorder: @unchecked Sendable {
  private let lock = NSLock()
  private var calls: [[String: Any]] = []

  func record(_ arguments: [String: Any]) {
    lock.lock()
    calls.append(arguments)
    lock.unlock()
  }

  var recorded: [[String: Any]] {
    lock.lock()
    defer { lock.unlock() }
    return calls
  }
}

private struct CheckFailure: Error, CustomStringConvertible {
  let description: String
}

private func expect(_ condition: Bool, _ message: String) throws {
  if !condition {
    throw CheckFailure(description: message)
  }
}

private let weatherParameters: [String: Any] = [
  "city": ["type": "string", "description": "The city name"],
  "unit": ["type": "string", "description": "Temperature unit", "enum": ["celsius", "fahrenheit"]],
  "days": ["type": "integer", "description": "Number of forecast days"],
]

private func makeWeatherTool(
  store: ToolContinuationStore,
  onCall: @escaping @Sendable (String, [String: Any]) -> Void
) throws -> DynamicTool {
  DynamicTool(
    name: "getWeather",
    description: "Get the weather forecast for a city",
    parameters: try DynamicTool.parameterSchema(toolName: "getWeather", parameters: weatherParameters),
    continuationStore: store
  ) { callId, _, arguments in
    onCall(callId, arguments)
    return true
  }
}

/// The model may occasionally answer without calling the tool, so allow a few attempts.
private func checkConstrainedToolArguments() async throws {
  for _ in 1...3 {
    let store = ToolContinuationStore()
    let recorder = Recorder()
    let tool = try makeWeatherTool(store: store) { callId, arguments in
      recorder.record(arguments)
      _ = store.resolve(callId: callId, result: "Sunny, 70 degrees every day")
    }
    let session = LanguageModelSession(
      tools: [tool],
      instructions: "Always call the getWeather tool to answer weather questions."
    )
    _ = try await session.respond(to: "What's the 3-day forecast for Paris in fahrenheit?")
    guard let arguments = recorder.recorded.first else { continue }

    try expect(arguments["city"] is String, "city should be a string, got \(arguments)")
    let unit = arguments["unit"] as? String
    try expect(unit == "celsius" || unit == "fahrenheit", "unit should be an enum value, got \(arguments)")
    let days = arguments["days"] as? NSNumber
    try expect(days != nil && days!.doubleValue.rounded() == days!.doubleValue, "days should be an integer, got \(arguments)")
    try expect(Set(arguments.keys) == Set(weatherParameters.keys), "arguments should have exactly the declared keys, got \(arguments)")
    return
  }
  throw CheckFailure(description: "the model did not call the tool in 3 attempts")
}

private func checkToolFailureCode() async throws {
  let store = ToolContinuationStore()
  let tool = try makeWeatherTool(store: store) { callId, _ in
    _ = store.reject(callId: callId, error: DynamicToolError.handlerFailed("service down"))
  }
  do {
    _ = try await LanguageModelSession(tools: [tool], instructions: "Always call the getWeather tool.")
      .respond(to: "Weather in Tokyo in celsius for 1 day?")
    throw CheckFailure(description: "a rejected tool call should fail the turn")
  } catch let error as CheckFailure {
    throw error
  } catch {
    let code = GenerationErrorClassifier.code(for: error)
    try expect(code == .toolFailed, "expected \(LocalLLMErrorCode.toolFailed.rawValue), got \(code.rawValue) for \(type(of: error))")
  }
}

private func checkContextOverflowCode() async throws {
  let inventory = (1...6000).map { "item\($0) has weight \($0 % 97) grams;" }.joined(separator: " ")
  do {
    _ = try await LanguageModelSession().respond(to: "Summarise this inventory: " + inventory)
    throw CheckFailure(description: "an oversized prompt should exceed the context window")
  } catch let error as CheckFailure {
    throw error
  } catch {
    let code = GenerationErrorClassifier.code(for: error)
    try expect(
      code == .contextWindowExceeded,
      "expected \(LocalLLMErrorCode.contextWindowExceeded.rawValue), got \(code.rawValue) for \(type(of: error)): \(error.localizedDescription)"
    )
  }
}

private func checkStructuredOutput() async throws {
  let schema = try GenerationSchemaBuilder.build(properties: [
    "name": ["type": "string", "description": "Recipe name"],
    "difficulty": ["type": "string", "enum": ["easy", "medium", "hard"]],
    "ingredients": ["type": "array", "items": ["type": "string"]],
  ])
  let response = try await LanguageModelSession().respond(to: "Give me a pasta recipe", schema: schema)
  let data = Data(response.content.jsonString.utf8)
  let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
  try expect(object?["name"] is String, "name should be a string, got \(String(describing: object))")
  try expect(["easy", "medium", "hard"].contains(object?["difficulty"] as? String ?? ""), "difficulty should be an enum value, got \(String(describing: object))")
  try expect(object?["ingredients"] is [String], "ingredients should be a string array, got \(String(describing: object))")
}

@main
struct ModelCheck {
  static func main() async {
    guard case .available = SystemLanguageModel.default.availability else {
      print("SKIP: the system language model is not available (\(SystemLanguageModel.default.availability)).")
      print("Enable Apple Intelligence and wait for the model to finish downloading.")
      exit(2)
    }

    let checks: [(String, () async throws -> Void)] = [
      ("tool arguments are decoded against parameters", checkConstrainedToolArguments),
      ("a failing tool handler maps to ERR_TOOL_FAILED", checkToolFailureCode),
      ("context overflow maps to ERR_CONTEXT_WINDOW_EXCEEDED", checkContextOverflowCode),
      ("structured output matches the schema", checkStructuredOutput),
    ]
    var failures = 0
    for (name, check) in checks {
      do {
        try await check()
        print("PASS  \(name)")
      } catch {
        failures += 1
        print("FAIL  \(name): \(error)")
      }
    }
    print(failures == 0 ? "All \(checks.count) model checks passed." : "\(failures) of \(checks.count) model checks failed.")
    exit(failures == 0 ? 0 : 1)
  }
}
