/**
 * Exact-Agent transient assistant drafts and recovery from native follow
 * opening baselines. Durable session history remains owned by Harness.
 *
 * @module @ephemeral-ai/mayfly/conversation/live-stream
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { SessionAssistantStreamBaseline, SessionFollowFrame } from '@deepseek-ai/dsh-api-session-controller/types'
import type { OutputProgress } from './types.ts'
import { foldAssistantStreamChunk, foldAssistantStreamRecords, initialAssistantStream, type AssistantStreamState } from './stream-accumulator.ts'

const MAX_RECOVERY_BUFFER = 256
const RECOVERY_TIMEOUT_MS = 3000

/** Visible draft of one exact Agent's active attempt. */
export interface LiveAssistantDraft {
  readonly sessionId: string
  readonly attemptId: string
  readonly revision: number
  readonly turn: number
  readonly step: number
  readonly preparing?: AssistantStreamState['preparing']
  readonly phase: AssistantStreamState['phase']
  readonly reasoning: string
  readonly text: string
  readonly outputProgress: OutputProgress | undefined
  readonly chars: number
  readonly updatedAt: number
  /** Producer times of the first and latest visible reasoning deltas, absent before any. */
  readonly reasoningSpan?: { readonly startedAt: number, readonly endedAt: number } | undefined
}

/** Native session follow reader, fenced by the caller's exact Agent identity. */
export interface AssistantStreamFollow {
  open(signal: AbortSignal): AsyncIterable<SessionFollowFrame>
  current(): boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context { mayflyLiveAssistantStream: LiveAssistantStreamService }
}

interface Attempt {
  readonly revision: number
  readonly attemptId: string | undefined
  readonly nextIndex: number
  readonly draft: LiveAssistantDraft | undefined
  readonly state: AssistantStreamState
}

interface Opening {
  readonly controller: AbortController
  readonly frames: AssistantStreamFrame[]
}

interface Recovery {
  readonly follow: AssistantStreamFollow
  refs: number
  waiting: boolean
  delay: number
  opening: Opening | undefined
  timer: ReturnType<typeof setTimeout> | undefined
}

/** Stable frontend service; renderer Fibers consume immutable current drafts. */
export class LiveAssistantStreamService extends Service {
  private readonly attempts = new WeakMap<Agent, Attempt>()
  private readonly recoveries = new Map<Agent, Recovery>()
  private readonly retired = new WeakSet<Agent>()
  private readonly listeners = new Set<() => void>()
  private pendingNotification = false
  private disposed = false
  private readonly offFrame: () => void
  private readonly offDisposed: () => void

  constructor(ctx: Context) {
    super(ctx, 'mayflyLiveAssistantStream')
    this.offFrame = ctx.on('agent/assistant-stream', ({ agent, frame }) => this.accept(agent, frame))
    this.offDisposed = ctx.on('agent/disposed', ({ agent }) => {
      this.retired.add(agent)
      const recovery = this.recoveries.get(agent)
      if (recovery !== undefined) this.close(agent, recovery)
      const hadDraft = this.get(agent) !== undefined
      this.attempts.delete(agent)
      if (hadDraft) this.publish()
    })
  }

  /** Latest draft is readable synchronously, before batched notifications. */
  get(agent: Agent): LiveAssistantDraft | undefined {
    return this.disposed ? undefined : this.attempts.get(agent)?.draft
  }

  /** Observe one notification per microtask; read the latest draft with get. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Retain recovery for one exact Agent; the final release aborts its work. */
  watch(agent: Agent, follow: AssistantStreamFollow): () => void {
    if (this.disposed || this.retired.has(agent) || !follow.current()) return () => {}
    let recovery = this.recoveries.get(agent)
    if (recovery === undefined) {
      recovery = { follow, refs: 0, waiting: true, delay: 50, opening: undefined, timer: undefined }
      this.recoveries.set(agent, recovery)
      this.recover(agent, recovery)
    }
    recovery.refs += 1
    const owned = recovery
    let released = false
    return () => {
      if (released) return
      released = true
      owned.refs -= 1
      if (owned.refs === 0) this.close(agent, owned)
    }
  }

  /** Seed a native baseline without overwriting a newer locally observed cut. */
  ensure(agent: Agent, baseline: SessionAssistantStreamBaseline): boolean {
    if (this.disposed || this.retired.has(agent)) return false
    const previous = this.attempts.get(agent)
    if (previous !== undefined && baseline.revision < previous.revision) return false
    const active = baseline.activeAttempt
    const state = active === undefined ? initialAssistantStream()
      : foldAssistantStreamRecords(initialAssistantStream(), active.stream as never)
    const draft = active === undefined ? undefined
      : this.makeDraft(agent, String(active.attemptId), baseline.revision, active.turn, active.step, state)
    this.attempts.set(agent, {
      revision: baseline.revision,
      attemptId: active === undefined ? undefined : String(active.attemptId),
      nextIndex: active?.nextIndex ?? 0,
      draft,
      state,
    })
    if (previous?.draft !== draft) this.publish()
    return true
  }

  /** Admit only exact-Agent native frames; session follow frames are never used. */
  accept(agent: Agent, frame: AssistantStreamFrame): void {
    if (this.disposed || this.retired.has(agent)) return
    const recovery = this.recoveries.get(agent)
    if (recovery !== undefined) {
      if (!recovery.follow.current()) {
        this.close(agent, recovery)
        return
      }
      if (recovery.waiting) {
        const opening = recovery.opening
        if (opening !== undefined) {
          if (opening.frames.length < MAX_RECOVERY_BUFFER) opening.frames.push(frame)
          else {
            opening.controller.abort()
            recovery.opening = undefined
            this.retry(agent, recovery)
          }
        }
        return
      }
    }
    if (!this.fold(agent, frame) && recovery !== undefined) {
      recovery.waiting = true
      this.recover(agent, recovery)
    }
  }

  /** Abort all owned reads and timers; queued notifications become inert. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.offFrame()
    this.offDisposed()
    for (const [agent, recovery] of this.recoveries) this.close(agent, recovery)
    this.listeners.clear()
  }

  private close(agent: Agent, recovery: Recovery): void {
    recovery.opening?.controller.abort()
    if (recovery.timer !== undefined) clearTimeout(recovery.timer)
    if (this.recoveries.get(agent) === recovery) this.recoveries.delete(agent)
  }

  private recover(agent: Agent, recovery: Recovery): void {
    const opening: Opening = { controller: new AbortController(), frames: [] }
    recovery.opening = opening
    void this.readOpening(agent, recovery, opening)
  }

  private async readOpening(agent: Agent, recovery: Recovery, opening: Opening): Promise<void> {
    const signal = opening.controller.signal
    let iterator: AsyncIterator<SessionFollowFrame> | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      iterator = recovery.follow.open(signal)[Symbol.asyncIterator]()
      const timedOut = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => { opening.controller.abort(); reject(new Error('assistant stream baseline timed out')) }, RECOVERY_TIMEOUT_MS)
      })
      const aborted = new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('assistant stream opening aborted')), { once: true })
      })
      const item = await Promise.race([iterator.next(), timedOut, aborted])
      if (!this.isCurrent(agent, recovery, opening)) return
      if (item.done || item.value.type !== 'snapshot' || item.value.assistantStream === undefined) {
        throw new Error('assistant stream opening baseline is unavailable')
      }
      if (!this.ensure(agent, item.value.assistantStream)) throw new Error('assistant stream baseline is stale')
      recovery.waiting = false
      recovery.delay = 50
      for (const frame of opening.frames) {
        if (!this.fold(agent, frame)) {
          recovery.waiting = true
          this.retry(agent, recovery)
          break
        }
      }
    } catch {
      if (this.isCurrent(agent, recovery, opening)) this.retry(agent, recovery)
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
      opening.controller.abort()
      if (recovery.opening === opening) recovery.opening = undefined
      // Closing a native generator unwinds its listeners. A foreign iterator
      // may reject or ignore cancellation; neither can publish after this cut.
      if (iterator?.return !== undefined) {
        void Promise.resolve().then(() => iterator!.return!()).catch(() => {})
      }
    }
  }

  private isCurrent(agent: Agent, recovery: Recovery, opening: Opening): boolean {
    return this.recoveries.get(agent) === recovery
      && recovery.opening === opening
      && recovery.follow.current()
  }

  private retry(agent: Agent, recovery: Recovery): void {
    recovery.waiting = true
    if (recovery.timer !== undefined) return
    const delay = recovery.delay
    recovery.delay = Math.min(2000, delay * 2)
    recovery.timer = setTimeout(() => {
      recovery.timer = undefined
      if (recovery.follow.current()) this.recover(agent, recovery)
    }, delay)
  }

  /** False denotes a continuity gap, requiring a new native opening baseline. */
  private fold(agent: Agent, frame: AssistantStreamFrame): boolean {
    const previous = this.attempts.get(agent)
    if (previous !== undefined && frame.revision <= previous.revision) return true
    if (frame.type === 'start') {
      if (previous !== undefined && frame.attemptId === previous.attemptId) return true
      if (previous !== undefined && frame.revision !== previous.revision + 1) return false
      const state = initialAssistantStream()
      const draft = this.makeDraft(agent, String(frame.attemptId), frame.revision, frame.turn, frame.step, state)
      this.attempts.set(agent, { attemptId: String(frame.attemptId), revision: frame.revision, nextIndex: 0, state, draft })
      this.publish()
      return true
    }
    if (previous === undefined) return false
    if (frame.attemptId !== previous.attemptId) return true
    if (frame.revision !== previous.revision + 1 || frame.index !== previous.nextIndex) return false
    if (frame.type === 'end') {
      this.attempts.set(agent, { ...previous, revision: frame.revision, attemptId: undefined, draft: undefined })
      this.publish()
      return true
    }
    const state = foldAssistantStreamChunk(previous.state, frame.chunk, frame.time)
    // An active attempt always owns a draft; only end removes both together.
    const draft = previous.draft!
    this.attempts.set(agent, {
      ...previous,
      revision: frame.revision,
      nextIndex: previous.nextIndex + 1,
      state,
      draft: state === previous.state ? draft
        : this.makeDraft(agent, draft.attemptId, frame.revision, draft.turn, draft.step, state),
    })
    if (state !== previous.state) this.publish()
    return true
  }

  private makeDraft(agent: Agent, attemptId: string, revision: number, turn: number, step: number, state: AssistantStreamState): LiveAssistantDraft {
    const progress = state.outputProgress
    return Object.freeze({
      sessionId: String(agent.session.id), attemptId, revision, turn, step,
      phase: state.phase, reasoning: state.reasoning, text: state.text,
      outputProgress: progress === undefined ? undefined : Object.freeze({ ...progress }),
      preparing: state.preparing,
      chars: state.chars,
      updatedAt: state.updatedAt,
      // The accumulator sets both ends together on the first visible reasoning delta.
      ...(state.reasoningStartedAt === undefined ? {} : { reasoningSpan: Object.freeze({ startedAt: state.reasoningStartedAt, endedAt: state.reasoningEndedAt! }) }),
    })
  }

  private publish(): void {
    if (this.pendingNotification) return
    this.pendingNotification = true
    queueMicrotask(() => {
      this.pendingNotification = false
      if (this.disposed) return
      for (const listener of this.listeners) listener()
    })
  }
}
