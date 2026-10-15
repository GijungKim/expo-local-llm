import ExpoModulesCore
import Foundation

class GenerationException: GenericException<(code: LocalLLMErrorCode, message: String)>, @unchecked Sendable {
  override var code: String {
    param.code.rawValue
  }

  override var reason: String {
    param.message
  }
}

@available(iOS 26, *)
enum GenerationErrorMapper {
  /// Module exceptions already carry a code; Foundation Models errors are
  /// classified so every generation failure reaches JavaScript with one.
  static func exception(for error: Error) -> Exception {
    if let exception = error as? Exception {
      return exception
    }
    return GenerationException((
      code: GenerationErrorClassifier.code(for: error),
      message: error.localizedDescription
    ))
  }
}
