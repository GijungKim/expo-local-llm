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
  val image: LocalImage? = null
) {
  fun textWithImageLabel(fullText: String): String =
    image?.let { "$fullText\n\nImage \"${ConversationHistory.neutralise(it.label)}\":" } ?: fullText
}

internal fun Either<String, PromptRecord>.toLocalPrompt(): LocalPrompt =
  if (`is`(String::class)) {
    LocalPrompt(get(String::class))
  } else {
    get(PromptRecord::class).toLocalPrompt()
  }

internal fun PromptRecord.toLocalPrompt(): LocalPrompt {
  val inputs = images.orEmpty()
  if (inputs.size > 1) {
    throw ImageInvalidException(
      "This Android version accepts one image per request; send additional images in separate requests"
    )
  }
  val input = inputs.singleOrNull() ?: return LocalPrompt(text)
  val label = input.label
  if (label.isBlank() || label.length > 128 || label.any(Char::isISOControl)) {
    throw ImageInvalidException("Image labels must contain 1–128 characters without control characters")
  }
  return LocalPrompt(text, LocalImage(input.uri, label, localFilePath(input.uri, label)))
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
