package expo.modules.localllm

import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.common.FunctionArgValue
import com.google.mlkit.genai.common.FunctionCall
import com.google.mlkit.genai.common.StreamingCallback
import com.google.mlkit.genai.prompt.Candidate
import com.google.mlkit.genai.prompt.Feature
import com.google.mlkit.genai.prompt.GenerateContentRequest
import com.google.mlkit.genai.prompt.GenerateContentResponse
import com.google.mlkit.genai.prompt.TextPart
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class LLMSessionIntegrationTest {
  private data class Event(val name: String, val body: Map<String, Any?>)

  private class ScriptedModel(
    responses: List<GenerateContentResponse> = emptyList(),
    streams: List<List<GenerateContentResponse>> = emptyList(),
    callbackTexts: List<List<String>> = emptyList(),
    private val lateCallback: (suspend (StreamingCallback) -> Unit)? = null
  ) : SessionModel {
    private val responses = ArrayDeque(responses)
    private val streams = ArrayDeque(streams)
    private val callbackTexts = ArrayDeque(callbackTexts)
    val requests = mutableListOf<GenerateContentRequest>()
    var closeCount = 0

    override suspend fun checkStatus() = FeatureStatus.AVAILABLE
    override suspend fun getAvailableFeatures() = listOf(Feature.FUNCTION_CALLING)

    override suspend fun generateContent(request: GenerateContentRequest): GenerateContentResponse {
      requests += request
      return responses.removeFirst()
    }

    override suspend fun generateContent(
      request: GenerateContentRequest,
      callback: StreamingCallback
    ): GenerateContentResponse {
      requests += request
      callbackTexts.removeFirstOrNull().orEmpty().forEach(callback::onNewText)
      lateCallback?.let { callbackWork ->
        CoroutineScope(Dispatchers.Unconfined).async { callbackWork(callback) }
      }
      return responses.removeFirst()
    }

    override fun generateContentStream(request: GenerateContentRequest): Flow<GenerateContentResponse> {
      requests += request
      val chunks = streams.removeFirst()
      return flow { chunks.forEach { emit(it) } }
    }

    override fun close() { closeCount++ }
  }

  private class BlockingModel : SessionModel {
    val entered = CompletableDeferred<Unit>()
    val cleanupStarted = CompletableDeferred<Unit>()
    val allowCleanup = CompletableDeferred<Unit>()
    var closeCount = 0

    override suspend fun checkStatus() = FeatureStatus.AVAILABLE
    override suspend fun getAvailableFeatures() = emptyList<Int>()
    override suspend fun generateContent(request: GenerateContentRequest): GenerateContentResponse {
      entered.complete(Unit)
      try {
        CompletableDeferred<Unit>().await()
      } finally {
        cleanupStarted.complete(Unit)
        withContext(NonCancellable) { allowCleanup.await() }
      }
      error("unreachable")
    }

    override suspend fun generateContent(
      request: GenerateContentRequest,
      callback: StreamingCallback
    ) = generateContent(request)

    override fun generateContentStream(request: GenerateContentRequest): Flow<GenerateContentResponse> =
      flow { emit(generateContent(request)) }

    override fun close() { closeCount++ }
  }

  private class CancellableStreamModel(
    private val partial: GenerateContentResponse,
    private val recovery: GenerateContentResponse
  ) : SessionModel {
    val partialEmitted = CompletableDeferred<Unit>()
    val requests = mutableListOf<GenerateContentRequest>()

    override suspend fun checkStatus() = FeatureStatus.AVAILABLE
    override suspend fun getAvailableFeatures() = emptyList<Int>()
    override suspend fun generateContent(request: GenerateContentRequest): GenerateContentResponse {
      requests += request
      return recovery
    }
    override suspend fun generateContent(
      request: GenerateContentRequest,
      callback: StreamingCallback
    ) = generateContent(request)
    override fun generateContentStream(request: GenerateContentRequest): Flow<GenerateContentResponse> = flow {
      requests += request
      emit(partial)
      partialEmitted.complete(Unit)
      CompletableDeferred<Unit>().await()
    }
    override fun close() = Unit
  }

  private class FailingStreamModel(
    private val recovery: GenerateContentResponse
  ) : SessionModel {
    val requests = mutableListOf<GenerateContentRequest>()

    override suspend fun checkStatus() = FeatureStatus.AVAILABLE
    override suspend fun getAvailableFeatures() = emptyList<Int>()
    override suspend fun generateContent(request: GenerateContentRequest): GenerateContentResponse {
      requests += request
      return recovery
    }
    override suspend fun generateContent(
      request: GenerateContentRequest,
      callback: StreamingCallback
    ) = generateContent(request)
    override fun generateContentStream(request: GenerateContentRequest): Flow<GenerateContentResponse> = flow {
      requests += request
      throw IllegalStateException("SDK failed")
    }
    override fun close() = Unit
  }

  private fun response(
    text: String,
    calls: List<FunctionCall> = emptyList(),
    finishReason: Int? = Candidate.FinishReason.STOP
  ) = SessionFixtures.response(SessionFixtures.candidate(text, calls, finishReason))

  private fun tool() = ToolConfig().apply {
    name = "lookup"
    description = "Look up a value"
    parameters = mapOf("query" to mapOf("type" to "string", "description" to "Query"))
  }

  private fun config(vararg tools: ToolConfig) = SessionConfig().apply {
    this.tools = tools.toList()
    toolTimeout = 5.0
  }

  private fun session(
    config: SessionConfig,
    models: ArrayDeque<SessionModel>,
    events: MutableList<Event> = mutableListOf()
  ) = LLMSession.createForTesting(
    config,
    SessionRuntime(
      createModel = { models.removeFirst() },
      emit = { name, body -> events += Event(name, body) },
      coroutineContext = Dispatchers.Unconfined
    )
  )

  private fun integrationTest(block: suspend CoroutineScope.() -> Unit) = runBlocking {
    withTimeout(10_000) { block() }
  }

  @Test fun `respond and flow streaming use real requests commit history and emit one terminal event`() = integrationTest {
    val model = ScriptedModel(
      responses = listOf(response("first answer"), response("after stream")),
      streams = listOf(listOf(response("hello "), response("world")))
    )
    val events = mutableListOf<Event>()
    val session = session(config(), ArrayDeque(listOf(model)), events)

    assertEquals("first answer", session.respond(LocalPrompt("first question"), "respond-id"))
    assertEquals("hello world", session.streamResponse(LocalPrompt("second question"), "stream-id"))
    assertEquals("after stream", session.respond(LocalPrompt("third question")))

    assertEquals(3, model.requests.size)
    val secondPrompt = (model.requests[1].contents.single().parts.single() as TextPart).textString
    assertTrue(secondPrompt.contains("[User] first question"))
    assertTrue(secondPrompt.contains("[Assistant] first answer"))
    val thirdPrompt = (model.requests[2].contents.single().parts.single() as TextPart).textString
    assertTrue(thirdPrompt.contains("[Assistant] hello world"))
    assertEquals(listOf("token", "token", "streamComplete"), events.map(Event::name))
    assertEquals("hello world", events.last().body["text"])
    assertEquals("stream-id", events.last().body["requestId"])
  }

  @Test fun `tool stream reconciles final-only callback-prefix and complete terminal text`() = integrationTest {
    suspend fun generate(callback: List<String>, terminal: String): Pair<String, List<Event>> {
      val model = ScriptedModel(
        responses = listOf(response(terminal)),
        callbackTexts = listOf(callback)
      )
      val events = mutableListOf<Event>()
      val session = session(config(tool()), ArrayDeque(listOf(model)), events)
      return session.streamResponse(LocalPrompt("question"), "request") to events
    }

    val (finalOnly, finalOnlyEvents) = generate(emptyList(), "complete")
    assertEquals("complete", finalOnly)
    assertEquals(listOf("complete"), finalOnlyEvents.filter { it.name == "token" }.map { it.body["token"] })

    val (prefix, prefixEvents) = generate(listOf("hel"), "hello")
    assertEquals("hello", prefix)
    assertEquals(listOf("hel", "lo"), prefixEvents.filter { it.name == "token" }.map { it.body["token"] })

    val (complete, completeEvents) = generate(listOf("hello"), "hello")
    assertEquals("hello", complete)
    assertEquals(listOf("hello"), completeEvents.filter { it.name == "token" }.map { it.body["token"] })
    assertEquals(1, completeEvents.count { it.name == "streamComplete" })

    val divergentModel = ScriptedModel(
      responses = listOf(response("terminal")),
      callbackTexts = listOf(listOf("different"))
    )
    val divergentEvents = mutableListOf<Event>()
    val divergentSession = session(config(tool()), ArrayDeque(listOf(divergentModel)), divergentEvents)
    assertEquals("terminal", divergentSession.streamResponse(LocalPrompt("question")))
    assertEquals(listOf("token", "token", "streamComplete"), divergentEvents.map(Event::name))
    assertEquals("", divergentEvents[1].body["token"])
    assertEquals("terminal", divergentEvents[1].body["accumulated"])
  }

  @Test fun `tool streaming reconciles multiple rounds and empty final lead-in`() = integrationTest {
    for (leadIn in listOf("checking", "")) {
      val call = FunctionCall("lookup", mapOf("query" to FunctionArgValue.StringValue("weather")), "call")
      val model = ScriptedModel(
        responses = listOf(response(leadIn, listOf(call)), response("sunny"), response("later")),
        callbackTexts = listOf(listOf("chec"), emptyList())
      )
      val events = mutableListOf<Event>()
      val session = session(config(tool()), ArrayDeque(listOf(model)), events)
      val pending = async(start = CoroutineStart.UNDISPATCHED) {
        session.streamResponse(LocalPrompt("weather?"))
      }
      session.resolveToolCall(events.single { it.name == "toolCall" }.body.getValue("callId") as String, "72 F")
      assertEquals(leadIn + "sunny", pending.await())
      assertEquals(listOf("chec", if (leadIn.isEmpty()) "" else "king", "sunny"),
        events.filter { it.name == "token" }.map { it.body["token"] })
      assertEquals(leadIn + "sunny", events.single { it.name == "streamComplete" }.body["text"])
      assertEquals("later", session.respond(LocalPrompt("again")))
      val historyText = model.requests.last().contents.flatMap { it.parts }.filterIsInstance<TextPart>()
        .joinToString { it.textString }
      assertTrue(historyText.contains("sunny"))
      session.sharedObjectDidRelease()
    }
  }

  @Test fun `cancelStream while tool handler is pending returns partial without completion`() = integrationTest {
    val call = FunctionCall("lookup", mapOf("query" to FunctionArgValue.StringValue("weather")), "call")
    val model = ScriptedModel(
      responses = listOf(response("checking", listOf(call)), response("recovered")),
      callbackTexts = listOf(listOf("chec"))
    )
    val events = mutableListOf<Event>()
    val session = session(config(tool()), ArrayDeque(listOf(model)), events)
    val pending = async(start = CoroutineStart.UNDISPATCHED) {
      session.streamResponse(LocalPrompt("weather?"))
    }
    val callId = events.single { it.name == "toolCall" }.body.getValue("callId") as String
    session.cancelStream()
    assertEquals("checking", pending.await())
    assertFalse(events.any { it.name == "streamComplete" || it.name == "streamError" })
    assertThrows(ToolNotFoundException::class.java) { session.resolveToolCall(callId, "late") }
    assertEquals("recovered", session.respond(LocalPrompt("again")))
    assertEquals(2, model.requests.size)
    session.sharedObjectDidRelease()
  }

  @Test fun `closed callback drops late text after terminal response`() = integrationTest {
    val releaseLateText = CompletableDeferred<Unit>()
    val lateAttempted = CompletableDeferred<Unit>()
    val model = ScriptedModel(
      responses = listOf(response("done")),
      callbackTexts = listOf(listOf("done")),
      lateCallback = { callback ->
        releaseLateText.await()
        callback.onNewText(" late")
        lateAttempted.complete(Unit)
      }
    )
    val events = mutableListOf<Event>()
    val session = session(config(tool()), ArrayDeque(listOf(model)), events)

    assertEquals("done", session.streamResponse(LocalPrompt("question")))
    releaseLateText.complete(Unit)
    lateAttempted.await()
    assertEquals(listOf("token", "streamComplete"), events.map(Event::name))
    assertEquals("done", events.last().body["text"])
  }

  @Test fun `tool dispatch spans rounds and registration transitions replace owned models`() = integrationTest {
    val plain = ScriptedModel(responses = listOf(response("plain")))
    val call = FunctionCall(
      "lookup",
      mapOf("query" to FunctionArgValue.StringValue("weather")),
      "sdk-call"
    )
    val tooled = ScriptedModel(responses = listOf(response("checking", listOf(call)), response("sunny")))
    val afterUnregister = ScriptedModel(responses = listOf(response("still contextual")))
    val models = ArrayDeque<SessionModel>(listOf(plain, tooled, afterUnregister))
    val events = mutableListOf<Event>()
    val session = session(config(), models, events)

    assertEquals("plain", session.respond(LocalPrompt("hello")))
    session.registerTool(tool())
    assertEquals(1, plain.closeCount)

    val generated = async(start = CoroutineStart.UNDISPATCHED) {
      session.respond(LocalPrompt("weather?"), "tools")
    }
    val toolEvent = events.single { it.name == "toolCall" }
    assertEquals("lookup", toolEvent.body["toolName"])
    assertEquals(mapOf("query" to "weather"), toolEvent.body["arguments"])
    session.resolveToolCall(toolEvent.body.getValue("callId") as String, "72 F")
    assertEquals("checkingsunny", generated.await())
    assertEquals(2, tooled.requests.size)
    assertEquals(1, tooled.requests.first().dynamicTools.orEmpty().size)
    assertTrue(tooled.requests.last().contents.size >= 4)

    session.unregisterTool("lookup")
    assertEquals(1, tooled.closeCount)
    assertEquals("still contextual", session.respond(LocalPrompt("again")))
    assertTrue(afterUnregister.requests.single().dynamicTools.orEmpty().isEmpty())
    session.sharedObjectDidRelease()
    assertEquals(1, afterUnregister.closeCount)
  }

  @Test fun `reset cancellation retains busy slot and model ownership until producer cleanup`() = integrationTest {
    val blocking = BlockingModel()
    val replacement = ScriptedModel(responses = listOf(response("fresh")))
    val session = session(config(), ArrayDeque(listOf(blocking, replacement)))
    val pending = async { session.respond(LocalPrompt("blocked")) }
    blocking.entered.await()

    session.reset()
    blocking.cleanupStarted.await()
    assertEquals(0, blocking.closeCount)
    assertThrows(SessionBusyException::class.java) {
      runBlocking { session.respond(LocalPrompt("too soon")) }
    }
    blocking.allowCleanup.complete(Unit)
    try {
      pending.await()
      fail("Expected cancellation")
    } catch (_: CancellationException) { }
    assertEquals(1, blocking.closeCount)
    assertEquals("fresh", session.respond(LocalPrompt("new conversation")))
    val prompt = (replacement.requests.single().contents.single().parts.single() as TextPart).textString
    assertFalse(prompt.contains("blocked"))
  }

  @Test fun `release during delayed cleanup is permanent and closes the model exactly once`() = integrationTest {
    val blocking = BlockingModel()
    val session = session(config(), ArrayDeque(listOf(blocking)))
    val pending = async { session.respond(LocalPrompt("blocked")) }
    blocking.entered.await()

    session.sharedObjectDidRelease()
    blocking.cleanupStarted.await()
    assertEquals(0, blocking.closeCount)
    assertThrows(SessionInvalidException::class.java) {
      runBlocking { session.respond(LocalPrompt("after release")) }
    }
    blocking.allowCleanup.complete(Unit)
    try {
      pending.await()
      fail("Expected cancellation")
    } catch (_: CancellationException) { }
    assertEquals(1, blocking.closeCount)
    session.sharedObjectDidRelease()
    assertEquals(1, blocking.closeCount)
  }

  @Test fun `reset and registration cancel pending tool handler and reject stale resolution`() = integrationTest {
    suspend fun verifyInvalidation(invalidate: (LLMSession) -> Unit) {
      val call = FunctionCall(
        "lookup",
        mapOf("query" to FunctionArgValue.StringValue("value")),
        null
      )
      val model = ScriptedModel(responses = listOf(response("", listOf(call))))
      val events = mutableListOf<Event>()
      val session = session(config(tool()), ArrayDeque(listOf(model)), events)
      val pending = async(start = CoroutineStart.UNDISPATCHED) {
        session.respond(LocalPrompt("question"))
      }
      val callId = events.single { it.name == "toolCall" }.body.getValue("callId") as String
      invalidate(session)
      try { pending.await(); fail("Expected cancellation") } catch (_: CancellationException) { }
      assertThrows(ToolNotFoundException::class.java) { session.resolveToolCall(callId, "late") }
      assertEquals(1, model.closeCount)
    }

    verifyInvalidation(LLMSession::reset)
    verifyInvalidation { it.unregisterTool("lookup") }
  }

  @Test fun `availability operations serialize per model without blocking another selection`() = integrationTest {
    val firstEntered = CompletableDeferred<Unit>()
    val releaseFirst = CompletableDeferred<Unit>()
    val first = async(start = CoroutineStart.UNDISPATCHED) {
      LLMSession.withAvailabilityLock(AndroidModel.DEFAULT) {
        firstEntered.complete(Unit)
        releaseFirst.await()
      }
    }
    firstEntered.await()
    val sameModel = async(start = CoroutineStart.UNDISPATCHED) {
      LLMSession.withAvailabilityLock(AndroidModel.DEFAULT) { "same" }
    }
    val otherModel = async(start = CoroutineStart.UNDISPATCHED) {
      LLMSession.withAvailabilityLock(AndroidModel.PREVIEW_FAST) { "other" }
    }

    assertEquals("other", otherModel.await())
    assertFalse(sameModel.isCompleted)
    releaseFirst.complete(Unit)
    first.await()
    assertEquals("same", sameModel.await())
  }

  @Test fun `cancel stream returns partial without terminal event or history commit then recovers`() = integrationTest {
    val model = CancellableStreamModel(response("partial"), response("recovered"))
    val events = mutableListOf<Event>()
    val session = session(config(), ArrayDeque(listOf(model)), events)
    val stream = async(start = CoroutineStart.UNDISPATCHED) {
      session.streamResponse(LocalPrompt("cancelled question"), "cancelled")
    }
    model.partialEmitted.await()

    session.cancelStream()
    assertEquals("partial", stream.await())
    assertEquals(listOf("token"), events.map(Event::name))
    assertEquals("recovered", session.respond(LocalPrompt("next question")))
    val nextPrompt = (model.requests.last().contents.single().parts.single() as TextPart).textString
    assertFalse(nextPrompt.contains("cancelled question"))
    assertTrue(nextPrompt.contains("next question"))
  }

  @Test fun `stream SDK failure emits one error no completion and leaves session reusable`() = integrationTest {
    val model = FailingStreamModel(response("recovered"))
    val events = mutableListOf<Event>()
    val session = session(config(), ArrayDeque(listOf(model)), events)

    try {
      session.streamResponse(LocalPrompt("failed question"), "failed")
      fail("Expected generation failure")
    } catch (error: GenerationException) {
      assertEquals("ERR_GENERATION_FAILED", error.code)
      assertTrue(error.message.orEmpty().contains("SDK failed"))
    }
    assertEquals(listOf("streamError"), events.map(Event::name))
    assertEquals("failed", events.single().body["requestId"])
    assertEquals("recovered", session.respond(LocalPrompt("next question")))
    val nextPrompt = (model.requests.last().contents.single().parts.single() as TextPart).textString
    assertFalse(nextPrompt.contains("failed question"))
  }

  @Test fun `invalid tool batch rejects before dispatch and the next request recovers`() = integrationTest {
    val valid = FunctionCall(
      "lookup",
      mapOf("query" to FunctionArgValue.StringValue("value")),
      "valid"
    )
    val unknown = FunctionCall(
      "unknown",
      mapOf("query" to FunctionArgValue.StringValue("value")),
      "unknown"
    )
    val model = ScriptedModel(
      responses = listOf(response("", listOf(valid, unknown)), response("recovered"))
    )
    val events = mutableListOf<Event>()
    val session = session(config(tool()), ArrayDeque(listOf(model)), events)

    assertThrows(ToolFailedException::class.java) {
      runBlocking { session.respond(LocalPrompt("bad batch")) }
    }
    assertTrue(events.none { it.name == "toolCall" })
    assertEquals("recovered", session.respond(LocalPrompt("next question")))
  }
}
