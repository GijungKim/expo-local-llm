package expo.modules.localllm

import com.google.mlkit.genai.common.StreamingCallback
import com.google.mlkit.genai.prompt.GenerateContentRequest
import com.google.mlkit.genai.prompt.GenerateContentResponse
import com.google.mlkit.genai.prompt.GenerativeModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlin.coroutines.CoroutineContext

/** Narrow boundary around the engine-backed client so the session itself can be exercised on the JVM. */
internal interface SessionModel {
  suspend fun checkStatus(): Int
  suspend fun getAvailableFeatures(): List<Int>
  suspend fun generateContent(request: GenerateContentRequest): GenerateContentResponse
  suspend fun generateContent(
    request: GenerateContentRequest,
    callback: StreamingCallback
  ): GenerateContentResponse
  fun generateContentStream(request: GenerateContentRequest): Flow<GenerateContentResponse>
  fun close()
}

private class GenerativeModelAdapter(
  private val client: GenerativeModel
) : SessionModel {
  override suspend fun checkStatus() = client.checkStatus()
  override suspend fun getAvailableFeatures() = client.getAvailableFeatures()
  override suspend fun generateContent(request: GenerateContentRequest) = client.generateContent(request)
  override suspend fun generateContent(request: GenerateContentRequest, callback: StreamingCallback) =
    client.generateContent(request, callback)
  override fun generateContentStream(request: GenerateContentRequest) = client.generateContentStream(request)
  override fun close() = client.close()
}

internal class SessionRuntime(
  val createModel: (AndroidModel) -> SessionModel,
  val emit: (String, Map<String, Any?>) -> Unit,
  val coroutineContext: CoroutineContext
) {
  companion object {
    fun production(emit: (String, Map<String, Any?>) -> Unit) = SessionRuntime(
      createModel = { GenerativeModelAdapter(it.client()) },
      emit = emit,
      coroutineContext = Dispatchers.Main.immediate
    )
  }
}
