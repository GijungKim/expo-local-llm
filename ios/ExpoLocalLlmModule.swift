import ExpoModulesCore

public class ExpoLocalLlmModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoLocalLlm")

    Events("downloadProgress", "availabilityChange")

    Function("getAvailability") { () -> String in
      if #available(iOS 26, *) {
        return LLMSession.checkAvailability().rawValue
      }
      return ModelAvailability.notEligible.rawValue
    }

    AsyncFunction("downloadModel") {
      // No-op on iOS — model is built into the OS
    }

    Class(LLMSession.self) {
      Constructor { (config: SessionConfig) -> LLMSession in
        let session = LLMSession()
        try session.setup(config: config)
        return session
      }

      AsyncFunction("respond") { (session: LLMSession, prompt: String) -> String in
        return try await session.respond(to: prompt)
      }

      AsyncFunction("streamResponse") { (session: LLMSession, prompt: String) in
        try session.startStream(prompt: prompt)
      }

      AsyncFunction("cancelStream") { (session: LLMSession) in
        session.cancelStream()
      }

      // Tool calling support
      Function("registerTool") { (session: LLMSession, config: ToolConfig) in
        session.registerTool(config: config)
      }

      Function("unregisterTool") { (session: LLMSession, name: String) in
        session.unregisterTool(name: name)
      }

      Function("resolveToolCall") { (session: LLMSession, callId: String, result: String) in
        try session.resolveToolCall(callId: callId, result: result)
      }

      Function("rejectToolCall") { (session: LLMSession, callId: String, error: String) in
        try session.rejectToolCall(callId: callId, error: error)
      }
    }

    OnAppEntersForeground {
      // Re-check availability when user returns (may have toggled Apple Intelligence in Settings)
      if #available(iOS 26, *) {
        let current = LLMSession.checkAvailability().rawValue
        self.sendEvent("availabilityChange", [
          "availability": current
        ])
      }
    }

    OnAppEntersBackground {
      // Cancel any active streams when app backgrounds
    }
  }
}
