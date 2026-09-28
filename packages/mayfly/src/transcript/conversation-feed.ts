/**
 * Projection feeds for the conversations the transcript displays. A live
 * local Session and a stored child read through its native address both
 * reduce to the latest unread `mayflyConversation` whole value plus an
 * optional live draft; the model source converts it lazily on render.
 *
 * @module @ephemeral-ai/mayfly/transcript/conversation-feed
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionAddress, SessionFollowFrame, SessionFollowRequest } from '@deepseek-ai/dsh-api-session-controller'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { conversationProjectionSchema } from '../conversation/index.ts'
import type { LiveAssistantDraft } from '../conversation/live-stream.ts'

/**
 * Live assistant-stream draft source. Harness publishes streaming deltas as
 * transient Agent frames the session projection never sees; the model source
 * overlays the current draft until the durable settlement rewrites the step.
 */
export interface LiveDraftSource {
  subscribe(listener: () => void): () => void
  get(agent: Agent): LiveAssistantDraft | undefined
}

/**
 * Native projection read face. The registry validates complete values; the
 * model source repeats admission on the next read.
 */
export interface ConversationProjectionSource {
  snapshot(session: Session, keys?: readonly ['mayflyConversation']): { readonly asOfSeq: number, readonly values: Readonly<Record<string, unknown>> }
  onChanged(listener: (session: Session, key: string, value: unknown, seq: number) => void): () => void
}

/** Native addressed-history read face. */
export interface ConversationHistorySource {
  follow(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame>
}

/** Latest unread whole projection value and its committed sequence. */
export interface PendingProjection {
  readonly value: unknown
  readonly seq: number
}

/** Why a feed cannot deliver its conversation. */
export type ConversationFeedFailure = 'controller-unavailable' | 'invalid' | 'read-failed'

/** Delivery state of one feed. */
export type ConversationFeedState =
  | { readonly kind: 'ready' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed', readonly reason: ConversationFeedFailure, readonly detail?: string }

/** One conversation's projection feed; its owner takes values while rendering. */
export interface ConversationFeed {
  /** Take the newest unread value; later calls return undefined until another arrives. */
  take(): PendingProjection | undefined
  /** Record that the value at `seq` was admitted; no later value at or below it is newer. */
  settle(seq: number): void
  /** Current live assistant draft; reading it marks that draft as painted. */
  draft(): LiveAssistantDraft | undefined
  state(): ConversationFeedState
  dispose(): void
}

const READY: ConversationFeedState = Object.freeze({ kind: 'ready' })
const LOADING: ConversationFeedState = Object.freeze({ kind: 'loading' })

/**
 * Follow one live Session through the native projection registry. Native
 * changes are complete, validated values: only the newest is kept until the
 * owner reads it, so a token burst never maps history per delta.
 */
export class SessionConversationFeed implements ConversationFeed {
  private pending: PendingProjection | undefined
  private watermark: number
  private lastDraft: LiveAssistantDraft | undefined
  private disposed = false
  private readonly offChanged: () => void
  private readonly offLive: () => void

  constructor(
    projections: ConversationProjectionSource,
    session: Session,
    private readonly agent: Agent | undefined,
    private readonly live: LiveDraftSource | undefined,
    notify: () => void,
  ) {
    this.offChanged = projections.onChanged((target, key, value, seq) => {
      if (this.disposed || target !== session || key !== 'mayflyConversation' || seq <= Math.max(this.watermark, this.pending?.seq ?? -1)) return
      const first = this.pending === undefined
      this.pending = { value, seq }
      if (first) notify()
    })
    // Live notifications cover every Agent. Wake only when this exact Agent's
    // draft identity changed, so unrelated child streams never repaint here.
    this.offLive = live === undefined || agent === undefined ? () => {} : live.subscribe(() => {
      if (!this.disposed && live.get(agent) !== this.lastDraft) notify()
    })
    const snapshot = projections.snapshot(session, ['mayflyConversation'])
    this.watermark = snapshot.asOfSeq
    this.pending = { value: snapshot.values.mayflyConversation, seq: snapshot.asOfSeq }
  }

  take(): PendingProjection | undefined {
    const pending = this.pending
    this.pending = undefined
    return pending
  }

  settle(seq: number): void { this.watermark = seq }

  draft(): LiveAssistantDraft | undefined {
    this.lastDraft = this.agent === undefined ? undefined : this.live?.get(this.agent)
    return this.lastDraft
  }

  state(): ConversationFeedState { return READY }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.pending = undefined
    this.lastDraft = undefined
    this.offChanged()
    this.offLive()
  }
}

/**
 * Read one stored conversation through its native address without activating
 * it: the first snapshot frame carries the whole projection value. Browsing
 * never resumes the Agent; a later resume re-binds the view to a live feed.
 */
export class AddressConversationFeed implements ConversationFeed {
  private pending: PendingProjection | undefined
  private current: ConversationFeedState = LOADING
  private readonly abort = new AbortController()

  constructor(history: ConversationHistorySource | undefined, address: SessionAddress, notify: () => void) {
    if (history === undefined) {
      this.current = Object.freeze({ kind: 'failed', reason: 'controller-unavailable' })
      return
    }
    void this.load(history, address, notify)
  }

  take(): PendingProjection | undefined {
    const pending = this.pending
    this.pending = undefined
    return pending
  }

  /** One snapshot is the whole read; there is nothing later to fence. */
  settle(): void {}

  draft(): undefined { return undefined }

  state(): ConversationFeedState { return this.current }

  dispose(): void {
    this.abort.abort()
    this.pending = undefined
  }

  private async load(history: ConversationHistorySource, address: SessionAddress, notify: () => void): Promise<void> {
    const signal = this.abort.signal
    try {
      for await (const frame of history.follow({ address }, signal)) {
        if (signal.aborted) return
        if (frame.type !== 'snapshot') continue
        // Addressed values arrive over the wire, not from this registry.
        const parsed = conversationProjectionSchema.safeParse(frame.projections.values['mayflyConversation'])
        if (parsed.success) {
          this.pending = { value: parsed.data, seq: frame.projections.asOfSeq }
          this.current = READY
        } else {
          this.current = Object.freeze({ kind: 'failed', reason: 'invalid' })
        }
        notify()
        return
      }
      if (signal.aborted) return
      this.current = Object.freeze({ kind: 'failed', reason: 'invalid' })
    } catch (error) {
      if (signal.aborted) return
      this.current = Object.freeze({ kind: 'failed', reason: 'read-failed', detail: error instanceof Error ? error.message : String(error) })
    }
    notify()
  }
}
