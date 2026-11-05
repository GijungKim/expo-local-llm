package expo.modules.localllm

import com.google.mlkit.genai.common.FunctionCall
import com.google.mlkit.genai.prompt.Content

class ConversationHistory(private val systemInstructions: String?) {
  private data class Message(val role: String, val content: String)

  internal companion object {
    // The no-tool path receives one flat prompt, so roles exist only as these
    // markers. Neutralise them in conversation text so a message cannot
    // impersonate the system instructions or another turn.
    private val roleMarker = Regex("""\[\s*(system|user|assistant)\s*]""", RegexOption.IGNORE_CASE)

    fun neutralise(content: String): String = content.replace(roleMarker, "($1)")
  }

  private val messages = mutableListOf<Message>()
  private val exchanges = mutableListOf<List<TranscriptTurn>>()
  var hasToolProtocol = false
    private set

  fun contents(): List<Content> = buildList {
    if (!systemInstructions.isNullOrBlank()) {
      add(Content.Builder().text("[System] $systemInstructions").build())
    }
    addAll(exchanges.flatten().map { it.content() })
  }

  internal fun addToolExchange(turns: List<TranscriptTurn>) {
    exchanges.add(turns.toList())
    hasToolProtocol = true
    trimExchanges()
  }

  private fun trimExchanges() {
    while (exchanges.size > maxExchanges) exchanges.removeAt(0)
  }
  private val maxExchanges = 10

  fun addExchange(user: String, assistant: String) {
    exchanges.add(listOf(
      TranscriptTurn.Text(Content.Role.USER, user),
      TranscriptTurn.Text(Content.Role.MODEL, assistant)
    ))
    trimExchanges()
    messages.add(Message("User", neutralise(user)))
    messages.add(Message("Assistant", neutralise(assistant)))
    trimHistory()
  }

  fun clear() {
    messages.clear()
    exchanges.clear()
    hasToolProtocol = false
  }

  fun buildPrompt(addingUserMessage: String): String {
    val sb = StringBuilder()
    if (!systemInstructions.isNullOrBlank()) {
      sb.appendLine("[System] $systemInstructions")
      sb.appendLine()
    }
    for (msg in messages) {
      sb.appendLine("[${msg.role}] ${msg.content}")
    }
    sb.appendLine("[User] ${neutralise(addingUserMessage)}")
    return sb.toString().trim()
  }

  private fun trimHistory() {
    // Keep last maxExchanges * 2 messages (user + assistant pairs)
    val maxMessages = maxExchanges * 2
    if (messages.size > maxMessages) {
      val excess = messages.size - maxMessages
      repeat(excess) { messages.removeAt(0) }
    }
  }
}

/** Persisted history has no bitmap-bearing Content or request references. */
internal sealed interface TranscriptTurn {
  fun content(): Content

  data class Text(val role: Int, val text: String) : TranscriptTurn {
    override fun content(): Content = Content.Builder().setRole(role).text(text).build()
  }
  data class Model(val text: String, val calls: List<FunctionCall>) : TranscriptTurn {
    override fun content(): Content = modelToolContent(text, calls)
  }
  data class Results(val results: List<Pair<FunctionCall, String>>) : TranscriptTurn {
    override fun content(): Content = toolResultContent(results)
  }
}

internal fun LocalPrompt.transcriptTurn() = TranscriptTurn.Text(Content.Role.USER, text)
