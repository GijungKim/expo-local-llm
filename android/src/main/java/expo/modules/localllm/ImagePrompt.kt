package expo.modules.localllm

import expo.modules.kotlin.types.Either
import java.net.URI

internal data class LocalImage(
  val uri: String,
  val label: String,
  val path: String
)

internal data class LocalPrompt(
  val text: String,
  val images: List<LocalImage> = emptyList()
) {
  fun imageSections(): List<ImagePromptSection> = images.map { image ->
    ImagePromptSection(
      labelText = "Image \"${ConversationHistory.neutralise(image.label)}\":",
      image = image
    )
  }
}

internal data class ImagePromptSection(
  val labelText: String,
  val image: LocalImage
)

internal fun Either<String, PromptRecord>.toLocalPrompt(): LocalPrompt =
  if (`is`(String::class)) {
    LocalPrompt(get(String::class))
  } else {
    get(PromptRecord::class).toLocalPrompt()
  }

internal fun PromptRecord.toLocalPrompt(): LocalPrompt {
  val inputs = images.orEmpty()
  if (inputs.size > 8) {
    throw ImageInvalidException(
      "This version accepts up to eight images per request"
    )
  }
  val labels = mutableSetOf<String>()
  val localImages = inputs.map { input ->
    val label = input.label
    if (label.isBlank() || label.length > 128 || label.any(Char::isISOControl)) {
      throw ImageInvalidException("Image labels must contain 1–128 characters without control characters")
    }
    if (!labels.add(label)) {
      throw ImageInvalidException("Image labels must be unique within a request")
    }
    LocalImage(input.uri, label, localFilePath(input.uri, label))
  }
  return LocalPrompt(text, localImages)
}

private fun localFilePath(uriString: String, label: String): String {
  if (
    !uriString.startsWith("file://") ||
    uriString.any { it == '?' || it == '#' || it.isISOControl() }
  ) {
    throw invalidImageUri(label)
  }
  val uri = try {
    URI(uriString)
  } catch (_: Exception) {
    throw invalidImageUri(label)
  }
  if (
    uri.scheme != "file" ||
    (!uri.rawAuthority.isNullOrEmpty() && uri.rawAuthority != "localhost") ||
    uri.rawQuery != null ||
    uri.rawFragment != null
  ) {
    throw invalidImageUri(label)
  }
  val path = uri.path?.takeIf(String::isNotEmpty) ?: throw invalidImageUri(label)
  if (!path.startsWith('/') || path.any(Char::isISOControl)) {
    throw invalidImageUri(label)
  }
  return path
}

private fun invalidImageUri(label: String) = ImageInvalidException(
  "Image \"$label\" must use a local file:// URL without a query, fragment, or control characters"
)
