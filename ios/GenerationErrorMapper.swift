import ExpoModulesCore
import Foundation
import FoundationModels

/// Stable error codes shared with Android and declared in TypeScript as
/// `LocalLLMErrorCode`. JavaScript branches on these instead of on messages.
enum LocalLLMErrorCode: String {
  case contextWindowExceeded = "ERR_CONTEXT_WINDOW_EXCEEDED"
  case guardrailViolation = "ERR_GUARDRAIL_VIOLATION"
  case refusal = "ERR_REFUSAL"
  case unsupportedLanguage = "ERR_UNSUPPORTED_LANGUAGE"
  case unsupportedRequest = "ERR_UNSUPPORTED_REQUEST"
  case rateLimited = "ERR_RATE_LIMITED"
  case modelUnavailable = "ERR_MODEL_UNAVAILABLE"
  case decodingFailed = "ERR_DECODING_FAILED"
  case timeout = "ERR_TIMEOUT"
  case toolFailed = "ERR_TOOL_FAILED"
  case sessionBusy = "ERR_SESSION_BUSY"
  case generationFailed = "ERR_GENERATION_FAILED"
}

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
    return GenerationException((code: code(for: error), message: error.localizedDescription))
  }

  static func code(for error: Error) -> LocalLLMErrorCode {
    if let exception = error as? Exception {
      return LocalLLMErrorCode(rawValue: exception.code) ?? .generationFailed
    }
    if error is LanguageModelSession.ToolCallError {
      return .toolFailed
    }
    if let generationError = error as? LanguageModelSession.GenerationError {
      return code(for: generationError)
    }
    #if compiler(>=6.4)
    // The iOS 27 SDK replaces GenerationError with these types. Older
    // toolchains (the Xcode 26.4 floor) cannot name them.
    if #available(iOS 27, *), let code = iOS27Code(for: error) {
      return code
    }
    #endif
    return .generationFailed
  }

  private static func code(for error: LanguageModelSession.GenerationError) -> LocalLLMErrorCode {
    switch error {
    case .exceededContextWindowSize:
      return .contextWindowExceeded
    case .assetsUnavailable:
      return .modelUnavailable
    case .guardrailViolation:
      return .guardrailViolation
    case .unsupportedGuide:
      return .unsupportedRequest
    case .unsupportedLanguageOrLocale:
      return .unsupportedLanguage
    case .decodingFailure:
      return .decodingFailed
    case .rateLimited:
      return .rateLimited
    case .concurrentRequests:
      return .sessionBusy
    case .refusal:
      return .refusal
    @unknown default:
      return .generationFailed
    }
  }

  #if compiler(>=6.4)
  @available(iOS 27, *)
  private static func iOS27Code(for error: Error) -> LocalLLMErrorCode? {
    if let languageModelError = error as? LanguageModelError {
      switch languageModelError {
      case .contextSizeExceeded:
        return .contextWindowExceeded
      case .rateLimited:
        return .rateLimited
      case .guardrailViolation:
        return .guardrailViolation
      case .refusal:
        return .refusal
      case .unsupportedCapability, .unsupportedTranscriptContent, .unsupportedGenerationGuide:
        return .unsupportedRequest
      case .unsupportedLanguageOrLocale:
        return .unsupportedLanguage
      case .timeout:
        return .timeout
      @unknown default:
        return .generationFailed
      }
    }
    if error is SystemLanguageModel.Error {
      return .modelUnavailable
    }
    if let sessionError = error as? LanguageModelSession.Error {
      switch sessionError {
      case .concurrentRequests:
        return .sessionBusy
      default:
        return .generationFailed
      }
    }
    if error is GeneratedContent.ParsingError {
      return .decodingFailed
    }
    return nil
  }
  #endif
}
