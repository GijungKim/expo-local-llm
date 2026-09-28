package expo.modules.localllm

class ConversationHistory(private val systemInstructions: String?) {
  private data class Message(val role: String, val content: String)

  private val messages = mutableListOf<Message>()
  private val maxExchanges = 10

  fun addExchange(user: String, assistant: String) {
    messages.add(Message("User", user))
    messages.add(Message("Assistant", assistant))
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
    sb.appendLine("[User] $addingUserMessage")
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
