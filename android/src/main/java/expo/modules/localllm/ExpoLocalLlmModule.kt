package expo.modules.localllm

import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.types.Either
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class ExpoLocalLlmModule : Module() {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

  override fun definition() = ModuleDefinition {
    Name("ExpoLocalLlm")

    Events("downloadProgress", "availabilityChange")

    Function("getImagePromptVersion") { 1 }
    Function("getToolCallingVersion") { 1 }

    Function("getAvailability") { androidModel: String? ->
      val selection = AndroidModel.parse(androidModel)
      val cached = LLMSession.getCachedAvailability(selection)
      // ML Kit's status API is suspend-only. Preserve the synchronous JS API
      // by returning the latest cache and refreshing it asynchronously.
      scope.launch(Dispatchers.Default) {
        val refreshed = LLMSession.refreshAvailability(selection)
        withContext(Dispatchers.Main.immediate) {
          sendEvent("availabilityChange", mapOf("availability" to refreshed.value, "androidModel" to selection.value))
        }
      }
      cached.value
    }

    AsyncFunction("getModelReadiness") Coroutine { androidModel: String? ->
      LLMSession.readiness(AndroidModel.parse(androidModel))
    }

    AsyncFunction("downloadModel") Coroutine { androidModel: String? ->
      val selection = AndroidModel.parse(androidModel)
      // Immediately signal downloading state so UI can disable the download button
      sendEvent("availabilityChange", mapOf("availability" to ModelAvailability.downloading.value, "androidModel" to selection.value))
      try {
        LLMSession.downloadModel(selection) { progress ->
          sendEvent("downloadProgress", mapOf("progress" to progress, "androidModel" to selection.value))
        }
      } finally {
        // A failed/cancelled download can still change the SDK's state. Always
        // refresh it rather than leaving consumers stuck at "downloading".
        withContext(NonCancellable) {
          val newAvailability = LLMSession.refreshAvailability(selection)
          sendEvent("availabilityChange", mapOf("availability" to newAvailability.value, "androidModel" to selection.value))
        }
      }
    }

    Class(LLMSession::class) {
      Constructor { config: SessionConfig ->
        if (config.responseFormat == "json") {
          throw ResponseFormatNotSupportedException()
        }
        LLMSession(config)
      }

      AsyncFunction("respond") Coroutine { session: LLMSession, prompt: Either<String, PromptRecord>, requestId: String? ->
        session.respond(prompt.toLocalPrompt(), requestId)
      }

      AsyncFunction("streamResponse") Coroutine { session: LLMSession, prompt: Either<String, PromptRecord>, requestId: String? ->
        session.streamResponse(prompt.toLocalPrompt(), requestId)
      }

      AsyncFunction("cancelStream") { session: LLMSession ->
        session.cancelStream()
      }

      Function("reset") { session: LLMSession ->
        session.reset()
      }

      Function("registerTool") { session: LLMSession, config: ToolConfig -> session.registerTool(config) }
      Function("unregisterTool") { session: LLMSession, name: String -> session.unregisterTool(name) }
      Function("resolveToolCall") { session: LLMSession, id: String, result: String -> session.resolveToolCall(id, result) }
      Function("rejectToolCall") { session: LLMSession, id: String, error: String -> session.rejectToolCall(id, error) }

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
