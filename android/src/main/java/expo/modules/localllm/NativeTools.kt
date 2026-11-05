package expo.modules.localllm

import com.google.mlkit.genai.common.FunctionArgValue
import com.google.mlkit.genai.common.FunctionCall
import com.google.mlkit.genai.prompt.Candidate
import com.google.mlkit.genai.prompt.Content
import com.google.mlkit.genai.prompt.FunctionCallPart
import com.google.mlkit.genai.prompt.FunctionResponsePart
import com.google.mlkit.genai.prompt.TextPart
import com.google.mlkit.genai.schema.tools.FunctionDeclaration
import com.google.mlkit.genai.schema.tools.FunctionSchema
import com.google.mlkit.genai.schema.tools.FunctionType
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout
import java.util.UUID

internal class NativeTool(config: ToolConfig) {
  val name = config.name
  val declaration: FunctionDeclaration
  private val parameters: Map<String, FunctionSchema>

  init {
    if (!IDENTIFIER.matches(name)) throw ToolInvalidException("Invalid tool name: $name")
    parameters = config.parameters.mapValues { (key, raw) ->
      if (!IDENTIFIER.matches(key)) throw ToolInvalidException("Invalid parameter name: $key")
      val field = raw as? Map<*, *> ?: throw ToolInvalidException("Invalid parameter: $key")
      if (field.keys.any { it !in setOf("type", "description", "enum") }) {
        throw ToolInvalidException("Unsupported parameter field: $key")
      }
      val type = when (field["type"]) {
        "string" -> FunctionType.STRING
        "number" -> FunctionType.NUMBER
        "boolean" -> FunctionType.BOOLEAN
        else -> throw ToolInvalidException("Unsupported parameter type: $key")
      }
      val description = field["description"] as? String
        ?: throw ToolInvalidException("Parameter description must be a string: $key")
      val values = if (field.containsKey("enum")) {
        val entries = field["enum"] as? List<*>
          ?: throw ToolInvalidException("Invalid enum: $key")
        if (type != FunctionType.STRING || entries.isEmpty() || entries.any { it !is String }) {
          throw ToolInvalidException("Enums require a nonempty string list: $key")
        }
        entries.map { it as String }.also {
          if (it.distinct().size != it.size) throw ToolInvalidException("Duplicate enum value: $key")
        }
      } else null
      FunctionSchema(type = type, description = description, enum = values)
    }
    declaration = FunctionDeclaration(
      name = name,
      description = config.description,
      parameters = FunctionSchema(
        type = FunctionType.OBJECT,
        properties = parameters,
        required = parameters.keys.toList()
      )
    )
  }

  fun arguments(call: FunctionCall): Map<String, Any> {
    if (call.arguments.keys != parameters.keys) throw ToolFailedException("Invalid argument keys for $name")
    return call.arguments.mapValues { (key, raw) ->
      val value: Any = when (raw) {
        is FunctionArgValue.StringValue -> raw.value
        is FunctionArgValue.BoolValue -> raw.value
        is FunctionArgValue.IntValue -> raw.value
        is FunctionArgValue.LongValue -> raw.value.also {
          if (it !in -9007199254740991L..9007199254740991L) {
            throw ToolFailedException("Unsafe integer argument: $name.$key")
          }
        }
        is FunctionArgValue.DoubleValue -> raw.value.also {
          if (!it.isFinite()) throw ToolFailedException("Nonfinite argument: $name.$key")
        }
        else -> throw ToolFailedException("Null or nested argument: $name.$key")
      }
      val schema = parameters.getValue(key)
      val valid = when (schema.type) {
        FunctionType.STRING -> value is String && (schema.enum == null || value in schema.enum.orEmpty())
        FunctionType.NUMBER -> value is Number
        FunctionType.BOOLEAN -> value is Boolean
        else -> false
      }
      if (!valid) throw ToolFailedException("Invalid argument type or enum: $name.$key")
      value
    }
  }

  companion object {
    private val IDENTIFIER = Regex("[A-Za-z_][A-Za-z0-9_]{0,63}")

    fun declarations(configs: List<ToolConfig>): Map<String, NativeTool> {
      val tools = configs.map(::NativeTool)
      if (tools.map { it.name }.distinct().size != tools.size) throw ToolInvalidException("Duplicate tool names")
      return tools.associateBy { it.name }
    }
  }
}

internal data class ValidatedCall(val call: FunctionCall, val arguments: Map<String, Any>)

/** All calls are checked before any handler can have side effects. */
internal class ToolBudget {
  private var rounds = 0
  private var calls = 0
  private val seenCallIds = mutableSetOf<String>()

  fun validateBatch(
    batch: List<FunctionCall>,
    tools: Map<String, NativeTool>,
    finishReason: Int?
  ): List<ValidatedCall> {
    if (finishReason != Candidate.FinishReason.STOP) {
      throw ToolFailedException("Tool turn did not finish successfully (reason $finishReason)")
    }
    if (batch.isEmpty()) return emptyList()
    if (rounds >= MAX_ROUNDS || calls + batch.size > MAX_CALLS) throw ToolFailedException("Tool call limit exceeded")
    val ids = batch.mapNotNull { it.id }
    if (ids.distinct().size != ids.size) throw ToolFailedException("Duplicate SDK call IDs")
    if (ids.any { it in seenCallIds }) throw ToolFailedException("Replayed SDK call ID")
    val validated = batch.map { call ->
      val tool = tools[call.name] ?: throw ToolFailedException("Unknown tool: ${call.name}")
      ValidatedCall(call, tool.arguments(call))
    }
    seenCallIds.addAll(ids)
    rounds++
    calls += batch.size
    return validated
  }

  companion object {
    const val MAX_ROUNDS = 8
    const val MAX_CALLS = 32
    const val MAX_RESULT_BYTES = 65536
  }
}

/** Owned by one generation. The session lock serializes event delivery and invalidation. */
internal class PendingToolCalls {
  private val pending = mutableMapOf<String, CompletableDeferred<String>>()
  private var closed = false

  @Synchronized
  fun create(): Pair<String, CompletableDeferred<String>> {
    if (closed) throw kotlinx.coroutines.CancellationException("Generation ended")
    val id = UUID.randomUUID().toString()
    return id to CompletableDeferred<String>().also { pending[id] = it }
  }

  @Synchronized
  fun resolve(id: String, result: String): Boolean {
    val deferred = pending.remove(id) ?: return false
    if (result.length > ToolBudget.MAX_RESULT_BYTES || result.toByteArray(Charsets.UTF_8).size > ToolBudget.MAX_RESULT_BYTES) {
      deferred.completeExceptionally(ToolFailedException("Tool result exceeds 65536 UTF-8 bytes"))
    } else {
      deferred.complete(result)
    }
    return true
  }

  @Synchronized
  fun reject(id: String, message: String): Boolean {
    val deferred = pending.remove(id) ?: return false
    deferred.completeExceptionally(ToolFailedException(message))
    return true
  }

  @Synchronized
  fun remove(id: String) { pending.remove(id)?.cancel() }

  @Synchronized
  fun close() {
    closed = true
    val remaining = pending.values.toList()
    pending.clear()
    remaining.forEach { it.cancel() }
  }

  suspend fun await(id: String, deferred: CompletableDeferred<String>, timeoutMillis: Long): String = try {
    withTimeout(timeoutMillis) { deferred.await() }
  } catch (_: TimeoutCancellationException) {
    throw ToolFailedException("Tool handler timed out")
  } finally {
    remove(id)
  }
}

internal fun modelToolContent(text: String, calls: List<FunctionCall>): Content =
  Content.Builder().setRole(Content.Role.MODEL).apply {
    if (text.isNotEmpty() || calls.isEmpty()) addPart(TextPart(text))
    calls.forEach { addPart(FunctionCallPart(it)) }
  }.build()

internal fun toolResultContent(results: List<Pair<FunctionCall, String>>): Content =
  Content.Builder().setRole(Content.Role.USER).apply {
    results.forEach { (call, result) ->
      addPart(FunctionResponsePart(call.id, call.name, mapOf("result" to result)))
    }
  }.build()

/** Callback calls are deliberately ignored: beta5 supplies the full batch at completion. */
internal class ToolStreamingCallback(private val onText: (String) -> Unit) : com.google.mlkit.genai.common.StreamingCallback {
  private var closed = false

  @Synchronized
  override fun onNewText(text: String) { if (!closed) onText(text) }

  @Synchronized
  fun close() { closed = true }
}

/** Runs only a fully validated terminal batch, in order, without handler retries. */
internal suspend fun serviceToolBatch(
  calls: List<ValidatedCall>,
  pending: PendingToolCalls,
  timeoutMillis: Long,
  deliver: (String, ValidatedCall) -> Unit
): TranscriptTurn.Results {
  val results = calls.map { validated ->
    val (id, deferred) = pending.create()
    try {
      deliver(id, validated)
      validated.call to pending.await(id, deferred, timeoutMillis)
    } finally { pending.remove(id) }
  }
  return TranscriptTurn.Results(results)
}
