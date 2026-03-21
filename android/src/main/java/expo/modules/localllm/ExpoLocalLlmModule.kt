package expo.modules.localllm

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class ExpoLocalLlmModule : Module() {
  private val scope = CoroutineScope(Dispatchers.Main)

  override fun definition() = ModuleDefinition {
    Name("ExpoLocalLlm")

    Events("downloadProgress", "availabilityChange")

    Function("getAvailability") {
      LLMSession.checkAvailability(appContext.reactContext!!).value
    }

    AsyncFunction("downloadModel") Coroutine { ->
      val context = appContext.reactContext!!
      // Immediately signal downloading state so UI can disable the download button
      sendEvent("availabilityChange", mapOf("availability" to ModelAvailability.downloading.value))
      LLMSession.downloadModel(context) { progress ->
        sendEvent("downloadProgress", mapOf("progress" to progress))
      }
      // Re-check availability after download completes
      val newAvailability = LLMSession.checkAvailability(context)
      sendEvent("availabilityChange", mapOf("availability" to newAvailability.value))
    }

    Class(LLMSession::class) {
      Constructor { config: SessionConfig ->
        LLMSession(appContext.reactContext!!, config)
      }

      AsyncFunction("respond") Coroutine { session: LLMSession, prompt: String ->
        session.respond(prompt)
      }

      AsyncFunction("streamResponse") { session: LLMSession, prompt: String ->
        session.startStream(prompt)
      }

      AsyncFunction("cancelStream") { session: LLMSession ->
        session.cancelStream()
      }

      Events("token", "streamComplete", "streamError")
    }

    OnActivityDestroys {
      // Cleanup handled by SharedObject.deallocate() on each LLMSession
    }
  }
}
