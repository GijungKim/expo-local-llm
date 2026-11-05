package expo.modules.localllm

import com.google.mlkit.genai.common.FunctionArgValue
import com.google.mlkit.genai.common.FunctionCall
import com.google.mlkit.genai.prompt.Candidate
import com.google.mlkit.genai.prompt.FunctionCallPart
import com.google.mlkit.genai.prompt.FunctionResponsePart
import com.google.mlkit.genai.prompt.TextPart
import com.google.mlkit.genai.schema.tools.FunctionType
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class NativeToolsTest {
  private fun config() = ToolConfig().apply {
    name = "lookup"
    description = "Look up a value"
    parameters = linkedMapOf(
      "unit" to mapOf("type" to "string", "description" to "Unit", "enum" to listOf("C", "F")),
      "count" to mapOf("type" to "number", "description" to "Count"),
      "enabled" to mapOf("type" to "boolean", "description" to "Enabled")
    )
  }
  private fun call(id: String? = null) = FunctionCall("lookup", linkedMapOf(
    "unit" to FunctionArgValue.StringValue("C"),
    "count" to FunctionArgValue.LongValue(42),
    "enabled" to FunctionArgValue.BoolValue(true)
  ), id)
  private fun withArguments(arguments: Map<String, FunctionArgValue>) = FunctionCall("lookup", arguments, null)
  private val stop = Candidate.FinishReason.STOP

  @Test fun `declaration translates primitives and requires every field`() {
    val declaration = NativeTool(config()).declaration
    assertEquals("lookup", declaration.name)
    val schema = requireNotNull(declaration.parameters)
    assertEquals(FunctionType.OBJECT, schema.type)
    assertEquals(listOf("unit", "count", "enabled"), schema.required)
    assertEquals(listOf("C", "F"), schema.properties?.get("unit")?.enum)
    assertEquals(FunctionType.NUMBER, schema.properties?.get("count")?.type)
    assertEquals(FunctionType.BOOLEAN, schema.properties?.get("enabled")?.type)
  }

  @Test fun `invalid declarations fail before generation`() {
    listOf(
      config().apply { name = "bad name" },
      config().apply { parameters = mapOf("bad" to mapOf("type" to "object", "description" to "x")) },
      config().apply { parameters = mapOf("bad" to mapOf("type" to "number", "description" to "x", "enum" to listOf("x"))) },
      config().apply { parameters = mapOf("bad" to mapOf("type" to "string", "description" to "x", "enum" to emptyList<String>())) },
      config().apply { parameters = mapOf("bad" to mapOf("type" to "string", "description" to "x", "enum" to listOf("x", "x"))) },
      config().apply { parameters = mapOf("bad" to mapOf("type" to "string")) }
    ).forEach { invalid -> assertThrows(ToolInvalidException::class.java) { NativeTool(invalid) } }
    assertThrows(ToolInvalidException::class.java) { NativeTool.declarations(listOf(config(), config())) }
    assertTrue(NativeTool(config().apply { parameters = emptyMap() }).declaration.parameters?.required.orEmpty().isEmpty())
  }

  @Test fun `arguments enforce exact keys types enums finite numbers and safe longs`() {
    val tool = NativeTool(config())
    assertEquals(mapOf("unit" to "C", "count" to 42L, "enabled" to true), tool.arguments(call()))
    val invalid = listOf(
      ToolCallFixtures.withNullArgument(call(), "count"),
      withArguments(call().arguments - "count"),
      withArguments(call().arguments + ("extra" to FunctionArgValue.StringValue("x"))),
      withArguments(call().arguments + ("unit" to FunctionArgValue.StringValue("K"))),
      withArguments(call().arguments + ("enabled" to FunctionArgValue.StringValue("true"))),
      withArguments(call().arguments + ("count" to FunctionArgValue.DoubleValue(Double.NaN))),
      withArguments(call().arguments + ("count" to FunctionArgValue.DoubleValue(Double.POSITIVE_INFINITY))),
      withArguments(call().arguments + ("count" to FunctionArgValue.LongValue(9007199254740992))),
      withArguments(call().arguments + ("count" to FunctionArgValue.MapValue(emptyMap()))),
      withArguments(call().arguments + ("count" to FunctionArgValue.ListValue(emptyList())))
    )
    invalid.forEach { assertThrows(ToolFailedException::class.java) { tool.arguments(it) } }
    listOf(FunctionArgValue.IntValue(7), FunctionArgValue.DoubleValue(0.5), FunctionArgValue.LongValue(-9007199254740991)).forEach {
      tool.arguments(withArguments(call().arguments + ("count" to it)))
    }
  }

  @Test fun `whole terminal batch is validated before any callback including truncation`() = runBlocking<Unit> {
    val tools = NativeTool.declarations(listOf(config()))
    var delivered = 0
    for (reason in listOf(stop, Candidate.FinishReason.MAX_TOKENS, Candidate.FinishReason.OTHER, null)) {
      try {
        val batch = ToolBudget().validateBatch(listOf(call(), FunctionCall("unknown", call().arguments, null)), tools, reason)
        serviceToolBatch(batch, PendingToolCalls(), 100) { _, _ -> delivered++ }
        fail("Must reject entire batch")
      } catch (_: ToolFailedException) { }
    }
    assertEquals(0, delivered)
    assertThrows(ToolFailedException::class.java) {
      ToolBudget().validateBatch(listOf(call()), tools, Candidate.FinishReason.MAX_TOKENS)
    }
  }

  @Test fun `limits allow eight tool rounds and thirty two total calls`() {
    val tools = NativeTool.declarations(listOf(config()))
    val rounds = ToolBudget()
    repeat(8) { rounds.validateBatch(listOf(call()), tools, stop) }
    assertTrue(rounds.validateBatch(emptyList(), tools, stop).isEmpty())
    assertThrows(ToolFailedException::class.java) { rounds.validateBatch(listOf(call()), tools, stop) }
    assertThrows(ToolFailedException::class.java) {
      ToolBudget().validateBatch(listOf(call("duplicate"), call("duplicate")), tools, stop)
    }
    val calls = ToolBudget()
    calls.validateBatch(List(32) { call() }, tools, stop)
    assertThrows(ToolFailedException::class.java) { calls.validateBatch(listOf(call()), tools, stop) }
    assertThrows(ToolFailedException::class.java) { ToolBudget().validateBatch(List(33) { call() }, tools, stop) }
  }

  @Test fun `replayed SDK ids reject the whole later round before dispatch`() = runBlocking<Unit> {
    val tools = NativeTool.declarations(listOf(config()))
    val budget = ToolBudget()
    val pending = PendingToolCalls()
    val delivered = mutableListOf<String?>()
    suspend fun round(calls: List<FunctionCall>) {
      val batch = budget.validateBatch(calls, tools, stop)
      serviceToolBatch(batch, pending, 1000) { id, validated ->
        delivered.add(validated.call.id)
        pending.resolve(id, "done")
      }
    }
    round(listOf(call("first"), call()))
    round(listOf(call("second"), call()))
    try {
      round(listOf(call("new"), call("first")))
      fail("Repeated ID must reject the entire round")
    } catch (_: ToolFailedException) { }
    assertEquals(listOf("first", null, "second", null), delivered)
    // SDK IDs are scoped to the outer generation, not the lifetime of the session.
    assertEquals(1, ToolBudget().validateBatch(listOf(call("first")), tools, stop).size)
  }

  @Test fun `null SDK ids use independent bridge UUIDs with immediate ordered opaque results`() = runBlocking<Unit> {
    val pending = PendingToolCalls()
    val batch = ToolBudget().validateBatch(listOf(call(), call("sdk-id")), NativeTool.declarations(listOf(config())), stop)
    val bridgeIds = mutableListOf<String>()
    val results = serviceToolBatch(batch, pending, 1000) { id, _ ->
      bridgeIds.add(id)
      assertTrue(pending.resolve(id, "{\"literal\":${bridgeIds.size}}"))
      assertFalse(pending.resolve(id, "duplicate"))
    }.content().parts.map { it as FunctionResponsePart }
    assertEquals(2, bridgeIds.distinct().size)
    assertFalse("sdk-id" in bridgeIds)
    assertNull(results[0].id)
    assertEquals("sdk-id", results[1].id)
    assertEquals(mapOf("result" to "{\"literal\":1}"), results[0].response)
    assertEquals(mapOf("result" to "{\"literal\":2}"), results[1].response)
    val model = modelToolContent("looking up", batch.map { it.call })
    assertEquals("looking up", (model.parts[0] as TextPart).textString)
    assertEquals(call(), (model.parts[1] as FunctionCallPart).functionCall)
  }

  @Test fun `handler failure timeout cancellation and closed generations reject stale results`() = runBlocking<Unit> {
    val batch = ToolBudget().validateBatch(listOf(call(), call()), NativeTool.declarations(listOf(config())), stop)
    var deliveries = 0
    val pending = PendingToolCalls()
    var oldId = ""
    try {
      serviceToolBatch(batch, pending, 1000) { id, _ ->
        deliveries++
        oldId = id
        pending.reject(id, "handler failed")
      }
      fail("Expected failure")
    } catch (error: ToolFailedException) { assertEquals("ERR_TOOL_FAILED", error.code) }
    assertEquals(1, deliveries)
    assertFalse(pending.resolve(oldId, "late"))
    try {
      serviceToolBatch(batch, pending, 1) { id, _ -> oldId = id }
      fail("Expected timeout")
    } catch (error: ToolFailedException) { assertTrue(error.message.orEmpty().contains("timed out")) }
    assertFalse(pending.resolve(oldId, "late"))
    val started = CompletableDeferred<String>()
    val operation = async(start = CoroutineStart.UNDISPATCHED) {
      serviceToolBatch(batch, pending, 1000) { id, _ -> started.complete(id) }
    }
    val cancelledId = started.await()
    operation.cancelAndJoin()
    assertFalse(pending.resolve(cancelledId, "late"))
    val (id, deferred) = pending.create()
    pending.close()
    assertTrue(deferred.isCancelled)
    assertFalse(pending.resolve(id, "late"))
    assertThrows(CancellationException::class.java) { pending.create() }
    val replacement = PendingToolCalls()
    assertFalse(replacement.resolve(id, "old generation"))
  }

  @Test fun `second call waits for first resolution and cancellation prevents the remainder`() = runBlocking<Unit> {
    val pending = PendingToolCalls()
    val batch = ToolBudget().validateBatch(listOf(call(), call()), NativeTool.declarations(listOf(config())), stop)
    val delivered = mutableListOf<String>()
    val operation = async(start = CoroutineStart.UNDISPATCHED) {
      serviceToolBatch(batch, pending, 1000) { id, _ -> delivered.add(id) }
    }
    assertEquals(1, delivered.size)
    pending.close()
    try { operation.await(); fail("Expected cancellation") } catch (_: CancellationException) { }
    assertEquals(1, delivered.size)
    assertFalse(pending.resolve(delivered.single(), "late"))
  }

  @Test fun `result bound counts UTF8 bytes and never retries`() = runBlocking<Unit> {
    val pending = PendingToolCalls()
    val batch = ToolBudget().validateBatch(listOf(call()), NativeTool.declarations(listOf(config())), stop)
    val allowed = "é".repeat(32768)
    serviceToolBatch(batch, pending, 100) { id, _ -> pending.resolve(id, allowed) }
    try {
      serviceToolBatch(batch, pending, 100) { id, _ -> pending.resolve(id, allowed + "x") }
      fail("Expected result limit")
    } catch (error: ToolFailedException) { assertEquals("ERR_TOOL_FAILED", error.code) }
  }

  @Test fun `empty terminal answer remains a valid SDK content`() {
    val content = modelToolContent("", emptyList())
    assertEquals("", (content.parts.single() as TextPart).textString)
  }

  @Test fun `streaming callback emits text but never dispatches partial tool calls`() {
    val text = StringBuilder()
    val callback = ToolStreamingCallback { text.append(it) }
    callback.onNewText("before ")
    callback.onNewFunctionCall(call())
    callback.onNewFunctionCall(withArguments(emptyMap()))
    callback.onNewText("tool")
    callback.close()
    callback.onNewText("late")
    assertEquals("before tool", text.toString())
    val batch = ToolBudget().validateBatch(listOf(call()), NativeTool.declarations(listOf(config())), stop)
    assertEquals(1, batch.size)
  }
}
