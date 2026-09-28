package expo.modules.localllm

import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class ExpoLocalLlmModule : Module() {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

  private fun throwToolNotSupported(): Unit = throw ToolNotSupportedException()

  override fun definition() = ModuleDefinition {
    Name("ExpoLocalLlm")

    Events("downloadProgress", "availabilityChange")

    Function("getAvailability") {
      val cached = LLMSession.getCachedAvailability()
      // ML Kit's status API is suspend-only. Preserve the synchronous JS API
      // by returning the latest cache and refreshing it asynchronously.
      scope.launch(Dispatchers.Default) {
        val refreshed = LLMSession.refreshAvailability()
        withContext(Dispatchers.Main.immediate) {
          sendEvent("availabilityChange", mapOf("availability" to refreshed.value))
        }
      }
      cached.value
    }

    AsyncFunction("downloadModel") Coroutine { ->
      // Immediately signal downloading state so UI can disable the download button
      sendEvent("availabilityChange", mapOf("availability" to ModelAvailability.downloading.value))
      try {
        LLMSession.downloadModel { progress ->
          sendEvent("downloadProgress", mapOf("progress" to progress))
        }
      } finally {
        // A failed/cancelled download can still change the SDK's state. Always
        // refresh it rather than leaving consumers stuck at "downloading".
        withContext(NonCancellable) {
          val newAvailability = LLMSession.refreshAvailability()
          sendEvent("availabilityChange", mapOf("availability" to newAvailability.value))
        }
      }
    }

    Class(LLMSession::class) {
      Constructor { config: SessionConfig ->
        if (config.responseFormat == "json") {
          throw ResponseFormatNotSupportedException()
        }
        if (!config.tools.isNullOrEmpty()) {
          throw ToolNotSupportedException()
        }
        LLMSession(config)
      }

      AsyncFunction("respond") Coroutine { session: LLMSession, prompt: String, requestId: String? ->
        session.respond(prompt, requestId)
      }

      AsyncFunction("streamResponse") Coroutine { session: LLMSession, prompt: String, requestId: String? ->
        session.streamResponse(prompt, requestId)
      }

      AsyncFunction("cancelStream") { session: LLMSession ->
        session.cancelStream()
      }

      Function("reset") { session: LLMSession ->
        session.reset()
      }

      // Tool calling stubs — not yet supported on Android
      Function("registerTool") { _: LLMSession, _: ToolConfig ->
        throwToolNotSupported()
      }

      Function("unregisterTool") { _: LLMSession, _: String ->
        throwToolNotSupported()
      }

      Function("resolveToolCall") { _: LLMSession, _: String, _: String ->
        throwToolNotSupported()
      }

      Function("rejectToolCall") { _: LLMSession, _: String, _: String ->
        throwToolNotSupported()
      }

      Events("token", "streamComplete", "streamError", "toolCall")
    }

    OnActivityDestroys {
      // Cleanup is handled when each LLMSession shared object is released.
    }

    OnDestroy {
      scope.cancel()
    }
  }
}
