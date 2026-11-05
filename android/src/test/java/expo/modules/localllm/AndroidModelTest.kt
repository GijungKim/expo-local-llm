package expo.modules.localllm

import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.common.GenAiException
import com.google.mlkit.genai.prompt.Feature
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class AndroidModelTest {
  @Test fun `generation distinguishes unready models from absent tools`() = runBlocking<Unit> {
    for (status in listOf(FeatureStatus.DOWNLOADABLE, FeatureStatus.DOWNLOADING, FeatureStatus.UNAVAILABLE)) {
      try {
        requireToolSupport({ status }, { fail("Unready models must not query features"); emptyList() })
        fail("Expected model unavailable")
      } catch (error: GenerationException) { assertEquals("ERR_MODEL_UNAVAILABLE", error.code) }
    }
    try {
      requireToolSupport({ FeatureStatus.AVAILABLE }, { emptyList() })
      fail("Expected confirmed feature absence")
    } catch (error: ToolNotSupportedException) { assertEquals("ERR_TOOL_NOT_SUPPORTED", error.code) }
    requireToolSupport({ FeatureStatus.AVAILABLE }, { listOf(Feature.FUNCTION_CALLING) })
  }

  @Test fun `generation preserves query failures for error classification`() = runBlocking<Unit> {
    val failure = GenAiException("service busy", null, GenAiException.ErrorCode.BUSY)
    for (statusFails in listOf(true, false)) {
      try {
        requireToolSupport(
          { if (statusFails) throw failure else FeatureStatus.AVAILABLE },
          { throw failure }
        )
        fail("Expected original SDK failure")
      } catch (error: GenAiException) {
        assertSame(failure, error)
        val mapped = mapImageRequestError(error, LocalPrompt("test"))
        assertEquals("ERR_RATE_LIMITED", mapped.code)
        assertSame(failure, mapped.cause)
      }
    }
    try {
      requireToolSupport({ -1 }, { emptyList() })
      fail("Expected unknown readiness failure")
    } catch (error: GenerationException) { assertEquals("ERR_GENERATION_FAILED", error.code) }
    val queryFailure = IllegalStateException("feature service failed")
    try {
      requireToolSupport({ FeatureStatus.AVAILABLE }, { throw queryFailure })
      fail("Expected query failure")
    } catch (error: IllegalStateException) {
      assertSame(queryFailure, error)
      assertEquals("ERR_GENERATION_FAILED", mapImageRequestError(error, LocalPrompt("test")).code)
    }
  }

  @Test fun `generation readiness cancellation propagates`() = runBlocking<Unit> {
    for (statusFails in listOf(true, false)) {
      val cancelled = CancellationException("cancelled")
      try {
        requireToolSupport(
          { if (statusFails) throw cancelled else FeatureStatus.AVAILABLE },
          { throw cancelled }
        )
        fail("Expected cancellation")
      } catch (error: CancellationException) { assertSame(cancelled, error) }
    }
  }

  @Test fun `selection is explicit and invalid selections never fallback`() {
    assertEquals(AndroidModel.DEFAULT, AndroidModel.parse(null))
    assertEquals(AndroidModel.DEFAULT, AndroidModel.parse("default"))
    assertEquals(AndroidModel.PREVIEW_FAST, AndroidModel.parse("previewFast"))
    assertThrows(ToolNotSupportedException::class.java) { AndroidModel.parse("automatic") }
  }

  @Test fun `readiness queries distinguish status features and service errors`() = runBlocking<Unit> {
    assertEquals(mapOf("availability" to "downloadRequired", "tools" to "available"),
      queryModelReadiness({ FeatureStatus.DOWNLOADABLE }, { listOf(Feature.FUNCTION_CALLING) }))
    assertEquals(mapOf("availability" to "available", "tools" to "unavailable"),
      queryModelReadiness({ FeatureStatus.AVAILABLE }, { emptyList() }))
    assertEquals(mapOf("availability" to "unknown", "tools" to "available"),
      queryModelReadiness({ throw IllegalStateException("status failed") }, { listOf(Feature.FUNCTION_CALLING) }))
    assertEquals(mapOf("availability" to "available", "tools" to "unknown"),
      queryModelReadiness({ FeatureStatus.AVAILABLE }, { throw IllegalStateException("features failed") }))
    try {
      queryModelReadiness({ throw CancellationException() }, { emptyList() })
      fail("Cancellation must propagate")
    } catch (_: CancellationException) { }
  }
}
