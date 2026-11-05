package expo.modules.localllm

import android.graphics.Bitmap
import androidx.test.platform.app.InstrumentationRegistry
import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.common.FunctionCall
import com.google.mlkit.genai.common.StreamingCallback
import com.google.mlkit.genai.prompt.Candidate
import com.google.mlkit.genai.prompt.Feature
import com.google.mlkit.genai.prompt.GenerateContentRequest
import com.google.mlkit.genai.prompt.GenerateContentResponse
import com.google.mlkit.genai.prompt.ImagePart
import com.google.mlkit.genai.prompt.TextPart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/** Runs on ART because ML Kit beta5 ImagePart cannot be verified by the desktop JVM. No inference. */
class ImageRequestAndroidTest {
  private class ScriptedModel(val replies: ArrayDeque<GenerateContentResponse>) : SessionModel {
    val requests = mutableListOf<GenerateContentRequest>()
    var closes = 0
    override suspend fun checkStatus() = FeatureStatus.AVAILABLE
    override suspend fun getAvailableFeatures() = listOf(Feature.FUNCTION_CALLING)
    override suspend fun generateContent(request: GenerateContentRequest): GenerateContentResponse {
      requests += request
      return replies.removeFirst()
    }
    override suspend fun generateContent(request: GenerateContentRequest, callback: StreamingCallback) =
      generateContent(request)
    override fun generateContentStream(request: GenerateContentRequest): Flow<GenerateContentResponse> =
      flow { emit(generateContent(request)) }
    override fun close() { closes++ }
  }

  private fun response(text: String, calls: List<FunctionCall> = emptyList()): GenerateContentResponse {
    // The SDK has no public response builders. Construct real immutable SDK values through
    // its synthetic constructors, without substituting SDK classes or bypassing verification.
    val candidate = Candidate::class.java.constructors.single { it.parameterCount == 4 }
      .newInstance(text, calls, Candidate.FinishReason.STOP, null) as Candidate
    return GenerateContentResponse::class.java.constructors.single { it.parameterCount == 3 }
      .newInstance(listOf(candidate), emptyList<Candidate>(), null) as GenerateContentResponse
  }

  private suspend fun withImages(count: Int, block: suspend (LocalPrompt) -> Unit) {
    val cache = InstrumentationRegistry.getInstrumentation().targetContext.cacheDir
    val files = (0 until count).map { index ->
      File.createTempFile("llm-image-$index-", ".png", cache).also { file ->
        val bitmap = Bitmap.createBitmap(8 + index, 6, Bitmap.Config.ARGB_8888)
        try { file.outputStream().use { assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) } }
        finally { bitmap.recycle() }
      }
    }
    try {
      block(LocalPrompt("Compare the images", files.mapIndexed { index, file ->
        LocalImage(file.toURI().toString(), "image-$index", file.absolutePath)
      }))
    } finally { files.forEach { it.delete() } }
  }

  @Test fun imageRequestsUseRealSdkPartsWithOptionsAndOrder() = runBlocking {
    for (count in listOf(0, 1, 8)) {
      withImages(count) { prompt ->
        val model = ScriptedModel(ArrayDeque(listOf(response("done"))))
        val config = SessionConfig().apply {
          options = GenerationOptionsRecord().apply { temperature = 0.3f; maxTokens = 64; topK = 32 }
        }
        val session = LLMSession.createForTesting(config, SessionRuntime({ model }, { _, _ -> }, Dispatchers.Unconfined))
        try {
          assertEquals("done", session.respond(prompt))
          val request = model.requests.single()
          assertEquals(0.3f, request.temperature, 0.0f)
          assertEquals(64, request.maxOutputTokens)
          assertEquals(32, request.topK)
          val parts = request.contents.single().parts
          assertTrue((parts.first() as TextPart).textString.contains(prompt.text))
          assertEquals(1 + count * 2, parts.size)
          repeat(count) { index ->
            assertEquals("Image \"image-$index\":", (parts[1 + index * 2] as TextPart).textString)
            val image = parts[2 + index * 2] as ImagePart
            assertEquals(8 + index, image.bitmap.width)
            assertEquals(6, image.bitmap.height)
            assertFalse(image.bitmap.isRecycled)
          }
        } finally { session.sharedObjectDidRelease() }
        assertEquals(1, model.closes)
      }
    }
  }

  @Test fun imageAttachmentsSurviveToolRoundsButAreAbsentFromNextRequestHistory() = runBlocking {
    withImages(2) { prompt ->
      val call = FunctionCall("lookup", emptyMap(), "image-call")
      val model = ScriptedModel(ArrayDeque(listOf(response("", listOf(call)), response("compared"), response("later"))))
      val config = SessionConfig().apply {
        tools = listOf(ToolConfig().apply { name = "lookup"; description = "Read a local value"; parameters = emptyMap() })
      }
      lateinit var session: LLMSession
      session = LLMSession.createForTesting(config, SessionRuntime({ model }, { name, body ->
        if (name == "toolCall") session.resolveToolCall(body.getValue("callId") as String, "result")
      }, Dispatchers.Unconfined))
      try {
        assertEquals("compared", session.respond(prompt))
        assertEquals(2, model.requests.size)
        val original = model.requests[0].contents.flatMap { it.parts }.filterIsInstance<ImagePart>()
        val followup = model.requests[1].contents.flatMap { it.parts }.filterIsInstance<ImagePart>()
        assertEquals(2, original.size)
        assertEquals(2, followup.size)
        original.zip(followup).forEach { (first, second) ->
          assertSame(first.bitmap, second.bitmap)
          assertFalse(second.bitmap.isRecycled)
        }
        assertEquals("later", session.respond(LocalPrompt("What did we discuss?")))
        assertTrue(model.requests.last().contents.flatMap { it.parts }.none { it is ImagePart })
        assertTrue(model.requests.last().contents.flatMap { it.parts }.filterIsInstance<TextPart>()
          .any { it.textString.contains("compared") })
      } finally { session.sharedObjectDidRelease() }
      assertEquals(1, model.closes)
    }
  }
}
