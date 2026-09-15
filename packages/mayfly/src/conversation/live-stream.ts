/**
 * Renderer-neutral live assistant-stream drafts. Harness assistant frames are
 * transient, so this service keeps exact Agent identity and can seed an
 * in-flight attempt from a session-controller follow baseline after a UI
 * Fiber reload.
 *
 * @module @ephemeral-ai/mayfly/conversation/live-stream
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { SessionAssistantStreamBaseline, SessionFollowFrame } from '@deepseek-ai/dsh-api-session-controller/types'
import { foldAssistantStreamChunk, foldAssistantStreamRecords, initialAssistantStream, type AssistantStreamState } from './stream-accumulator.ts'

const MAX_RECOVERY_BUFFER = 256

/** One live streaming attempt draft; Agent identity stays outside the wire value. */
export interface LiveAssistantDraft extends AssistantStreamState {
  readonly sessionId: string
  readonly attemptId: AssistantStreamFrame['attemptId']
  /** Last accepted frame revision for this attempt. */
  readonly revision: number
  readonly turn: number
  readonly step: number
}

/** Opening and follow stream shape needed by {@link LiveAssistantStreamService.watch}. */
export interface AssistantStreamFollow {
  open(signal: AbortSignal): AsyncIterable<SessionFollowFrame>
  current?: () => boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context { mayflyLiveAssistantStream: LiveAssistantStreamService }
}

interface Attempt {
  readonly attemptId: AssistantStreamFrame['attemptId']
  readonly revision: number
  readonly nextIndex: number
  readonly turn: number
  readonly step: number
  readonly state: AssistantStreamState
}

interface Recovery {
  readonly generation: number
  readonly queue: AssistantStreamFrame[]
  ready: boolean
  abort: AbortController
  refs: number
  readonly follow: AssistantStreamFollow
  retryTimer?: ReturnType<typeof setTimeout> | undefined
}

/** Live-frame draft store over every Agent this Fiber observes. */
export class LiveAssistantStreamService extends Service {
  private readonly drafts = new Map<Agent, LiveAssistantDraft>()
  private readonly attempts = new WeakMap<Agent, Attempt>()
  private readonly recoveries = new Map<Agent, Recovery>()
  private readonly disposedAgents = new WeakSet<Agent>()
  private readonly listeners = new Set<() => void>()
  private notifyQueued = false
  private disposed = false
  private readonly offFrame: () => void
  private readonly offDisposed: () => void

  constructor(ctx: Context) {
    super(ctx, 'mayflyLiveAssistantStream')
    this.offFrame = ctx.on('agent/assistant-stream', ({ agent, frame }) => { this.accept(agent, frame) })
    this.offDisposed = ctx.on('agent/disposed', ({ agent }) => {
      this.disposedAgents.add(agent)
      this.recoveries.get(agent)?.abort.abort()
      this.recoveries.delete(agent)
      this.attempts.delete(agent)
      this.clear(agent)
    })
  }

  /** Draft of the exact Agent, or undefined while nothing streams. */
  get(agent: Agent): LiveAssistantDraft | undefined { return this.drafts.get(agent) }

  /** Subscribe to draft changes; the current state is read via {@link get}. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Accept a frame from a native or reconnect follow source. */
  accept(agent: Agent, frame: AssistantStreamFrame): void {
    if (this.disposed || this.disposedAgents.has(agent)) return
    const recovery = this.recoveries.get(agent)
    if (recovery !== undefined && !recovery.ready) {
      if (recovery.queue.length < MAX_RECOVERY_BUFFER) recovery.queue.push(frame)
      return
    }
    this.fold(agent, frame)
  }

  /** Start a reconnecting follow; the returned disposer aborts that follow. */
  watch(agent: Agent, follow: AssistantStreamFollow): () => void {
    if (this.disposed || this.disposedAgents.has(agent)) return () => {}
    const previous = this.recoveries.get(agent)
    if (previous !== undefined) {
      previous.refs += 1
      return () => this.releaseRecovery(agent, previous)
    }
    const recovery: Recovery = {
      generation: 1,
      queue: [],
      ready: false,
      abort: new AbortController(),
      refs: 1,
      follow,
    }
    this.recoveries.set(agent, recovery)
    void this.runFollow(agent, recovery)
    return () => {
      if (this.recoveries.get(agent) !== recovery) return
      recovery.abort.abort()
      if (recovery.retryTimer !== undefined) clearTimeout(recovery.retryTimer)
      this.recoveries.delete(agent)
    }
  }

  /** Seed an Agent from a reconnect opening baseline. */
  ensure(agent: Agent, baseline: SessionAssistantStreamBaseline): void {
    if (this.disposed || this.disposedAgents.has(agent)) return
    const current = this.attempts.get(agent)
    if (current !== undefined && baseline.revision < current.revision) return
    this.seed(agent, baseline)
    const recovery = this.recoveries.get(agent)
    if (recovery === undefined || recovery.ready) return
    recovery.ready = true
    const queued = recovery.queue.splice(0)
    for (const frame of queued.sort((a, b) => a.revision - b.revision)) this.fold(agent, frame)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.offFrame()
    this.offDisposed()
    for (const recovery of this.recoveries.values()) {
      recovery.abort.abort()
      if (recovery.retryTimer !== undefined) clearTimeout(recovery.retryTimer)
    }
    this.recoveries.clear()
    this.listeners.clear()
    this.drafts.clear()
    this.notifyQueued = false
  }

  private async runFollow(agent: Agent, recovery: Recovery): Promise<void> {
    try {
      if (recovery.follow.current?.() === false) return
      for await (const item of recovery.follow.open(recovery.abort.signal)) {
        if (this.recoveries.get(agent) !== recovery || this.disposedAgents.has(agent) || recovery.follow.current?.() === false) return
        if (item.type === 'snapshot') {
          this.ensure(agent, item.assistantStream ?? { revision: 0 })
          break
        }
      }
    } catch {
      if (this.recoveries.get(agent) !== recovery) return
      recovery.ready = true
      this.retry(agent, recovery)
    }
  }

  private retry(agent: Agent, recovery: Recovery): void {
    if (this.disposed || this.recoveries.get(agent) !== recovery || recovery.follow.current?.() === false) return
    if (recovery.retryTimer !== undefined) return
    recovery.retryTimer = setTimeout(() => {
      recovery.retryTimer = undefined
      recovery.ready = false
      recovery.queue.length = 0
      void this.runFollow(agent, recovery)
    }, 50)
  }

  private releaseRecovery(agent: Agent, recovery: Recovery): void {
    if (this.recoveries.get(agent) !== recovery) return
    recovery.refs -= 1
    if (recovery.refs > 0) return
    recovery.abort.abort()
    if (recovery.retryTimer !== undefined) clearTimeout(recovery.retryTimer)
    this.recoveries.delete(agent)
  }

  private refresh(agent: Agent): void {
    const recovery = this.recoveries.get(agent)
    if (recovery === undefined || this.disposed || recovery.follow.current?.() === false) return
    recovery.ready = false
    if (recovery.queue.length >= MAX_RECOVERY_BUFFER) recovery.queue.length = 0
    void this.runFollow(agent, recovery)
  }

  private seed(agent: Agent, baseline: SessionAssistantStreamBaseline): void {
    const active = baseline.activeAttempt
    if (active === undefined) {
      this.attempts.set(agent, {
        attemptId: '' as AssistantStreamFrame['attemptId'], revision: baseline.revision,
        nextIndex: 0, turn: 0, step: 0, state: initialAssistantStream(),
      })
      this.clear(agent)
      return
    }
    const state = foldAssistantStreamRecords(initialAssistantStream(), active.stream as never)
    this.attempts.set(agent, {
      attemptId: active.attemptId as AssistantStreamFrame['attemptId'], revision: baseline.revision,
      nextIndex: active.nextIndex, turn: active.turn, step: active.step, state,
    })
    this.drafts.set(agent, this.toDraft(agent, baseline.revision, active.attemptId as AssistantStreamFrame['attemptId'], active.turn, active.step, state))
    this.publish()
  }

  private fold(agent: Agent, frame: AssistantStreamFrame): void {
    const current = this.attempts.get(agent)
    if (frame.type === 'start') {
      if (current !== undefined && frame.revision !== current.revision + 1) {
        this.refresh(agent)
        return
      }
      if (current !== undefined && frame.attemptId === current.attemptId) return
      const state = initialAssistantStream()
      this.attempts.set(agent, {
        attemptId: frame.attemptId, revision: frame.revision, nextIndex: 0,
        turn: frame.turn, step: frame.step, state,
      })
      this.drafts.set(agent, this.toDraft(agent, frame.revision, frame.attemptId, frame.turn, frame.step, { ...state, phase: 'thinking' }))
      this.publish()
      return
    }
    if (current === undefined || current.attemptId === ('' as AssistantStreamFrame['attemptId'])
      || frame.attemptId !== current.attemptId || frame.revision !== current.revision + 1) {
      this.refresh(agent)
      return
    }
    if (frame.type === 'chunk' && frame.index !== current.nextIndex) {
      this.refresh(agent)
      return
    }
    if (frame.type === 'end' && frame.index !== current.nextIndex) {
      this.refresh(agent)
      return
    }
    const nextIndex = frame.type === 'chunk' ? current.nextIndex + 1 : current.nextIndex
    if (frame.type === 'end') {
      this.attempts.set(agent, { ...current, revision: frame.revision, nextIndex })
      this.clear(agent)
      return
    }
    const state = foldAssistantStreamChunk(current.state, frame.chunk, frame.time)
    this.attempts.set(agent, { ...current, revision: frame.revision, nextIndex, state })
    const draft = this.drafts.get(agent)
    if (draft === undefined) return
    if (state === current.state) return
    this.drafts.set(agent, Object.freeze({ ...draft, revision: frame.revision, ...state }))
    this.publish()
  }

  private toDraft(agent: Agent, revision: number, attemptId: AssistantStreamFrame['attemptId'], turn: number, step: number, state: AssistantStreamState): LiveAssistantDraft {
    return Object.freeze({ ...state, sessionId: String(agent.session.id), attemptId, revision, turn, step })
  }

  private clear(agent: Agent): void {
    if (!this.drafts.delete(agent)) return
    this.publish()
  }

  private publish(): void {
    if (this.notifyQueued) return
    this.notifyQueued = true
    queueMicrotask(() => {
      this.notifyQueued = false
      if (this.disposed) return
      for (const listener of this.listeners) listener()
    })
  }
}
