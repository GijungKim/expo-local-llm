package expo.modules.localllm

import kotlinx.coroutines.Job
import java.util.UUID

internal enum class GenerationKind { RESPOND, STREAM }

internal class ActiveGeneration(val kind: GenerationKind, val requestId: String) {
  val pending = PendingToolCalls()
  var acceptsOutput = true
  var job: Job? = null
  var exchange: List<TranscriptTurn>? = null
}

/** Shared lock also protects session history, model ownership and event delivery. */
internal class GenerationLifecycle {
  val lock = Any()
  var active: ActiveGeneration? = null
    private set
  var disposed = false
    private set

  fun begin(kind: GenerationKind, requestId: String?): ActiveGeneration = synchronized(lock) {
    if (disposed) throw SessionInvalidException()
    if (active != null) throw SessionBusyException()
    ActiveGeneration(kind, requestId ?: UUID.randomUUID().toString()).also { active = it }
  }

  fun isCurrent(generation: ActiveGeneration): Boolean = synchronized(lock) {
    active === generation && generation.acceptsOutput && !disposed
  }

  fun attach(generation: ActiveGeneration, job: Job) {
    val cancelled = synchronized(lock) {
      generation.job = job
      !isCurrent(generation)
    }
    if (cancelled) job.cancel()
  }

  fun invalidate(generation: ActiveGeneration): Job? = synchronized(lock) {
    if (active === generation) {
      generation.acceptsOutput = false
      generation.pending.close()
    }
    generation.job
  }

  fun cancelStream(): Job? = synchronized(lock) {
    active?.takeIf { it.kind == GenerationKind.STREAM }?.let(::invalidate)
  }

  fun release(): Job? = synchronized(lock) {
    disposed = true
    active?.let(::invalidate)
  }

  /** Exactly one terminal outcome may commit history or emit a terminal event. */
  fun finishOutput(generation: ActiveGeneration, output: () -> Unit): Boolean = synchronized(lock) {
    if (!isCurrent(generation)) return false
    generation.acceptsOutput = false
    generation.pending.close()
    output()
    true
  }

  // Invalidation retains the busy slot until the producer has fully unwound.
  fun finish(generation: ActiveGeneration) = synchronized(lock) {
    if (active === generation) {
      generation.acceptsOutput = false
      generation.pending.close()
      generation.exchange = null
      active = null
    }
  }
}
