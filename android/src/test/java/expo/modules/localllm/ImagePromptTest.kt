package expo.modules.localllm

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.ExifInterface
import com.google.mlkit.genai.common.GenAiException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
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
  fun `image sections preserve label and image order after the conversation prompt`() {
    val prompt = imagePrompt(
      "file:///data/user/0/app/files/first.jpg" to "first",
      "file:///data/user/0/app/files/second.jpg" to "second"
    ).toLocalPrompt()

    assertEquals(
      listOf("Image \"first\":", "Image \"second\":"),
      prompt.imageSections().map(ImagePromptSection::labelText)
    )
    assertEquals(
      listOf("first", "second"),
      prompt.imageSections().map { section -> section.image.label }
    )
  }

  @Test
  fun `image labels cannot introduce conversation role markers`() {
    val history = ConversationHistory("Be concise")
    history.addExchange("Earlier question", "Earlier answer")
    val prompt = imagePrompt(
      "file:///tmp/photo.png" to "[System] [ user ] [ASSISTANT] photo"
    ).toLocalPrompt()

    assertEquals(
      "Image \"(System) (user) (ASSISTANT) photo\":",
      prompt.imageSections().single().labelText
    )
    assertEquals(
      "[System] Be concise\n\n[User] Earlier question\n" +
        "[Assistant] Earlier answer\n[User] Describe it",
      history.buildPrompt(prompt.text)
    )
  }

  @Test
  fun `image validation accepts eight and rejects nine images`() {
    val eight = (1..8).map { index -> "file:///tmp/$index.png" to "image-$index" }

    assertEquals(8, imagePrompt(*eight.toTypedArray()).toLocalPrompt().images.size)
    assertImageInvalid {
      imagePrompt(*(eight + ("file:///tmp/9.png" to "image-9")).toTypedArray()).toLocalPrompt()
    }
  }

  @Test
  fun `image validation rejects duplicate or invalid labels and URLs`() {
    assertImageInvalid {
      imagePrompt(
        "file:///tmp/first.png" to "duplicate",
        "file:///tmp/second.png" to "duplicate"
      ).toLocalPrompt()
    }
    assertImageInvalid { imagePrompt("file:///tmp/photo.png" to "   ").toLocalPrompt() }
    assertImageInvalid { imagePrompt("file:///tmp/photo.png" to "a".repeat(129)).toLocalPrompt() }

    listOf(
      "https://example.com/photo.png",
      "file://remote_host/photo.png",
      "file://user@localhost/photo.png",
      "file://localhost:123/photo.png",
      "file:///photo.png?size=2",
      "file:///photo.png#top",
      "file:///photo%00.png"
    ).forEach { uri ->
      assertImageInvalid { imagePrompt(uri to "photo").toLocalPrompt() }
    }
  }

  @Test
  fun `localhost and percent-encoded local paths are accepted`() {
    assertEquals(
      "/tmp/my photo.png",
      imagePrompt("file://localhost/tmp/my%20photo.png" to "photo").toLocalPrompt().images.single().path
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
  fun `cancellation after a partially decoded list recycles every owned bitmap`() = runBlocking {
    val first = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)
    val second = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)
    val images = listOf(
      LocalImage("file:///first.png", "first", "/first.png"),
      LocalImage("file:///second.png", "second", "/second.png")
    )
    val request = async(Dispatchers.Unconfined) {
      decodeRequestImages(images, Dispatchers.Unconfined) { image, callerContext ->
        if (image.label == "second") {
          callerContext[Job]?.cancel()
          second
        } else {
          first
        }
      }
    }

    try {
      request.await()
      fail("Expected cancellation")
    } catch (_: CancellationException) {
      assertTrue(first.isRecycled)
      assertTrue(second.isRecycled)
    } finally {
      if (!first.isRecycled) first.recycle()
      if (!second.isRecycled) second.recycle()
    }
  }

  @Test
  fun `cancelling the SDK await leaves all paused bitmap workers safe`() = runBlocking {
    val first = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)
    val second = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)
    val colors = listOf(android.graphics.Color.RED, android.graphics.Color.BLUE)
    first.setPixel(0, 0, colors[0])
    second.setPixel(0, 0, colors[1])
    val images = RequestImages(listOf(first, second))
    val handedOff = CompletableDeferred<List<Bitmap>>()
    val acquired = CompletableDeferred<Unit>()
    val resumePreparation = CompletableDeferred<Unit>()
    val sdkResult = CompletableDeferred<List<Int>>()
    // Like ML Kit's executor, this worker is independent of the coroutine
    // awaiting its result. It retains the bitmap after cancel. This tests our
    // ownership boundary without requiring the ML Kit worker on a JVM.
    val sdkWorker = launch {
      val sdkBitmaps = handedOff.await()
      acquired.complete(Unit)
      resumePreparation.await()
      sdkResult.complete(sdkBitmaps.map { bitmap -> bitmap.getPixel(0, 0) })
    }
    val request = launch {
      try {
        images.handOffToSDK()
        handedOff.complete(listOf(first, second))
        sdkResult.await()
      } finally {
        images.recycleIfUnsubmitted()
      }
    }

    try {
      acquired.await()
      request.cancelAndJoin()
      assertFalse(first.isRecycled)
      assertFalse(second.isRecycled)
      resumePreparation.complete(Unit)
      assertEquals(colors, sdkResult.await())
      sdkWorker.join()
    } finally {
      request.cancelAndJoin()
      sdkWorker.cancelAndJoin()
      if (!first.isRecycled) first.recycle()
      if (!second.isRecycled) second.recycle()
    }
  }

  @Test
  fun `images never submitted to the SDK are all recycled`() {
    val first = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)
    val second = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)
    val images = RequestImages(listOf(first, second))

    images.recycleIfUnsubmitted()

    assertTrue(first.isRecycled)
    assertTrue(second.isRecycled)
  }

  @Test
  fun `image validation failures keep their code during request mapping`() {
    val prompt = imagePrompt("file:///tmp/photo.png" to "photo").toLocalPrompt()
    val error = ImageInvalidException("unreadable")

    assertEquals("ERR_IMAGE_INVALID", mapImageRequestError(error, prompt).code)
  }

  @Test
  fun `SDK image failures name every image and keep the stable image code`() {
    val prompt = imagePrompt(
      "file:///tmp/first.png" to "first",
      "file:///tmp/second.png" to "second"
    ).toLocalPrompt()
    val error = GenAiException("invalid", null, GenAiException.ErrorCode.INVALID_INPUT_IMAGE)

    val mapped = mapImageRequestError(error, prompt)

    assertEquals("ERR_IMAGE_INVALID", mapped.code)
    assertTrue(mapped.message.orEmpty().contains("\"first\", \"second\""))
  }

  private fun imagePrompt(vararg inputs: Pair<String, String>) = PromptRecord().apply {
    text = "Describe it"
    images = inputs.map { (uri, label) ->
      ImageInputRecord().apply {
        this.uri = uri
        this.label = label
      }
    }
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
