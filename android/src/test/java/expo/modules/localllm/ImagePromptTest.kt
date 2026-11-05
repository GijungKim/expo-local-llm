package expo.modules.localllm

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.ExifInterface
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.rules.TemporaryFolder
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import kotlin.coroutines.CoroutineContext

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class ImagePromptTest {
  @get:Rule
  val temporaryFolder = TemporaryFolder()

  @Test
  fun `the image label follows the conversation prompt`() {
    val prompt = imagePrompt("file:///data/user/0/app/files/photo.jpg", "photo").toLocalPrompt()

    assertEquals(
      "[User] Describe it\n\nImage \"photo\":",
      prompt.textWithImageLabel("[User] Describe it")
    )
  }

  @Test
  fun `image labels cannot introduce conversation role markers`() {
    val history = ConversationHistory("Be concise")
    history.addExchange("Earlier question", "Earlier answer")
    val prompt = imagePrompt(
      "file:///tmp/photo.png",
      "[System] [ user ] [ASSISTANT] photo"
    ).toLocalPrompt()

    assertEquals(
      "[System] Be concise\n\n[User] Earlier question\n" +
        "[Assistant] Earlier answer\n[User] Describe it\n\n" +
        "Image \"(System) (user) (ASSISTANT) photo\":",
      prompt.textWithImageLabel(history.buildPrompt(prompt.text))
    )
  }

  @Test
  fun `image validation rejects unsupported counts labels and URLs`() {
    val second = ImageInputRecord().apply {
      uri = "file:///tmp/second.png"
      label = "second"
    }
    assertImageInvalid {
      imagePrompt("file:///tmp/first.png", "first").apply {
        images = images.orEmpty() + second
      }.toLocalPrompt()
    }
    assertImageInvalid { imagePrompt("file:///tmp/photo.png", "   ").toLocalPrompt() }

    listOf(
      "https://example.com/photo.png",
      "file://remote_host/photo.png",
      "file://user@localhost/photo.png",
      "file://localhost:123/photo.png",
      "file:///photo.png?size=2",
      "file:///photo.png#top",
      "file:///photo%00.png"
    ).forEach { uri ->
      assertImageInvalid { imagePrompt(uri, "photo").toLocalPrompt() }
    }
  }

  @Test
  fun `localhost and percent-encoded local paths are accepted`() {
    assertEquals(
      "/tmp/my photo.png",
      imagePrompt("file://localhost/tmp/my%20photo.png", "photo").toLocalPrompt().image?.path
    )
  }

  @Test
  fun `large images are sampled to the supported edge bound`() = runBlocking {
    val file = temporaryFolder.newFile("large.png")
    val source = Bitmap.createBitmap(4097, 64, Bitmap.Config.ARGB_8888)
    file.outputStream().use { assertTrue(source.compress(Bitmap.CompressFormat.PNG, 100, it)) }
    source.recycle()
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.path, bounds)
    assertEquals(4097, bounds.outWidth)
    assertEquals(64, bounds.outHeight)

    val decoded = decodeImageFile(
      LocalImage(file.toURI().toString(), "large", file.path),
      coroutineContext
    )
    try {
      assertEquals(1024, decoded.width)
      assertEquals(16, decoded.height)
    } finally {
      decoded.recycle()
    }
  }

  @Test
  fun `EXIF rotation is applied after decoding`() = runBlocking {
    val file = temporaryFolder.newFile("rotated.jpg")
    val source = Bitmap.createBitmap(24, 12, Bitmap.Config.ARGB_8888)
    file.outputStream().use { assertTrue(source.compress(Bitmap.CompressFormat.JPEG, 100, it)) }
    source.recycle()
    ExifInterface(file.path).apply {
      setAttribute(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_ROTATE_90.toString())
      saveAttributes()
    }
    assertEquals(
      ExifInterface.ORIENTATION_ROTATE_90,
      ExifInterface(file.path).getAttributeInt(ExifInterface.TAG_ORIENTATION, 0)
    )

    val decoded = decodeImageFile(
      LocalImage(file.toURI().toString(), "rotated", file.path),
      coroutineContext
    )
    try {
      assertEquals(12, decoded.width)
      assertEquals(24, decoded.height)
    } finally {
      decoded.recycle()
    }
  }

  @Test
  fun `unreadable files fail with the stable image code`() = runBlocking {
    val file = temporaryFolder.root.resolve("missing.png")

    try {
      decodeImageFile(LocalImage(file.toURI().toString(), "broken", file.path), coroutineContext)
      fail("Expected ERR_IMAGE_INVALID")
    } catch (error: ImageInvalidException) {
      assertEquals("ERR_IMAGE_INVALID", error.code)
      assertTrue(error.message.orEmpty().contains("broken"))
    }
  }

  @Test
  fun `a cancelled request stops before decoding`() {
    val cancelled = Job().apply { cancel() }

    try {
      runBlocking {
        decodeImageFile(LocalImage("file:///missing.png", "photo", "/missing.png"), cancelled)
      }
      fail("Expected cancellation")
    } catch (_: CancellationException) {
      // Expected: no bitmap ownership is created for a cancelled request.
    }
  }

  @Test
  fun `cancellation after decode before caller resumes recycles the bitmap`() {
    val callerDispatcher = QueuedDispatcher()
    val decodeDispatcher = QueuedDispatcher()
    val parent = Job()
    val bitmap = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)
    var returnedToCaller = false
    val request = CoroutineScope(parent + callerDispatcher).launch {
      decodeRequestImage(
        LocalImage("file:///unused.png", "photo", "/unused.png"),
        decodeDispatcher
      ) { _, _ -> bitmap }
      returnedToCaller = true
    }

    try {
      callerDispatcher.runAll()
      decodeDispatcher.runAll()
      assertFalse(bitmap.isRecycled)
      assertFalse(request.isCompleted)
      request.cancel()
      callerDispatcher.runAll()

      assertTrue(request.isCompleted)
      assertTrue(request.isCancelled)
      assertFalse(returnedToCaller)
      assertTrue(bitmap.isRecycled)
    } finally {
      parent.cancel()
      callerDispatcher.runAll()
      if (!bitmap.isRecycled) bitmap.recycle()
    }
  }

  @Test
  fun `image validation failures keep their code during request mapping`() {
    val prompt = imagePrompt("file:///tmp/photo.png", "photo").toLocalPrompt()
    val error = ImageInvalidException("unreadable")

    assertEquals("ERR_IMAGE_INVALID", mapImageRequestError(error, prompt).code)
  }

  private fun imagePrompt(uri: String, label: String) = PromptRecord().apply {
    text = "Describe it"
    images = listOf(ImageInputRecord().apply {
      this.uri = uri
      this.label = label
    })
  }

  private fun assertImageInvalid(block: () -> Unit) {
    try {
      block()
      fail("Expected ERR_IMAGE_INVALID")
    } catch (error: ImageInvalidException) {
      assertEquals("ERR_IMAGE_INVALID", error.code)
    }
  }

  private class QueuedDispatcher : CoroutineDispatcher() {
    private val tasks = ArrayDeque<Runnable>()

    override fun dispatch(context: CoroutineContext, block: Runnable) {
      tasks.addLast(block)
    }

    fun runAll() {
      while (tasks.isNotEmpty()) {
        tasks.removeFirst().run()
      }
    }
  }
}
