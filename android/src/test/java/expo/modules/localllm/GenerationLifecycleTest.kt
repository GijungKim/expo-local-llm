package expo.modules.localllm

import kotlinx.coroutines.Job
import org.junit.Assert.*
import org.junit.Test

class GenerationLifecycleTest {
  @Test fun `invalidation closes pending tools but keeps busy until producer finishes`() {
    val lifecycle = GenerationLifecycle()
    val generation = lifecycle.begin(GenerationKind.STREAM, "request")
    val (id, pending) = generation.pending.create()
    val producer = Job()
    lifecycle.attach(generation, producer)
    lifecycle.cancelStream()?.cancel()
    assertFalse(lifecycle.isCurrent(generation))
    assertTrue(pending.isCancelled)
    assertTrue(producer.isCancelled)
    assertFalse(generation.pending.resolve(id, "late"))
    assertThrows(SessionBusyException::class.java) { lifecycle.begin(GenerationKind.STREAM, null) }
    lifecycle.finish(generation)
    val next = lifecycle.begin(GenerationKind.STREAM, "next")
    assertFalse(next.pending.resolve(id, "stale"))
    lifecycle.finish(generation)
    assertTrue(lifecycle.isCurrent(next))
  }

  @Test fun `reset and registration invalidation also stop respond and reject attached late job`() {
    val lifecycle = GenerationLifecycle()
    val generation = lifecycle.begin(GenerationKind.RESPOND, null)
    val (_, pending) = generation.pending.create()
    assertNull(lifecycle.cancelStream())
    assertTrue(lifecycle.isCurrent(generation))
    lifecycle.invalidate(generation)
    assertTrue(pending.isCancelled)
    val lateProducer = Job()
    lifecycle.attach(generation, lateProducer)
    assertTrue(lateProducer.isCancelled)
    assertThrows(SessionBusyException::class.java) { lifecycle.begin(GenerationKind.RESPOND, null) }
    lifecycle.finish(generation)
    assertTrue(lifecycle.isCurrent(lifecycle.begin(GenerationKind.RESPOND, null)))
  }

  @Test fun `terminal output is atomic once only and cancelled generations cannot commit`() {
    val lifecycle = GenerationLifecycle()
    var commits = 0
    val events = mutableListOf<String>()
    val cancelled = lifecycle.begin(GenerationKind.STREAM, "cancelled")
    lifecycle.cancelStream()
    assertFalse(lifecycle.finishOutput(cancelled) { commits++; events.add("streamComplete") })
    lifecycle.finish(cancelled)
    val failed = lifecycle.begin(GenerationKind.STREAM, "failed")
    assertTrue(lifecycle.finishOutput(failed) { events.add("streamError") })
    assertFalse(lifecycle.finishOutput(failed) { commits++; events.add("streamComplete") })
    lifecycle.finish(failed)
    val success = lifecycle.begin(GenerationKind.STREAM, "success")
    assertFalse(lifecycle.finishOutput(cancelled) { commits++ })
    assertTrue(lifecycle.finishOutput(success) { commits++; events.add("streamComplete") })
    assertFalse(lifecycle.isCurrent(success))
    assertEquals(1, commits)
    assertEquals(listOf("streamError", "streamComplete"), events)
  }

  @Test fun `release is permanent even when old producer finishes later`() {
    val lifecycle = GenerationLifecycle()
    val generation = lifecycle.begin(GenerationKind.STREAM, "outer-request")
    val (_, pending) = generation.pending.create()
    lifecycle.release()
    assertTrue(pending.isCancelled)
    assertFalse(lifecycle.isCurrent(generation))
    lifecycle.finish(generation)
    assertThrows(SessionInvalidException::class.java) { lifecycle.begin(GenerationKind.STREAM, null) }
    assertEquals("outer-request", generation.requestId)
  }
}
