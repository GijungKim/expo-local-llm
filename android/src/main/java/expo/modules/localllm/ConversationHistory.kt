package expo.modules.localllm

class ConversationHistory(private val systemInstructions: String?) {
  private data class Message(val role: String, val content: String)

  private companion object {
    // Gemini Nano receives one flat prompt, so roles exist only as these
    // markers. Neutralise them in conversation text so a message cannot
    // impersonate the system instructions or another turn.
    val roleMarker = Regex("""\[\s*(system|user|assistant)\s*]""", RegexOption.IGNORE_CASE)

    fun neutralise(content: String): String = content.replace(roleMarker, "($1)")
  }

  private val messages = mutableListOf<Message>()
  private val maxExchanges = 10

  fun addExchange(user: String, assistant: String) {
    messages.add(Message("User", neutralise(user)))
    messages.add(Message("Assistant", neutralise(assistant)))
    trimHistory()
  }

  fun clear() {
    messages.clear()
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
