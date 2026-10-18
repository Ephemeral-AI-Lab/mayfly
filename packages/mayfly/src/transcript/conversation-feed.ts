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
import { conversationProjectionSchema } from '../conversation/projection.ts'
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
interface PendingProjection {
  readonly value: unknown
  readonly seq: number
}

/** Why a feed cannot deliver its conversation. */
type ConversationFeedFailure = 'controller-unavailable' | 'invalid' | 'read-failed'

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
 * Whether a new whole projection value settles the current live step or closes its turn. Such a value must publish
 * immediately: it is the durable text the live draft was standing in for, and its turn boundary is what stops the
 * stream. The live frames themselves may already have been dropped by the publish window.
 * @param value - the admitted whole projection value.
 * @param draft - the Agent's current live draft, when one is streaming.
 * @returns whether the value ends what the draft was showing.
 */
function settlesLive(value: unknown, draft: LiveAssistantDraft | undefined): boolean {
  if (draft === undefined || value === null || typeof value !== 'object') return false
  const record = value as { readonly settledSteps?: unknown, readonly turns?: unknown }
  if (Array.isArray(record.settledSteps) && record.settledSteps.includes(`${String(draft.turn)}:${String(draft.step)}`)) return true
  if (!Array.isArray(record.turns)) return false
  return record.turns.some((turn) => {
    if (turn === null || typeof turn !== 'object') return false
    const row = turn as { readonly turn?: unknown, readonly endedAt?: unknown }
    return row.turn === draft.turn && row.endedAt !== undefined
  })
}

/**
 * Follow one live Session through the native projection registry. Native
 * changes are complete, validated values: only the newest is kept until the
 * owner reads it, so a token burst never maps history per delta.
 *
 * The registry notifies the units of one committed event in turn, and a
 * listener that snapshots the registry meanwhile advances every later unit
 * past that event, so the registry skips their notifications (a status row
 * re-reading the context keys swallowed the `user/message` of each new turn
 * until the turn ended). Any other unit's change for this Session proves a
 * committed event, so the feed reads its own value again once the
 * notifications are over and keeps it when it moved.
 */
export class SessionConversationFeed implements ConversationFeed {
  private pending: PendingProjection | undefined
  private watermark: number
  /** The newest value held or handed out; the registry memoizes views, so an unchanged value is the same object. */
  private latest: unknown
  /** A read after the current notifications is queued. */
  private recheck = false
  private lastDraft: LiveAssistantDraft | undefined
  private disposed = false
  private readonly offChanged: () => void
  private readonly offLive: () => void

  constructor(
    private readonly projections: ConversationProjectionSource,
    private readonly session: Session,
    private readonly agent: Agent | undefined,
    private readonly live: LiveDraftSource | undefined,
    private readonly notify: (force?: boolean) => void,
  ) {
    this.offChanged = projections.onChanged((target, key, value, seq) => {
      if (this.disposed || target !== session) return
      if (key === 'mayflyConversation') this.offer(value, seq)
      else this.scheduleRecheck()
    })
    // Live notifications cover every Agent. Wake only when this exact Agent's
    // draft identity changed, so unrelated child streams never repaint here.
    this.offLive = live === undefined || agent === undefined ? () => {} : live.subscribe(() => {
      if (!this.disposed && live.get(agent) !== this.lastDraft) this.notify()
    })
    const snapshot = projections.snapshot(session, ['mayflyConversation'])
    this.watermark = snapshot.asOfSeq
    this.latest = snapshot.values.mayflyConversation
    this.pending = { value: this.latest, seq: snapshot.asOfSeq }
  }

  /** Hold a value newer than every one already held or admitted, and wake the owner for the first one it has not read. */
  private offer(value: unknown, seq: number): void {
    if (seq <= Math.max(this.watermark, this.pending?.seq ?? -1) || value === this.latest) return
    const first = this.pending === undefined
    this.pending = { value, seq }
    this.latest = value
    const force = settlesLive(value, this.agent === undefined ? undefined : this.live?.get(this.agent))
    if (first || force) this.notify(force)
  }

  /** Read this Session's value in a microtask: never inside the registry's notifications, once per burst of them. */
  private scheduleRecheck(): void {
    if (this.recheck) return
    this.recheck = true
    queueMicrotask(() => {
      this.recheck = false
      if (this.disposed) return
      const snapshot = this.projections.snapshot(this.session, ['mayflyConversation'])
      this.offer(snapshot.values.mayflyConversation, snapshot.asOfSeq)
    })
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
