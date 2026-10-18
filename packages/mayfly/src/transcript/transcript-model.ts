/**
 * Renderer-neutral transcript projection consumer and the controller that publishes it. The selected session supplies
 * one source; this module keeps one stream view per displayed or retained conversation, maps the displayed model to the
 * stream's facts, and publishes `TranscriptView` into the conversation node slot. It owns neither widths nor rows: the
 * screen compiles the node and scrolls it.
 *
 * @module @ephemeral-ai/mayfly/transcript/transcript-model
 */

import type { MayflyUiEvent, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { latestTurnOf, queuedIdOf, STREAM, streamTarget, TranscriptStream, type StreamRow, type TranscriptViewFacts } from '../components/transcript-view.ts'
import type { MayflyNodeSlot } from '../core/node-slot.ts'
import type { MayflySearchLine } from '../core/search-line.ts'
import type { MayflyScreenService } from '../core/screen.ts'
import type { MayflyDecisionRequest, MayflyFocusMode, MayflyFocusRow, MayflyQueuedAction, MayflyScreen } from '../core/types.ts'
import type { MayflyWorkCounters } from '../core/ui-work-counters.ts'
import type { ApprovalMark, CompactionMark } from '../conversation/types.ts'
import type { MayflyTranslate } from '../frontend/locale.ts'
import { freezeModel, materializeTranscriptEntries, type TranscriptEntryModel, type TranscriptModel, type TranscriptTurnModel } from '../frontend/models.ts'
import { NO_DISCLOSURE, toggleCall, toggleGroup, toggleRows, toggleTurn, type Disclosure } from './disclosure.ts'
import type { CopyMode } from './row-text.ts'
import { findHits, readPattern, type SearchPattern, type SearchResult } from './search.ts'
import { messageRowIds, NewMessages, type NewMessagesHost } from './new-messages.ts'
import { StreamFacts } from './stream-facts.ts'
import type { TickSource } from './tick.ts'
import type { SpawnedChildren } from './tool-calls.ts'
import {
  DEFAULT_TRANSCRIPT_PRESENTATION,
  type TranscriptPresentationPolicy,
  type TranscriptPresentationSnapshot,
} from './presentation-policy.ts'

type Source = TranscriptModel | (() => TranscriptModel | null)

/** The screen as the transcript uses it: the L1 contract and the conversation node slot. */
export type TranscriptScreen = MayflyScreen & Pick<MayflyScreenService, 'mountNodeSlot' | 'mountSearchLine' | 'contentTail' | 'watchContentTail' | 'scrollContentTo'>

/** What the controller reads besides the models: the policy, the translator, and the messages queued behind the stream. */
export interface TranscriptControllerOptions {
  readonly presentation?: TranscriptPresentationPolicy
  readonly t: MayflyTranslate
  /** The messages the user typed while the agent works; read on every publish. */
  readonly queued: () => readonly { readonly id: string, readonly text: string, readonly lane: 'turn' | 'step' }[]
  /** The requests waiting on the user, in the order they were asked; read on every publish. */
  readonly requests?: () => readonly MayflyDecisionRequest[]
  /** The clock a call that is in flight keeps its time by; absent, the stream's time only moves when it is published. */
  readonly tick?: TickSource
  /** The selected Agent's context window and occupancy and the marks around each recent compaction; read on every publish. */
  readonly context?: () => { readonly marks?: readonly CompactionMark[] | undefined, readonly window?: number | undefined, readonly tokens?: number | undefined, readonly approvals?: readonly ApprovalMark[] | undefined, readonly children?: SpawnedChildren | undefined } | undefined
  /** Where the references of the images the stream shows are kept for the byte loader. */
  readonly imageRefs?: Map<string, { readonly attachmentId: string, readonly mediaType: string }>
  /** What `c` and `Ctrl+G` do with the row under the cursor. */
  readonly rows?: StreamRowActions
  /** Called when the stream gains or loses keyboard focus, for the mode the status line names. */
  readonly focusMode?: (mode: MayflyFocusMode) => void
  /** Called when the stream's cursor moves onto or off a queued message, for the keys the notification row teaches. */
  readonly focusRow?: (row: MayflyFocusRow) => void
  /** The clock and timers the new-messages marker counts its time on screen by; absent, the platform's. */
  readonly clock?: {
    readonly now: () => number
    readonly setTimeout: (callback: () => void, ms: number) => unknown
    readonly clearTimeout: (handle: unknown) => void
  }
  /** Optional work sink for stream mapping and row construction; production passes none. */
  readonly counters?: MayflyWorkCounters
}

/**
 * The least time between two publishes of a model that keeps changing (live text, a burst of events). The first change of a
 * quiet period publishes at once; the ones inside this window become one trailing publish with the newest model.
 */
export const PUBLISH_INTERVAL_MS = 30

/** The window grows with what a publish costs (this many times its duration), so a long history leaves the loop time to idle. */
const PUBLISH_COST_FACTOR = 3

/** The longest the window grows to. */
const PUBLISH_INTERVAL_MAX_MS = 200

/**
 * The most a live turn's publish waits. A live turn is what the reader is watching, so it keeps a short, fixed budget
 * instead of growing with the mapping cost; the trailing publish still carries the newest model.
 */
export const LIVE_PUBLISH_MS = 50

/**
 * The longest a live turn may stand still, even when a live notification is lost or coalesced away. The watchdog asks
 * for one publish only when a change is still pending, and only while the model carries a live turn.
 */
export const STREAM_WATCHDOG_MS = 250

/** What a row under the cursor can be sent to: the clipboard, or the editor. */
export interface StreamRowActions {
  /** Copy the row's content; `raw` is the model's JSON. */
  copy(text: string, mode: CopyMode): void
  /** Read the row's content in `$EDITOR`. */
  open(text: string): void
  /** Do something to a queued message (`id`) the cursor stands on; `undo` takes the last cancelled one back and has no id. */
  queued(action: MayflyQueuedAction, id: string | undefined): void
}

/** How one retained view differs from the default. */
export interface TranscriptViewOptions {
  /**
   * Keep the running turn's header. Only for views with no activity row (which otherwise owns every live fact), such as
   * a read-only child conversation.
   */
  readonly liveTurnHeader?: boolean
}

/** Build an immutable transcript model from already-projected entries. */
export function createTranscriptModel(
  id: string,
  entries: readonly (MayflyUiNode | TranscriptEntryModel)[],
  streaming?: boolean,
  generation = 0,
  turns?: readonly TranscriptTurnModel[],
): TranscriptModel {
  return freezeModel({
    kind: 'transcript', id, generation, entries: [...entries],
    ...(streaming === undefined ? {} : { streaming }),
    ...(turns === undefined ? {} : { turns: [...turns] }),
  })
}

/** Append one projected canonical node or semantic entry without folding events. */
export function appendTranscriptNode(
  model: TranscriptModel,
  entry: MayflyUiNode | TranscriptEntryModel,
  streaming = model.streaming,
): TranscriptModel {
  return createTranscriptModel(model.id, [...materializeTranscriptEntries(model), entry], streaming, model.generation, model.turns)
}

const EMPTY_RESULT: SearchResult = { hits: [], turnStart: new Map(), orders: new Map() }

/** The keys the stream answers itself while it holds focus: the interrupt key's second meaning, and the two searches. */
const BASE_KEYS = { 'ctrl+c': STREAM.copyRaw, '/': STREAM.findDown, '?': STREAM.findUp, e: STREAM.queuedEdit, s: STREAM.queuedSteer, d: STREAM.queuedCancel, u: STREAM.queuedUndo } as const

/** Once a search is accepted the arrows walk its matches, and `n`/`N` go on and back in the direction it was made. */
const SELECT_KEYS = { ...BASE_KEYS, up: STREAM.matchPrev, down: STREAM.matchNext, n: STREAM.matchAgain, 'shift+n': STREAM.matchBack } as const

/** The corpus a search's hits were found in: the durable and live entry arrays, and the pattern. */
interface SearchCorpus {
  readonly entries: TranscriptModel['entries']
  readonly liveEntries: readonly (MayflyUiNode | TranscriptEntryModel)[] | undefined
  readonly pattern: SearchPattern
  readonly result: SearchResult
}

/** A search of the displayed conversation: its line above the editor, the pattern, what it found, and which hit the stream stands on. */
interface StreamSearchState {
  readonly line: MayflySearchLine
  /** `/` goes toward the newer rows, `?` toward the older. */
  readonly forward: boolean
  pattern: string
  read: SearchPattern
  /** `input`: the pattern is being typed and only highlights; `select`: it was accepted and the cursor walks the matches. */
  phase: 'input' | 'select'
  /** The model the hits were found in: a new model means the hits are found again. */
  model: TranscriptModel | null
  result: SearchResult
  /** The corpus `result` was found in: a model whose two entry arrays are unchanged reuses the hits, a draft does not. */
  corpus?: SearchCorpus
  /** The hit the cursor stands on, in `result.hits`; `-1` while none is chosen. */
  index: number
  /** The turns the search has stood in: they stay mounted and open until the search ends, so the hits already seen stay in view. */
  visited: Set<number>
}

/** One retained conversation view: its source, its options, and the facts it keeps by identity. */
interface ControllerView {
  readonly source: Source
  readonly options: TranscriptViewOptions
  readonly facts: StreamFacts
  /** The marker for the messages that arrived while the reader was scrolled away. */
  readonly fresh: NewMessages
}

/**
 * The one conversation controller behind the fixed transcript slot. It keeps the facts of each retained view, so
 * switching the displayed conversation republishes the others' unchanged rows by identity.
 */
export class TranscriptController {
  private readonly views = new Map<string, ControllerView>()
  private active: string | undefined
  private slot: MayflyNodeSlot | undefined
  private screen: TranscriptScreen | undefined
  private disclosure: Disclosure = NO_DISCLOSURE
  /** Counts the times focus moved into the stream; the list sends its cursor to the newest row once per count. */
  private cursorRev = 0
  /** The cursor send the slot's focus was last moved for. */
  private sentRev = 0
  /** Where the next cursor send lands, before the newest row: the rows a turn's toggle turned its own row into. */
  private cursorIds: readonly string[] | undefined
  private offTick: (() => void) | undefined
  private search: StreamSearchState | undefined
  /** The search is open, or opening: the stream's focus changes are the search's to announce. */
  private searching = false
  /** The next focus the stream takes keeps its cursor (a search ended or was abandoned). */
  private resume = false
  /** The stream holds keyboard focus. */
  private focused = false
  /** What the cursor stands on that has keys of its own, last told to `focusRow`. */
  private row: MayflyFocusRow
  /** The cursor row last seen while the stream held focus: only a real move asks the content to reveal it. */
  private lastCursor: string | undefined
  /** The focused cursor moved out of view: the next content layout scrolls the least that shows it. */
  private pendingReveal = false

  /** What the displayed view's new-messages marker asks of the screen and the stream. */
  private readonly freshHost: NewMessagesHost = {
    tail: () => this.screen?.contentTail(),
    row: () => this.slot?.trackedRow(),
    scrollTo: (row) => { this.screen?.scrollContentTo(row) },
    scrollUp: (rows) => { this.screen?.scrollContent('up', rows) },
    follow: () => { this.screen?.followContent() },
    republish: () => {
      this.publish()
      this.screen?.requestRender()
    },
    now: () => this.options.clock?.now() ?? Date.now(),
    setTimeout: (callback, ms) => this.options.clock?.setTimeout(callback, ms) ?? setTimeout(callback, ms),
    clearTimeout: (handle) => { if (this.options.clock === undefined) clearTimeout(handle as ReturnType<typeof setTimeout>); else this.options.clock.clearTimeout(handle) },
  }
  private offLayout: (() => void) | undefined
  /** When the stream was last published, and the trailing publish a burst of changes waits for. */
  private lastPublishAt = Number.NEGATIVE_INFINITY
  /** How long the last publish took: the window after it grows with it. */
  private publishCostMs = 0
  private trailing: unknown
  /** The tick time a trailing publish carries, when the request came from the clock; a refresh publishes at its own fire time. */
  private trailingNow: number | undefined
  /** The displayed model carries a live turn: it publishes on the fixed live budget and keeps the watchdog armed. */
  private streaming = false
  /** A change arrived since the last publish; the watchdog publishes only when one did. */
  private dirty = false
  /** The model the last publish read: the watchdog compares it to catch a live notification that never arrived. */
  private publishedModel: TranscriptModel | null = null
  /** The watchdog's next check while a live turn is displayed. */
  private watchdog: unknown

  constructor(private readonly options: TranscriptControllerOptions) {}

  attach(screen: TranscriptScreen): void {
    this.unmount()
    this.screen = screen
    this.mount()
  }

  /**
   * Create or replace one retained view.
   * @param key - stable view key, such as the conversation id.
   * @param source - the view's model source.
   * @param options - how this view differs from the default.
   */
  setView(key: string, source: Source, options: TranscriptViewOptions = {}): void {
    this.views.get(key)?.fresh.reset()
    this.views.set(key, { source, options, facts: new StreamFacts(this.options.counters), fresh: new NewMessages(this.freshHost) })
    if (key === this.active) this.publish()
  }

  /** Display one retained view. */
  show(key: string | undefined): void {
    if (key === this.active) return
    const switched = this.active !== undefined && key !== undefined
    this.closeSearch()
    // A marker belongs to the conversation it was made in, and the reader comes back to a view at its newest content.
    if (this.active !== undefined) this.views.get(this.active)?.fresh.reset()
    this.active = key
    if (key !== undefined) this.views.get(key)?.fresh.reset()
    this.pendingReveal = false
    this.lastCursor = undefined
    this.publish()
    // A different conversation opens at its newest content.
    if (switched) this.screen?.followContent()
  }

  /** Dispose one retained view. */
  dropView(key: string): void {
    this.views.get(key)?.fresh.reset()
    if (this.views.delete(key) && key === this.active) {
      this.active = undefined
      this.publish()
    }
  }

  /**
   * The displayed model changed: publish it. The screen follows the tail, or counts what arrived below a view scrolled away.
   * `force` bypasses the publish window: a settlement has already waited for the window and must not wait for it again.
   */
  refresh(force = false): void {
    this.dirty = true
    this.requestPublish(undefined, force)
  }

  /**
   * Publish a change at the end of the window after the last publish, or at once outside one. The first change of a
   * quiet period is immediate; the ones inside a burst become one trailing publish with the newest model. A tick's
   * `now` rides along so the trailing publish reads the time the tick named. A live turn uses the fixed live budget
   * instead of the adaptive one; `force` publishes now and drops the trailing publish.
   */
  private requestPublish(now?: number, force = false): void {
    if (this.active === undefined || this.screen === undefined) return
    if (force) {
      this.publishNow(now)
      return
    }
    if (this.trailing !== undefined) {
      if (now !== undefined) this.trailingNow = now
      return
    }
    const window = this.streaming
      ? LIVE_PUBLISH_MS
      : Math.min(PUBLISH_INTERVAL_MAX_MS, Math.max(PUBLISH_INTERVAL_MS, this.publishCostMs * PUBLISH_COST_FACTOR))
    const wait = this.lastPublishAt + window - (now ?? this.nowMs())
    if (wait <= 0) {
      this.publishNow(now)
      return
    }
    // Inside the window of the last publish: one publish at its end reads whatever the model is by then.
    this.trailingNow = now
    const clock = this.options.clock
    const publishLater = (): void => {
      const at = this.trailingNow
      this.trailing = undefined
      this.trailingNow = undefined
      this.publishNow(at)
    }
    this.trailing = clock?.setTimeout(publishLater, wait) ?? setTimeout(publishLater, wait)
    if (this.trailing !== undefined && typeof (this.trailing as { unref?: unknown }).unref === 'function') (this.trailing as { unref(): void }).unref()
  }

  private publishNow(now?: number): void {
    if (this.active === undefined || this.screen === undefined) return
    this.publish(now ?? this.nowMs())
    this.screen.requestRender()
  }

  private nowMs(): number { return this.options.clock?.now() ?? Date.now() }

  private cancelTrailing(): void {
    if (this.trailing === undefined) return
    if (this.options.clock === undefined) clearTimeout(this.trailing as ReturnType<typeof setTimeout>)
    else this.options.clock.clearTimeout(this.trailing)
    this.trailing = undefined
    this.trailingNow = undefined
  }

  /** Something other than the model moved (the queued messages): publish again without announcing new content. */
  republish(): void {
    this.dirty = true
    this.requestPublish()
  }

  /** Ctrl-O: open or close the Verbose tier of the newest turns. @returns whether they are open now. */
  toggleRecent(): boolean {
    this.disclosure = { ...this.disclosure, recent: !this.disclosure.recent }
    this.publish()
    return this.disclosure.recent
  }

  /** Enter on a turn header: flip that turn against what the level and Ctrl-O give. */
  toggleTurn(turn: number): void {
    this.disclosure = toggleTurn(this.disclosure, turn)
    this.publish()
  }

  /** Enter on a row: open the entries it stands for to their Verbose tier, or put them back. */
  toggleRows(ids: readonly string[]): void {
    this.disclosure = toggleRows(this.disclosure, ids)
    this.publish()
  }

  private setDisclosure(disclosure: Disclosure): void {
    this.disclosure = disclosure
    this.publish()
  }

  /**
   * `/` (toward the newer rows) or `?` (toward the older) in conversation mode: open the search line above the editor. The
   * pattern is a regular expression; while it is typed the stream only highlights it, and `Enter` accepts it.
   */
  beginSearch(forward: boolean): void {
    const screen = this.screen
    if (screen === undefined || this.slot === undefined || this.active === undefined) return
    this.search?.line.dispose()
    this.searching = true
    const line = screen.mountSearchLine({
      prefix: forward ? '/' : '?',
      onChange: pattern => { this.patternChanged(pattern) },
      onAccept: () => { this.acceptSearch() },
      onAbandon: () => { this.endSearch() },
    })
    const model = this.model()
    this.search = { line, forward, pattern: '', read: { kind: 'empty' }, phase: 'input', model, result: EMPTY_RESULT, index: -1, visited: new Set() }
    this.search.result = this.searchHits(this.search, model)
    this.disclosure = { ...this.disclosure, forced: new Set() }
    // The stream keeps the window it had around its cursor while the line holds the keys.
    this.slot.spotlight(true)
    this.slot.setKeys(BASE_KEYS)
    this.options.focusMode?.('search')
    this.publish()
  }

  /**
   * End the search: the levels come back, the highlight goes, and the keys return to the conversation. Where the cursor
   * stood on a match, it stays on that row (or on its turn's header when the row folded away).
   */
  endSearch(): void {
    const search = this.search
    if (search === undefined) return
    const row = search.phase === 'select' ? this.slot?.cursor(STREAM.list) : undefined
    const turn = search.result.hits[search.index]?.turn
    this.stopSearching()
    if (row !== undefined) {
      this.cursorIds = [row, ...turn === undefined ? [] : [`turn-header:${String(turn)}`, `process:${String(turn)}`]]
      this.cursorRev += 1
    }
    this.resume = true
    this.options.focusMode?.('conversation')
    this.publish()
    this.slot?.focus()
  }

  /** The search goes without the keys returning: another conversation is shown, or the controller leaves. */
  closeSearch(): void {
    if (this.search === undefined) return
    this.stopSearching()
    this.options.focusMode?.('prompt')
    this.publish()
  }

  private stopSearching(): void {
    const search = this.search
    if (search === undefined) return
    this.search = undefined
    this.searching = false
    search.line.dispose()
    this.slot?.spotlight(false)
    this.slot?.setKeys(BASE_KEYS)
    this.disclosure = { ...this.disclosure, forced: new Set() }
  }

  private patternChanged(pattern: string): void {
    const search = this.search
    if (search === undefined) return
    search.pattern = pattern
    search.read = readPattern(pattern)
    search.model = this.model()
    search.result = this.searchHits(search, search.model)
    search.index = -1
    this.publish()
  }

  /** `Enter` on the pattern: the cursor goes to the first match past where it stood, and the matches become the stream's rows to walk. */
  private acceptSearch(): void {
    const search = this.search
    if (search === undefined || search.result.hits.length === 0) return
    const facts = this.active === undefined ? undefined : this.views.get(this.active)?.facts
    const cursor = this.slot?.cursor(STREAM.list)
    const owner = cursor === undefined ? undefined : facts?.locate(cursor)
    const orders = owner === undefined ? [] : owner.parts.flatMap(part => search.result.orders.get(part) ?? [])
    const start = owner?.turn === undefined ? undefined : search.result.turnStart.get(owner.turn)
    const hits = search.result.hits
    const first = orders.length > 0 ? Math.min(...orders) : start
    const last = orders.length > 0 ? Math.max(...orders) : start
    let index: number
    // The row the cursor stands on counts: its own first match (for `/`) or last (for `?`) is where the search lands.
    if (first === undefined || last === undefined) index = search.forward ? hits.length - 1 : 0
    else if (search.forward) index = hits.findIndex(hit => hit.order >= first)
    else index = hits.findLastIndex(hit => hit.order <= last)
    // Past the last match (or before the first) the search wraps to the other end.
    if (index < 0) index = search.forward ? 0 : hits.length - 1
    search.index = index
    search.phase = 'select'
    search.line.freeze()
    this.slot?.setKeys(SELECT_KEYS)
    this.resume = true
    this.options.focusMode?.('search-select')
    this.slot?.focus()
    this.land(search.forward ? 1 : -1)
  }

  /** `↑`/`↓` and `n`/`N` on the matches: the cursor moves to the previous or next one, wrapping. */
  searchStep(step: number): void {
    const search = this.search
    if (search === undefined || search.phase !== 'select' || search.result.hits.length === 0) return
    search.index = (search.index + step + search.result.hits.length) % search.result.hits.length
    this.land(step)
  }

  /** `n` goes on in the direction of the search, `N` back. */
  searchRepeat(sameWay: boolean): void {
    const search = this.search
    if (search !== undefined) this.searchStep(search.forward === sameWay ? 1 : -1)
  }

  /**
   * Stand the stream on the hit at the search's index: its turn is mounted and open, and the cursor goes to the row that
   * draws it. A hit no row draws is passed over in the direction of the step.
   */
  private land(step: number): void {
    const search = this.search
    if (search === undefined) return
    const facts = this.active === undefined ? undefined : this.views.get(this.active)?.facts
    const hits = search.result.hits
    let landed = false
    for (let tries = 0; tries < Math.max(1, hits.length); tries += 1) {
      const hit = hits[search.index]
      if (hit === undefined || facts === undefined) break
      search.visited.add(hit.turn)
      this.disclosure = { ...this.disclosure, forced: new Set(search.visited) }
      // A row the stream already draws can take the cursor in the one publish that also mounts the visited turn.
      const drawn = facts.rowOf(hit.part)
      if (drawn !== undefined) {
        this.cursorIds = [drawn]
        this.cursorRev += 1
        this.publish()
        landed = true
        break
      }
      // The turn was not mounted: build it to see whether it draws the hit at all.
      this.publish()
      const row = facts.rowOf(hit.part)
      if (row !== undefined) {
        this.cursorIds = [row]
        this.cursorRev += 1
        this.publish()
        landed = true
        break
      }
      search.index = (search.index + step + hits.length) % hits.length
    }
    // A search that found no row still publishes its visited turns once, after the walk.
    if (!landed) this.publish()
  }

  private searchStatus(search: StreamSearchState): string {
    const t = this.options.t
    const total = search.result.hits.length
    if (search.read.kind === 'invalid') return t('Invalid regular expression · Esc to cancel')
    if (search.phase === 'select') return t(total === 1 ? '{index}/{total} match' : '{index}/{total} matches', { index: search.index + 1, total })
    if (search.read.kind === 'empty') return t('Type a regular expression · Enter to select · Esc to cancel')
    if (total === 0) return t('No matches · Esc to cancel')
    return t(total === 1 ? '{total} match · Enter to select · Esc to cancel' : '{total} matches · Enter to select · Esc to cancel', { total })
  }

  /** The displayed conversation's model, or `null`. */
  private model(): TranscriptModel | null {
    const view = this.active === undefined ? undefined : this.views.get(this.active)
    return view === undefined ? null : typeof view.source === 'function' ? view.source() : view.source
  }

  /** Re-read the presentation policy and publish every row again. */
  refreshPresentationPolicy(): void {
    this.rewrite()
  }

  /** Re-translate every row after a locale revision. */
  refreshLocale(): void {
    this.rewrite()
  }

  /** Expose the current immutable policy for diagnostics and tests. */
  presentationPolicy(): TranscriptPresentationSnapshot {
    return this.options.presentation?.snapshot() ?? DEFAULT_TRANSCRIPT_PRESENTATION
  }

  /**
   * Ctrl+↓: bring the marker of the messages the reader has not seen to the top of the view, or follow the tail when
   * there is none to go to.
   */
  jumpNew(): void {
    const view = this.active === undefined ? undefined : this.views.get(this.active)
    if (view === undefined) this.screen?.followContent()
    else view.fresh.jump()
  }

  dispose(): void {
    this.cancelTrailing()
    this.stopWatchdog()
    this.streaming = false
    this.dirty = false
    this.offTick?.()
    this.offTick = undefined
    this.unmount()
    this.views.clear()
    this.active = undefined
    this.screen = undefined
  }

  /** Texts and policy changed under the same ids: forget the kept rows and publish. */
  private rewrite(): void {
    for (const view of this.views.values()) {
      view.facts.reset()
      view.fresh.reset()
    }
    this.publish()
    this.screen?.requestRender(true)
  }

  private publish(now = Date.now()): void {
    this.cancelTrailing()
    const started = performance.now()
    try {
      this.publishFacts(now)
    } finally {
      this.dirty = false
      this.publishCostMs = performance.now() - started
      this.lastPublishAt = this.nowMs()
    }
  }

  /** The displayed view's current model, or `null` when no view is displayed. */
  private currentModel(): TranscriptModel | null {
    const view = this.active === undefined ? undefined : this.views.get(this.active)
    return view === undefined ? null : typeof view.source === 'function' ? view.source() : view.source
  }

  private publishFacts(now: number): void {
    const slot = this.slot
    if (slot === undefined) return
    const view = this.active === undefined ? undefined : this.views.get(this.active)
    const model = this.currentModel()
    this.publishedModel = model
    this.syncSearch(model)
    if (view === undefined || model === null) {
      this.setStreaming(false)
      slot.set(null)
      slot.track(STREAM.list, undefined)
      slot.setMarked(false)
      slot.setTurns(0)
      return
    }
    this.setStreaming(model.streaming === true || model.live !== undefined)
    const built = view.facts.build(model, {
      policy: this.presentationPolicy(),
      disclosure: this.disclosure,
      liveTurnHeader: view.options.liveTurnHeader === true,
      t: this.options.t,
      now,
      queued: this.options.queued(),
      requests: this.options.requests?.() ?? [],
      ...this.compactionInputs(),
      ...(this.options.imageRefs === undefined ? {} : { imageRefs: this.options.imageRefs }),
    })
    // Rows that arrive while the view is scrolled away from the tail are the ones the reader has not seen: a rule marks the first.
    const boundary = view.fresh.observe(messageRowIds(built), this.screen?.contentTail()?.away === true)
    const facts = boundary === undefined ? built : view.fresh.insert(built, boundary, this.options.t('New messages'))
    slot.track(STREAM.list, view.fresh.rowId)
    slot.setMarked(view.fresh.pending)
    slot.setTurns(latestTurnOf(facts))
    const ids = this.cursorIds ?? []
    const node = TranscriptStream(facts, this.cursorRev === 0 ? undefined : { rev: this.cursorRev, ...ids.length === 0 ? {} : { ids } }, this.search === undefined || this.search.read.kind !== 'ok' ? undefined : { pattern: this.search.pattern, caseSensitive: this.search.read.caseSensitive, ...this.search.phase === 'select' && this.search.index >= 0 ? { current: this.search.result.hits[this.search.index]!.nth } : {} })
    slot.set(node)
    // A cursor just sent also takes the keyboard focus, so the key that follows acts on that row.
    const target = streamTarget(node)
    if (target !== undefined && this.sentRev !== this.cursorRev) {
      this.sentRev = this.cursorRev
      slot.focusRow(STREAM.list, target)
    }
    this.keepTime(facts)
    // A live tail grows below the view; a reader already at the tail keeps seeing it, one scrolled away keeps the marker.
    if (this.streaming && this.screen?.contentTail()?.away !== true) this.screen?.followContent()
    // A queued row can leave or change lanes under a cursor that does not move: the keys follow what the row is now.
    if (this.focused) this.cursorRow(slot.cursor(STREAM.list))
  }

  /** Enter or leave the live-turn mode: the publish budget and the watchdog follow it. */
  private setStreaming(next: boolean): void {
    if (next === this.streaming) return
    this.streaming = next
    if (next) this.armWatchdog()
    else this.stopWatchdog()
  }

  /** Keep a floor under a live turn: a lost live notification costs at most {@link STREAM_WATCHDOG_MS}. */
  private armWatchdog(): void {
    if (this.watchdog !== undefined || !this.streaming) return
    const fire = (): void => {
      this.watchdog = undefined
      if (!this.streaming || this.screen === undefined) return
      // A scheduled trailing publish already reads the newest model; only a lost wake needs the floor's own publish.
      if (this.trailing === undefined && (this.dirty || this.currentModel() !== this.publishedModel)) this.requestPublish(undefined, true)
      // The publish may have ended the live turn (its settlement): only a still-live model keeps the floor.
      if (this.streaming) this.armWatchdog()
    }
    this.watchdog = this.options.clock?.setTimeout(fire, STREAM_WATCHDOG_MS) ?? setTimeout(fire, STREAM_WATCHDOG_MS)
    if (this.options.clock === undefined && typeof (this.watchdog as { unref?: unknown }).unref === 'function') (this.watchdog as { unref(): void }).unref()
  }

  private stopWatchdog(): void {
    if (this.watchdog === undefined) return
    if (this.options.clock === undefined) clearTimeout(this.watchdog as ReturnType<typeof setTimeout>)
    else this.options.clock.clearTimeout(this.watchdog)
    this.watchdog = undefined
  }

  /** A conversation that moved on while a search is open: its hits are found again, and the line says how many there are now. */
  private syncSearch(model: TranscriptModel | null): void {
    const search = this.search
    if (search === undefined) return
    if (model !== search.model) {
      const current = search.result.hits[search.index]
      search.model = model
      search.result = this.searchHits(search, model)
      const kept = current === undefined ? -1 : search.result.hits.findIndex(hit => hit.part === current.part && hit.nth === current.nth)
      search.index = search.phase === 'input' ? -1 : kept >= 0 ? kept : Math.min(search.index, search.result.hits.length - 1)
    }
    search.line.set(this.searchStatus(search))
  }

  /**
   * Find the hits of the search's pattern, reusing the last result while the model's durable and live entry arrays and
   * the pattern are the same objects. A durable publish replaces the durable array; a draft replaces only the live one.
   */
  private searchHits(search: StreamSearchState, model: TranscriptModel | null): SearchResult {
    if (model === null) return EMPTY_RESULT
    const liveEntries = model.live?.entries
    const corpus = search.corpus
    if (corpus !== undefined && corpus.entries === model.entries && corpus.liveEntries === liveEntries && corpus.pattern === search.read) return corpus.result
    const result = findHits(model, search.read)
    search.corpus = { entries: model.entries, liveEntries, pattern: search.read, result }
    return result
  }

  private compactionInputs(): { readonly compactions?: readonly CompactionMark[], readonly contextWindow?: number, readonly contextTokens?: number, readonly approvals?: readonly ApprovalMark[], readonly children?: SpawnedChildren } {
    const context = this.options.context?.()
    if (context === undefined) return {}
    return {
      ...context.marks === undefined ? {} : { compactions: context.marks },
      ...context.window === undefined ? {} : { contextWindow: context.window },
      ...context.tokens === undefined ? {} : { contextTokens: context.tokens },
      ...context.approvals === undefined ? {} : { approvals: context.approvals },
      ...context.children === undefined ? {} : { children: context.children },
    }
  }

  /** A call or a compaction in flight shows its own time, so the stream is built again at each tick while one is on screen. */
  private keepTime(facts: TranscriptViewFacts): void {
    const running = (row: StreamRow): boolean => (row.kind === 'tool' && row.state === 'pending') || (row.kind === 'compaction' && row.facts.state === 'running')
    const pending = facts.turns.some(turn => turn.rows.some(running) || (turn.after?.some(running) ?? false))
    if (!pending) {
      this.offTick?.()
      this.offTick = undefined
      return
    }
    if (this.offTick !== undefined || this.options.tick === undefined) return
    this.offTick = this.options.tick.subscribe((now) => {
      this.requestPublish(now)
    })
  }

  private mount(): void {
    const screen = this.screen
    if (screen === undefined) return
    this.slot = screen.mountNodeSlot('transcript.conversation', {
      region: 'content',
      // The stream's keys are taught on the notification pane while it holds focus, not on a row of its own.
      hints: false,
      // `ctrl+c` is reserved for interrupting, so the stream answers it itself while it holds focus.
      keys: BASE_KEYS,
      onEvent: event => { this.onEvent(event) },
      // The notification row teaches the keys of the row the cursor stands on.
      cursor: { control: STREAM.list, onMove: (itemId) => { if (this.focused) this.cursorRow(itemId) } },
      // Focus moves up into the stream at its newest row; `Esc` and `Alt+↓` give it back to the prompt.
      onFocus: () => {
        // A focused stream is windowed around its cursor, which the marker's line cannot be read from.
        if (this.active !== undefined) this.views.get(this.active)?.fresh.reset()
        // A search handing the keys back keeps the cursor where it stands.
        if (this.resume) {
          this.resume = false
          this.publish()
          return
        }
        // A focused stream shows the window around its cursor, so the view returns to the tail where the cursor starts: a
        // reader who had scrolled away would otherwise find the window below the view and nothing above it.
        this.screen?.followContent()
        this.cursorIds = undefined
        this.cursorRev += 1
        this.publish()
      },
      onFocusChange: (focused) => {
        this.focused = focused
        if (!focused) {
          this.cursorRow(undefined)
          this.pendingReveal = false
          this.lastCursor = undefined
        }
        if (!this.searching) this.options.focusMode?.(focused ? 'conversation' : 'prompt')
      },
      // `Esc` or `Alt+↓` while a search holds the cursor ends the search and stays in the conversation.
      onLeave: () => { if (this.search === undefined) this.slot?.release(); else this.endSearch() },
    })
    // After each layout of the content the marker reads where it stands against the view.
    this.offLayout = screen.watchContentTail(() => {
      if (this.active !== undefined) this.views.get(this.active)?.fresh.layout()
      this.revealCursor()
    })
    this.publish()
    screen.requestRender()
  }

  /** The stream's controls: where the cursor is, Enter on a row, and the keys that copy it or open it in the editor. */
  private onEvent(event: MayflyUiEvent): void {
    if (event.kind === 'selection-accept' && event.controlId === STREAM.list) this.accept(event.selectedIds[0])
    else if (event.kind === 'activate' && event.actionId === STREAM.copy) this.withRowText('text', text => this.options.rows?.copy(text, 'text'))
    else if (event.kind === 'activate' && event.actionId === STREAM.copyRaw) this.withRowText('raw', text => this.options.rows?.copy(text, 'raw'))
    else if (event.kind === 'activate' && event.actionId === STREAM.open) this.withRowText('text', text => this.options.rows?.open(text))
    else if (event.kind === 'activate' && event.controlId === 'keys') this.onKey(event.actionId)
  }

  /** The keys the stream answers itself: the searches, and while one is accepted the walk over its matches. */
  private onKey(actionId: string): void {
    if (actionId === STREAM.queuedEdit || actionId === STREAM.queuedSteer || actionId === STREAM.queuedCancel || actionId === STREAM.queuedUndo) this.queuedKey(actionId)
    else if (actionId === STREAM.findDown) this.beginSearch(true)
    else if (actionId === STREAM.findUp) this.beginSearch(false)
    else if (actionId === STREAM.matchPrev) this.searchStep(-1)
    else if (actionId === STREAM.matchNext) this.searchStep(1)
    else if (actionId === STREAM.matchAgain) this.searchRepeat(true)
    else if (actionId === STREAM.matchBack) this.searchRepeat(false)
  }

  /** `e`, `s`, `d` on a queued message under the cursor, and `u` (which needs no row) for the one cancelled last. */
  private queuedKey(actionId: string): void {
    if (actionId === STREAM.queuedUndo) {
      this.options.rows?.queued('undo', undefined)
      return
    }
    const facts = this.active === undefined ? undefined : this.views.get(this.active)?.facts
    const cursor = this.slot?.cursor(STREAM.list)
    const id = cursor === undefined ? undefined : queuedIdOf(cursor)
    if (id === undefined) return
    // The next turn's lane only: a steering message is already read at the running turn's next step.
    if (actionId === STREAM.queuedSteer && facts?.queuedLane(id) !== 'turn') return
    // The message changes lane, which takes its row away for a moment: the cursor waits for the row to come back.
    if (actionId === STREAM.queuedSteer) {
      this.cursorIds = [cursor!]
      this.cursorRev += 1
    }
    this.options.rows?.queued(actionId === STREAM.queuedEdit ? 'edit' : actionId === STREAM.queuedSteer ? 'steer' : 'cancel', id)
    // The message is in the prompt, ready to edit: the keyboard goes back to it.
    if (actionId === STREAM.queuedEdit) this.slot?.release()
  }

  /**
   * The focused stream's cursor moved out of view: scroll the content the least that shows the cursor's block. Runs after
   * a layout, when the flow list has painted its cursor line; a move that is already in view costs nothing.
   */
  private revealCursor(): void {
    if (!this.pendingReveal) return
    if (!this.focused) { this.pendingReveal = false; return }
    const row = this.slot?.cursorRow()
    const tail = this.screen?.contentTail()
    // No cursor painted yet (the frame has not rendered): ask again on the next layout.
    if (row === undefined || tail === undefined) return
    this.pendingReveal = false
    if (row < tail.top) this.screen?.scrollContentTo(row)
    else if (row >= tail.top + tail.viewport) this.screen?.scrollContentTo(row - tail.viewport + 1)
  }

  /** The row type the cursor stands on, told to the notification row so it teaches the keys that row has. */
  private cursorRow(itemId: string | undefined): void {
    // Only a move asks for a reveal: a manual scroll leaves the cursor out of view until the next key.
    if (this.focused && itemId !== this.lastCursor) {
      this.lastCursor = itemId
      if (itemId !== undefined) this.pendingReveal = true
    }
    const id = itemId === undefined ? undefined : queuedIdOf(itemId)
    const facts = this.active === undefined ? undefined : this.views.get(this.active)?.facts
    const lane = id === undefined ? undefined : facts?.queuedLane(id)
    const row: MayflyFocusRow = lane === undefined ? undefined : lane === 'step' ? 'steering' : 'queued'
    if (row === this.row) return
    this.row = row
    this.options.focusRow?.(row)
  }

  private accept(itemId: string | undefined): void {
    const facts = this.active === undefined ? undefined : this.views.get(this.active)?.facts
    // A queued message opens to its whole text and folds back; its row keeps the cursor.
    if (itemId !== undefined && queuedIdOf(itemId) !== undefined) {
      this.cursorIds = [itemId]
      this.cursorRev += 1
      this.toggleRows([itemId])
      return
    }
    const owner = itemId === undefined ? undefined : facts?.locate(itemId)
    if (facts === undefined || owner === undefined) return
    this.cursorIds = undefined
    // A header, a compact title, and the closing line stand for their turn: the cursor follows to the turn's other row.
    if (owner.kind !== 'entries') {
      if (owner.turn === undefined) return
      this.cursorIds = [`turn-header:${String(owner.turn)}`, `process:${String(owner.turn)}`]
      this.cursorRev += 1
      this.toggleTurn(owner.turn)
      return
    }
    // Any other row opens the parts it stands for; its row keeps its id, so the cursor stays on it. A run opens or folds whole
    // from its head (and keeps the calls that join it in step), a call of it flips alone, and the run keeps its shape.
    this.cursorIds = [itemId!]
    this.cursorRev += 1
    const run = owner.run
    if (run === undefined) this.toggleRows(owner.parts)
    else if (itemId === run.head) this.setDisclosure(toggleGroup(this.disclosure, run.head, run.calls))
    else this.setDisclosure(toggleCall(this.disclosure, run.head, run.calls, owner.parts[0]!))
  }

  private withRowText(mode: CopyMode, use: (text: string) => void): void {
    const facts = this.active === undefined ? undefined : this.views.get(this.active)?.facts
    const cursor = this.slot?.cursor(STREAM.list)
    const text = cursor === undefined ? undefined : facts?.textOf(cursor, mode)
    if (text !== undefined && text !== '') use(text)
  }

  private unmount(): void {
    this.cancelTrailing()
    this.stopWatchdog()
    this.streaming = false
    this.pendingReveal = false
    this.lastCursor = undefined
    this.offLayout?.()
    this.offLayout = undefined
    for (const view of this.views.values()) view.fresh.reset()
    this.closeSearch()
    this.slot?.dispose()
    this.slot = undefined
  }
}
