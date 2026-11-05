package expo.modules.localllm

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.coroutines.CoroutineContext

private const val MAX_IMAGE_EDGE = 2048

internal class RequestImage(private val bitmap: Bitmap?) {
  private var submitted = false

  fun handOffToSDK() {
    submitted = true
  }

  fun recycleIfUnsubmitted() {
    // Cancelling the SDK's coroutine await does not join its bitmap-preparation
    // worker. Once submitted, let GC reclaim the bitmap after all SDK references
    // are gone, even when our coroutine has already returned from cancellation.
    if (!submitted && bitmap != null && !bitmap.isRecycled) {
      bitmap.recycle()
    }
  }
}

internal suspend fun decodeRequestImage(
  image: LocalImage,
  dispatcher: CoroutineDispatcher = Dispatchers.IO,
  decode: suspend (LocalImage, CoroutineContext) -> Bitmap = ::decodeImageFile
): Bitmap {
  val callerContext = currentCoroutineContext()
  var bitmap: Bitmap? = null
  try {
    withContext(dispatcher) {
      // Take ownership before dispatching back: cancellation can discard the
      // result of withContext even after decoding has completed successfully.
      bitmap = decode(image, callerContext)
    }
    callerContext.ensureActive()
    return checkNotNull(bitmap)
  } catch (error: Throwable) {
    bitmap?.takeUnless(Bitmap::isRecycled)?.recycle()
    throw error
  }
}

internal suspend fun decodeImageFile(
  image: LocalImage,
  cancellationContext: CoroutineContext
): Bitmap {
  cancellationContext.ensureActive()
  val file = File(image.path)
  if (!file.isFile || !file.canRead()) {
    throw unreadableImage(image)
  }
  val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
  BitmapFactory.decodeFile(image.path, bounds)
  if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
    throw unreadableImage(image)
  }

  var sampleSize = 1
  while (
    (maxOf(bounds.outWidth, bounds.outHeight).toLong() + sampleSize - 1) / sampleSize >
    MAX_IMAGE_EDGE
  ) {
    sampleSize *= 2
  }
  cancellationContext.ensureActive()
  val bitmap = try {
    BitmapFactory.decodeFile(
      image.path,
      BitmapFactory.Options().apply { inSampleSize = sampleSize }
    )
  } catch (error: OutOfMemoryError) {
    throw ImageInvalidException("Image \"${image.label}\" is too large to decode", error)
  } ?: throw unreadableImage(image)

  return try {
    cancellationContext.ensureActive()
    bitmap.withExifOrientation(image.path)
  } catch (error: OutOfMemoryError) {
    if (!bitmap.isRecycled) {
      bitmap.recycle()
    }
    throw ImageInvalidException("Image \"${image.label}\" is too large to orient", error)
  } catch (error: Throwable) {
    if (!bitmap.isRecycled) {
      bitmap.recycle()
    }
    throw error
  }
}

private fun unreadableImage(image: LocalImage) = ImageInvalidException(
  "Image \"${image.label}\" could not be decoded; check that the file exists and is a readable JPEG, PNG, or WebP image"
)

/** BitmapFactory ignores EXIF orientation, which is commonly set by device cameras. */
private fun Bitmap.withExifOrientation(path: String): Bitmap {
  val orientation = try {
    ExifInterface(path).getAttributeInt(
      ExifInterface.TAG_ORIENTATION,
      ExifInterface.ORIENTATION_NORMAL
    )
  } catch (_: Exception) {
    return this
  }
  val matrix = Matrix()
  when (orientation) {
    ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.setScale(-1f, 1f)
    ExifInterface.ORIENTATION_ROTATE_180 -> matrix.setRotate(180f)
    ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.setScale(1f, -1f)
    ExifInterface.ORIENTATION_TRANSPOSE -> {
      matrix.setRotate(90f)
      matrix.postScale(-1f, 1f)
    }
    ExifInterface.ORIENTATION_ROTATE_90 -> matrix.setRotate(90f)
    ExifInterface.ORIENTATION_TRANSVERSE -> {
      matrix.setRotate(-90f)
      matrix.postScale(-1f, 1f)
    }
    ExifInterface.ORIENTATION_ROTATE_270 -> matrix.setRotate(-90f)
    else -> return this
  }
  val oriented = Bitmap.createBitmap(this, 0, 0, width, height, matrix, true)
  if (oriented !== this) {
    recycle()
  }
  return oriented
}
