package expo.modules.localllm

import com.google.mlkit.genai.common.GenAiException
import org.junit.Assert.assertEquals
import org.junit.Test

class GenerationErrorsTest {
  private fun codeFor(errorCode: Int) =
    generationErrorCode(GenAiException("failure", null, errorCode))

  @Test
  fun `oversized requests report the context window`() {
    assertEquals(
      LocalLLMErrorCode.CONTEXT_WINDOW_EXCEEDED,
      codeFor(GenAiException.ErrorCode.REQUEST_TOO_LARGE)
    )
  }

  @Test
  fun `quota and busy failures are retryable rate limits`() {
    assertEquals(LocalLLMErrorCode.RATE_LIMITED, codeFor(GenAiException.ErrorCode.BUSY))
    assertEquals(
      LocalLLMErrorCode.RATE_LIMITED,
      codeFor(GenAiException.ErrorCode.PER_APP_BATTERY_USE_QUOTA_EXCEEDED)
    )
    assertEquals(LocalLLMErrorCode.RATE_LIMITED, codeFor(GenAiException.ErrorCode.BACKGROUND_USE_BLOCKED))
  }

  @Test
  fun `missing model support reports the model as unavailable`() {
    assertEquals(LocalLLMErrorCode.MODEL_UNAVAILABLE, codeFor(GenAiException.ErrorCode.NOT_AVAILABLE))
    assertEquals(LocalLLMErrorCode.MODEL_UNAVAILABLE, codeFor(GenAiException.ErrorCode.AICORE_INCOMPATIBLE))
  }

  @Test
  fun `unclassified failures fall back to a generic code`() {
    assertEquals(LocalLLMErrorCode.GENERATION_FAILED, codeFor(GenAiException.ErrorCode.UNKNOWN))
    assertEquals(LocalLLMErrorCode.GENERATION_FAILED, generationErrorCode(IllegalStateException("boom")))
  }

  @Test
  fun `generation exceptions keep the message and expose the code`() {
    val exception = generationException(GenAiException("too long", null, GenAiException.ErrorCode.REQUEST_TOO_LARGE))

    assertEquals("ERR_CONTEXT_WINDOW_EXCEEDED", exception.code)
    assertEquals("too long", exception.message)
  }
}
