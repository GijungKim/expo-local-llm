package expo.modules.localllm

import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.prompt.Feature
import com.google.mlkit.genai.prompt.Generation
import com.google.mlkit.genai.prompt.GenerationConfig
import com.google.mlkit.genai.prompt.GenerativeModel
import com.google.mlkit.genai.prompt.ModelConfig
import com.google.mlkit.genai.prompt.ModelPreference
import com.google.mlkit.genai.prompt.ModelReleaseStage
import kotlinx.coroutines.CancellationException

internal enum class AndroidModel(val value: String) {
  DEFAULT("default"), PREVIEW_FAST("previewFast");

  fun client(): GenerativeModel = Generation.getClient(GenerationConfig.Builder().apply {
    modelConfig = ModelConfig.Builder().apply {
      releaseStage = if (this@AndroidModel == PREVIEW_FAST) ModelReleaseStage.PREVIEW else ModelReleaseStage.STABLE
      preference = if (this@AndroidModel == PREVIEW_FAST) ModelPreference.FAST else ModelPreference.FULL
    }.build()
  }.build())

  companion object {
    fun parse(value: String?): AndroidModel = when (value) {
      null, "default" -> DEFAULT
      "previewFast" -> PREVIEW_FAST
      else -> throw ToolNotSupportedException("Unknown Android model selection: $value")
    }
  }
}

internal fun modelAvailability(status: Int): ModelAvailability = when (status) {
  FeatureStatus.AVAILABLE -> ModelAvailability.available
  FeatureStatus.DOWNLOADING -> ModelAvailability.downloading
  FeatureStatus.DOWNLOADABLE -> ModelAvailability.downloadRequired
  FeatureStatus.UNAVAILABLE -> ModelAvailability.notEligible
  else -> ModelAvailability.unknown
}

internal suspend fun modelReadiness(client: GenerativeModel): Map<String, String> =
  queryModelReadiness({ client.checkStatus() }, { client.getAvailableFeatures() })

internal suspend fun requireToolSupport(client: GenerativeModel) =
  requireToolSupport({ client.checkStatus() }, { client.getAvailableFeatures() })

/** Generation retains SDK failures for the normal error mapper; discovery may return unknown. */
internal suspend fun requireToolSupport(
  checkStatus: suspend () -> Int,
  availableFeatures: suspend () -> List<Int>
) {
  val availability = modelAvailability(checkStatus())
  if (availability == ModelAvailability.unknown) {
    throw GenerationException(LocalLLMErrorCode.GENERATION_FAILED, "Selected model readiness is unknown", null)
  }
  if (availability != ModelAvailability.available) {
    throw GenerationException(LocalLLMErrorCode.MODEL_UNAVAILABLE, "Selected model is not ready: ${availability.value}", null)
  }
  if (Feature.FUNCTION_CALLING !in availableFeatures()) {
    throw ToolNotSupportedException()
  }
}

internal suspend fun queryModelReadiness(
  checkStatus: suspend () -> Int,
  availableFeatures: suspend () -> List<Int>
): Map<String, String> {
  val availability = try {
    modelAvailability(checkStatus())
  } catch (error: CancellationException) { throw error }
  catch (_: Exception) { ModelAvailability.unknown }
  val tools = try {
    if (Feature.FUNCTION_CALLING in availableFeatures()) "available" else "unavailable"
  } catch (error: CancellationException) { throw error }
  catch (_: Exception) { "unknown" }
  return mapOf("availability" to availability.value, "tools" to tools)
}
