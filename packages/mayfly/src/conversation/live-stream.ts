/**
 * Renderer-neutral live assistant-stream drafts. Harness `0.1.5` publishes
 * streaming deltas as transient process-local `agent/assistant-stream`
 * frames; durable session events now carry only the settled attempt stream.
 * This service folds the frames of every live Agent into one draft per
 * session so status and transcript consumers can present streaming text the
 * durable projections no longer see. Drafts are facts derived from event
 * timestamps; they never mutate projection state and are cleared on the
 * attempt end frame, agent disposal, or Fiber teardown.
 *
 * @module @ephemeral-ai/mayfly/conversation/live-stream
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { OutputProgress } from './types.ts'
import { appendOutputProgress } from './output-progress.ts'

/** One live streaming attempt draft, keyed by its session. */
export interface LiveAssistantDraft {
  readonly sessionId: string
  readonly turn: number
  readonly step: number
  /** Current streaming phase, derived from the observed chunk kinds. */
  readonly phase: 'thinking' | 'composing' | 'waiting'
  readonly reasoning: string
  readonly text: string
  readonly outputProgress: OutputProgress | undefined
  /** Frame timestamp of the last observed delta. */
  readonly updatedAt: number
}

declare module '@deepseek-ai/cordis' {
  interface Context { mayflyLiveAssistantStream: LiveAssistantStreamService }
}

/** Live-frame draft store over every Agent this Fiber observes. */
export class LiveAssistantStreamService extends Service {
  private readonly drafts = new Map<string, LiveAssistantDraft>()
  private readonly listeners = new Set<() => void>()
  private readonly offFrame: () => void
  private readonly offDisposed: () => void

  constructor(ctx: Context) {
    super(ctx, 'mayflyLiveAssistantStream')
    this.offFrame = ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      this.fold(agent, frame)
    })
    this.offDisposed = ctx.on('agent/disposed', ({ agent }) => {
      this.clear(String(agent.session.id))
    })
  }

  /** Draft of one session, or undefined while nothing streams. */
  get(sessionId: string): LiveAssistantDraft | undefined {
    return this.drafts.get(sessionId)
  }

  /** Subscribe to draft changes; the current state is read via {@link get}. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  dispose(): void {
    this.offFrame()
    this.offDisposed()
    this.listeners.clear()
    this.drafts.clear()
  }

  private fold(agent: Agent, frame: AssistantStreamFrame): void {
    const key = String(agent.session.id)
    if (frame.type === 'start') {
      this.drafts.set(key, {
        sessionId: key, turn: frame.turn, step: frame.step, phase: 'thinking',
        reasoning: '', text: '', outputProgress: undefined, updatedAt: 0,
      })
      this.publish()
      return
    }
    if (frame.type === 'end') {
      // The committed settlement (when one exists) is already durable at this
      // point; an abandoned attempt simply never happened visibly.
      this.clear(key)
      return
    }
    const draft = this.drafts.get(key)
    if (draft === undefined) return
    const chunk = frame.chunk
    if (chunk.type === 'reasoning-delta') {
      if (chunk.text === '') return
      this.drafts.set(key, {
        ...draft,
        phase: 'thinking',
        reasoning: draft.reasoning + chunk.text,
        outputProgress: appendOutputProgress(draft.phase === 'thinking' ? draft.outputProgress : undefined, chunk.text.length, frame.time),
        updatedAt: frame.time,
      })
      this.publish()
      return
    }
    if (chunk.type === 'text-delta') {
      if (chunk.text === '') return
      this.drafts.set(key, {
        ...draft,
        phase: 'composing',
        text: draft.text + chunk.text,
        outputProgress: appendOutputProgress(draft.phase === 'composing' ? draft.outputProgress : undefined, chunk.text.length, frame.time),
        updatedAt: frame.time,
      })
      this.publish()
      return
    }
    if (chunk.type === 'finish' || chunk.type === 'tool-call-delta'
      || (chunk.type === 'block-start' && chunk.blockType !== 'reasoning')
      || (chunk.type === 'block-end' && ((chunk.block.type === 'reasoning' && draft.phase === 'thinking')
        || (chunk.block.type === 'text' && draft.phase === 'composing')))) {
      this.drafts.set(key, { ...draft, phase: 'waiting', updatedAt: frame.time })
      this.publish()
    }
  }

  private clear(sessionId: string): void {
    if (!this.drafts.delete(sessionId)) return
    this.publish()
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
  }
}
