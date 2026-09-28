package expo.modules.localllm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Android generation path cannot run without an AICore-capable device, so
 * the parts that are our own code — prompt assembly and history trimming — are
 * covered here on the JVM.
 */
class ConversationHistoryTest {
  @Test
  fun `prompt without instructions contains only the new user message`() {
    val history = ConversationHistory(null)

    assertEquals("[User] hello", history.buildPrompt("hello"))
  }

  @Test
  fun `blank instructions are omitted`() {
    val history = ConversationHistory("   ")

    assertEquals("[User] hello", history.buildPrompt("hello"))
  }

  @Test
  fun `instructions are emitted before the conversation`() {
    val history = ConversationHistory("Be concise")

    assertEquals(
      "[System] Be concise\n\n[User] hello",
      history.buildPrompt("hello")
    )
  }

  @Test
  fun `completed exchanges are replayed in order`() {
    val history = ConversationHistory("Be concise")
    history.addExchange("q1", "a1")
    history.addExchange("q2", "a2")

    assertEquals(
      "[System] Be concise\n\n[User] q1\n[Assistant] a1\n[User] q2\n[Assistant] a2\n[User] q3",
      history.buildPrompt("q3")
    )
  }

  @Test
  fun `clear drops the conversation but keeps instructions`() {
    val history = ConversationHistory("Be concise")
    history.addExchange("q1", "a1")

    history.clear()

    assertEquals("[System] Be concise\n\n[User] q2", history.buildPrompt("q2"))
  }

  @Test
  fun `only the ten most recent exchanges are kept`() {
    val history = ConversationHistory(null)
    repeat(12) { index ->
      history.addExchange("q${index + 1}", "a${index + 1}")
    }

    val prompt = history.buildPrompt("next")

    assertFalse(prompt.contains("[User] q1\n"))
    assertFalse(prompt.contains("[User] q2\n"))
    assertTrue(prompt.contains("[User] q3\n"))
    assertTrue(prompt.contains("[User] q12\n"))
    assertTrue(prompt.endsWith("[User] next"))
  }
}
