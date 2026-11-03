/**
 * Projection mapper from the official `mayflyConversation` session projection
 * to Mayfly's renderer-neutral transcript model. It reads one conversation
 * feed — a live Session through the native registry or a stored child through
 * its native address — and never folds Harness events.
 *
 * @module @ephemeral-ai/mayfly/transcript/official-model
 */

import type { Session } from '@deepseek-ai/dsh-session'
import { interpolateLocaleMessage, type MayflyTranslate } from '../frontend/locale.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ConversationEntry, ConversationProjection } from '../conversation/types.ts'
import type { LiveAssistantDraft } from '../conversation/live-stream.ts'
import { SessionConversationFeed, type ConversationFeed, type ConversationFeedState, type ConversationProjectionSource, type LiveDraftSource } from './conversation-feed.ts'
import { freezeModel, type TranscriptEntryModel, type TranscriptModel } from '../frontend/models.ts'
import type { MayflyWorkCounters } from '../core/ui-work-counters.ts'
import { createTranscriptModel } from './transcript-model.ts'
import { toolActivity } from './process-activity.ts'
import type { ToolPresentationSource } from './present.ts'
import { conversationTranscriptModel, createTranscriptModelCaches } from './conversation-model.ts'
export * from './conversation-model.ts'

/** Entry kinds the mapper dereferences; anything else is not our wire value. */
const ADMITTED_KINDS = new Set(['user', 'assistant', 'thinking', 'tool', 'error', 'interrupted', 'goal-change', 'goal-round', 'compaction'])

/** The entry fields this mapper dereferences; the rest stay opaque here. */
function admissibleEntry(candidate: unknown): candidate is ConversationEntry {
  if (candidate === null || typeof candidate !== 'object') return false
  const kind = (candidate as { kind?: unknown }).kind
  const seq = (candidate as { seq?: unknown }).seq
  return typeof kind === 'string' && ADMITTED_KINDS.has(kind)
    && typeof seq === 'number' && Number.isSafeInteger(seq)
}

/**
 * The registry schema-validates the complete wire value before publishing,
 * so admission here only checks the envelope and the entry fields this
 * mapper dereferences, then slices history below a presentation floor.
 */
function visibleProjection(
  value: unknown,
  historyFloorSeq: number | undefined,
): ConversationProjection | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const envelope = value as { entries?: unknown, streaming?: unknown, settledSteps?: unknown, turns?: unknown }
  if (!Array.isArray(envelope.entries) || typeof envelope.streaming !== 'boolean' || !Array.isArray(envelope.settledSteps)) return undefined
  /* One pass over the wire array: admit every entry and cut off inherited
     history at the same time. Downstream mapping works on this copy, so the
     published array is never re-read (see the history-read-count specs). */
  const entries: ConversationEntry[] = []
  for (const candidate of envelope.entries) {
    if (!admissibleEntry(candidate)) return undefined
    if (historyFloorSeq === undefined || candidate.seq > historyFloorSeq) entries.push(candidate)
  }
  const retained = historyFloorSeq === undefined ? undefined : new Set(entries.map(entry => entry.turn))
  const turns = (Array.isArray(envelope.turns) ? envelope.turns as ConversationProjection['turns'] : [])
    .filter(turn => retained === undefined || retained.has(turn.turn))
  return { entries, streaming: envelope.streaming, settledSteps: envelope.settledSteps as string[], turns }
}

/** Failure copy of one feed state, in English source keys the renderer translates. */
const FEED_FAILURE_COPY = {
  'controller-unavailable': 'the session controller is unavailable',
  'invalid': 'the stored conversation is unavailable',
  'read-failed': 'could not read the conversation: {error}',
} as const

/**
 * Projection-to-model source for one displayed conversation. It reads one
 * feed at a time, converts only the latest unread whole value, and overlays
 * the feed's live draft without rerunning history mapping.
 */
export class OfficialConversationModelSource {
  private model: TranscriptModel = createTranscriptModel('official-conversation', [], false)
  private feed: ConversationFeed | undefined
  private generation = 0
  private watermark = -1
  private durableModel: TranscriptModel | undefined
  private lastVisible: ConversationProjection | undefined
  private settledSteps = new Set<string>()
  private liveSeq = 0
  private toolsRevision = 0
  private dispatchedCalls: ReadonlySet<string> = new Set()
  private lastDraft: LiveAssistantDraft | undefined
  private historyFloorSeq: number | undefined
  private stateModel: { readonly state: ConversationFeedState, readonly model: TranscriptModel } | undefined
  private caches = createTranscriptModelCaches()
  /** A tools/change landed: only the tool half of the next conversion must rebuild. */
  private toolsStale = false
  private disposed = false

  constructor(
    private readonly projections: ConversationProjectionSource,
    private readonly tools: ToolPresentationSource,
    private readonly publish: (force?: boolean) => void,
    private readonly live?: LiveDraftSource,
    private readonly t: MayflyTranslate = interpolateLocaleMessage,
    private readonly counters?: MayflyWorkCounters,
  ) {}

  /** Convert the latest unread value once, then reuse its model; convert stashed tools lazily. */
  snapshot(): TranscriptModel {
    const feed = this.feed
    if (feed === undefined) return this.model
    const draft = feed.draft()
    const pending = feed.take()
    if (pending !== undefined) {
      const visible = visibleProjection(pending.value, this.historyFloorSeq)
      if (visible !== undefined) {
        this.watermark = pending.seq
        feed.settle(pending.seq)
        this.lastVisible = visible
        this.durableModel = conversationTranscriptModel(visible, this.tools, this.generation, undefined, this.caches, this.counters)
        this.toolsStale = false
        this.dispatchedCalls = new Set(visible.entries.flatMap(entry => entry.kind === 'tool' ? [entry.callId] : []))
        this.settledSteps = new Set(visible.settledSteps)
        this.liveSeq = Math.max(visible.entries.at(-1)?.seq ?? pending.seq, pending.seq) + 1
        this.lastDraft = draft
        this.model = withLiveDraft(this.durableModel, this.settledSteps, draft, this.liveSeq, this.watermark, this.dispatchedCalls)
      }
    } else if (this.toolsStale && this.durableModel !== undefined && this.lastVisible !== undefined) {
      // The displayed view converts its own tool layer on the next snapshot;
      // hidden views keep the stale models stashed until they are shown.
      this.toolsStale = false
      this.rebuildTools()
    } else if (draft !== this.lastDraft && this.durableModel !== undefined) {
      this.lastDraft = draft
      this.model = withLiveDraft(this.durableModel, this.settledSteps, draft, this.liveSeq, this.watermark, this.dispatchedCalls)
    }
    return this.durableModel === undefined ? this.feedStateModel(feed.state()) : this.model
  }

  /**
   * Mark the durable tool layer stale without converting it: the next
   * {@link snapshot} re-resolves presenters for the stashed projection.
   */
  markToolsStale(): void {
    if (this.disposed) return
    this.toolsRevision += 1
    this.caches = { entries: this.caches.entries, tools: new WeakMap(), models: new WeakMap(), groups: new WeakMap() }
    this.toolsStale = true
  }

  /** Re-resolve durable tool presenters on the next snapshot without changing session generation. */
  invalidateTools(): void {
    this.markToolsStale()
  }

  /** Rebuild only the tool layer of the stashed projection, keeping every non-tool entry model. */
  private rebuildTools(): void {
    const visible = this.lastVisible!
    this.durableModel = conversationTranscriptModel(visible, this.tools, this.generation, `tools:${String(this.toolsRevision)}`, this.caches, this.counters)
    const draft = this.feed?.draft()
    this.lastDraft = draft
    this.model = withLiveDraft(this.durableModel, this.settledSteps, draft, this.liveSeq, this.watermark, this.dispatchedCalls)
  }

  /** Follow one live Session, clearing stale content first. */
  attach(session: Session | null, historyFloorSeq?: number, agent?: Agent): void {
    if (this.disposed) return
    // A resumed or reloaded Agent may carry a different Session object for the same identity: the live channel follows
    // the identity, not the object, or a replacement would silently lose the transient draft.
    const bound = agent !== undefined && session !== null && String(agent.session.id) === String(session.id) ? agent : undefined
    this.attachFeed(session === null ? undefined : new SessionConversationFeed(
      this.projections,
      session,
      bound,
      this.live,
      (force) => this.publish(force),
    ), historyFloorSeq)
  }

  /** Read one feed from now on, disposing the previous one and clearing stale content. */
  attachFeed(feed: ConversationFeed | undefined, historyFloorSeq?: number): void {
    if (this.disposed) {
      feed?.dispose()
      return
    }
    this.feed?.dispose()
    this.feed = feed
    this.historyFloorSeq = historyFloorSeq
    this.generation += 1
    this.watermark = -1
    this.durableModel = undefined
    this.lastVisible = undefined
    this.caches = createTranscriptModelCaches()
    this.toolsStale = false
    this.settledSteps.clear()
    this.lastDraft = undefined
    this.stateModel = undefined
    this.model = createTranscriptModel('official-conversation', [], false, this.generation)
    this.publish()
  }

  /** Drop the feed and reject every late callback. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.feed?.dispose()
    this.feed = undefined
    this.durableModel = undefined
    this.lastVisible = undefined
    this.caches = createTranscriptModelCaches()
    this.toolsStale = false
    this.settledSteps.clear()
    this.lastDraft = undefined
    this.historyFloorSeq = undefined
    this.stateModel = undefined
    this.model = createTranscriptModel('official-conversation', [], false)
  }

  /** A loading or failure placeholder, stable per feed state so rows stay cached. */
  private feedStateModel(state: ConversationFeedState): TranscriptModel {
    if (state.kind === 'ready') return this.model
    if (this.stateModel?.state === state) return this.stateModel.model
    const node = state.kind === 'loading'
      ? { kind: 'loader' as const, message: this.t('loading conversation...'), variant: 'gap' as const }
      : {
          kind: 'empty' as const,
          title: this.t('conversation unavailable'),
          description: this.t(FEED_FAILURE_COPY[state.reason], { error: state.detail ?? '' }),
        }
    const model = createTranscriptModel('official-conversation', [node], false, this.generation)
    this.stateModel = { state, model }
    return model
  }
}

/**
 * Durable evidence the draft's turn already ended or was superseded: its turn
 * row carries an end time, a newer turn row exists, or a newer durable entry
 * does. Mirrors the session-facts fence so a stale stream draft never reopens
 * a settled turn (the step-level `settledSteps` gate misses abandoned attempts,
 * which finalize nothing).
 * @param durable - the already-mapped durable model.
 * @param turn - the draft's pinned turn.
 * @returns whether the draft is provably behind the durable projection.
 */
function staleTurn(durable: TranscriptModel, turn: number): boolean {
  /* durable models all come from conversationTranscriptModel, which always emits turns */
  const turns = durable.turns!
  if (turns.some(item => item.turn > turn || (item.turn === turn && item.endedAt !== undefined))) return true
  const last = durable.entries.findLast((entry): entry is TranscriptEntryModel => entry.kind.startsWith('transcript-'))
  return last !== undefined && last.turn > turn
}

/**
 * Overlay only the current step onto the already-mapped durable model. Stable
 * history entries retain identity and never rerun their tool presenters during
 * token updates. Live revision tokens remain separate from durable event seqs.
 */
function withLiveDraft(
  durable: TranscriptModel,
  settledSteps: ReadonlySet<string>,
  draft: LiveAssistantDraft | undefined,
  seq: number,
  updatedSeq: number,
  dispatched: ReadonlySet<string>,
): TranscriptModel {
  if (draft === undefined || settledSteps.has(`${String(draft.turn)}:${String(draft.step)}`) || staleTurn(durable, draft.turn)) return durable
  const renderRevision = `live:${draft.attemptId}:${String(draft.revision)}`
  const liveEntries: TranscriptEntryModel[] = []
  // A recorded span proves visible reasoning without trimming the whole text.
  if (draft.reasoningSpan !== undefined || draft.reasoning.trim() !== '') {
    const thinking = draft.phase === 'thinking'
    const span = draft.reasoningSpan
    liveEntries.push({
      kind: 'transcript-thinking',
      id: `thinking:${String(draft.turn)}:${String(draft.step)}`,
      seq,
      updatedSeq,
      renderRevision,
      turn: draft.turn,
      step: draft.step,
      text: draft.reasoning,
      streaming: thinking,
      ...(thinking ? { outputProgress: draft.outputProgress } : {}),
      ...(span === undefined ? {} : { startedAt: span.startedAt, ...(thinking ? {} : { durationMs: Math.max(0, span.endedAt - span.startedAt) }) }),
    })
  }
  if (draft.text !== '') {
    liveEntries.push({
      kind: 'transcript-assistant',
      id: `assistant:${String(draft.turn)}:${String(draft.step)}`,
      seq,
      updatedSeq,
      renderRevision,
      turn: draft.turn,
      step: draft.step,
      text: draft.text,
      streaming: true,
    })
  }
  for (const call of draft.preparing ?? []) {
    if (dispatched.has(call.id)) continue
    liveEntries.push({ kind: 'transcript-tool', id: `preparing:${call.id}`, seq, updatedSeq, renderRevision,
      turn: draft.turn, step: draft.step, callId: call.id, name: call.name, family: 'other',
      activity: toolActivity(call.name), detail: '', arguments: call.arguments, startedAt: call.startedAt,
      preparing: { characters: call.characters },
    })
  }
  return freezeModel({ ...durable, entries: durable.entries, live: { turn: draft.turn, step: draft.step, entries: liveEntries }, streaming: true }) as TranscriptModel
}
