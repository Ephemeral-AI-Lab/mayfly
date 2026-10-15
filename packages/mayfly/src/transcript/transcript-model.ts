/**
 * Renderer-neutral transcript projection consumer and the controller that publishes it. The selected session supplies
 * one source; this module keeps one stream view per displayed or retained conversation, maps the displayed model to the
 * stream's facts, and publishes `TranscriptView` into the conversation node slot. It owns neither widths nor rows: the
 * screen compiles the node and scrolls it.
 *
 * @module @ephemeral-ai/mayfly/transcript/transcript-model
 */

import type { MayflyUiEvent, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { latestTurnOf, STREAM, streamTarget, TranscriptStream, type StreamRow, type TranscriptViewFacts } from '../components/transcript-view.ts'
import type { MayflyNodeSlot } from '../core/node-slot.ts'
import type { MayflySearchLine } from '../core/search-line.ts'
import type { MayflyScreenService } from '../core/screen.ts'
import type { MayflyDecisionRequest, MayflyFocusMode, MayflyScreen } from '../core/types.ts'
import type { ApprovalMark, CompactionMark } from '../conversation/types.ts'
import type { MayflyTranslate } from '../frontend/locale.ts'
import { freezeModel, materializeTranscriptEntries, type TranscriptEntryModel, type TranscriptModel, type TranscriptTurnModel } from '../frontend/models.ts'
import { NO_DISCLOSURE, toggleCall, toggleGroup, toggleRows, toggleTurn, type Disclosure } from './disclosure.ts'
import type { CopyMode } from './row-text.ts'
import { findHits, readPattern, type SearchPattern, type SearchResult } from './search.ts'
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
export type TranscriptScreen = MayflyScreen & Pick<MayflyScreenService, 'mountNodeSlot' | 'mountSearchLine'>

/** What the controller reads besides the models: the policy, the translator, and the messages queued behind the stream. */
export interface TranscriptControllerOptions {
  readonly presentation?: TranscriptPresentationPolicy
  readonly t: MayflyTranslate
  /** The messages the user typed while the agent works; read on every publish. */
  readonly queued: () => readonly { readonly id: string, readonly text: string }[]
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
}

/** What a row under the cursor can be sent to: the clipboard, or the editor. */
export interface StreamRowActions {
  /** Copy the row's content; `raw` is the model's JSON. */
  copy(text: string, mode: CopyMode): void
  /** Read the row's content in `$EDITOR`. */
  open(text: string): void
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
const BASE_KEYS = { 'ctrl+c': STREAM.copyRaw, '/': STREAM.findDown, '?': STREAM.findUp } as const

/** Once a search is accepted the arrows walk its matches, and `n`/`N` go on and back in the direction it was made. */
const SELECT_KEYS = { ...BASE_KEYS, up: STREAM.matchPrev, down: STREAM.matchNext, n: STREAM.matchAgain, 'shift+n': STREAM.matchBack } as const

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
    this.views.set(key, { source, options, facts: new StreamFacts() })
    if (key === this.active) this.publish()
  }

  /** Display one retained view. */
  show(key: string | undefined): void {
    if (key === this.active) return
    const switched = this.active !== undefined && key !== undefined
    this.closeSearch()
    this.active = key
    this.publish()
    // A different conversation opens at its newest content.
    if (switched) this.screen?.followContent()
  }

  /** Dispose one retained view. */
  dropView(key: string): void {
    if (this.views.delete(key) && key === this.active) {
      this.active = undefined
      this.publish()
    }
  }

  /** The displayed model changed: publish it. The screen follows the tail, or counts what arrived below a view scrolled away. */
  refresh(): void {
    if (this.active === undefined) return
    const screen = this.screen
    if (screen === undefined) return
    this.publish()
    screen.requestRender()
  }

  /** Something other than the model moved (the queued messages): publish again without announcing new content. */
  republish(): void {
    this.publish()
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
    this.search = { line, forward, pattern: '', read: { kind: 'empty' }, phase: 'input', model, result: model === null ? EMPTY_RESULT : findHits(model, { kind: 'empty' }), index: -1, visited: new Set() }
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
    search.result = search.model === null ? EMPTY_RESULT : findHits(search.model, search.read)
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
    for (let tries = 0; tries < Math.max(1, hits.length); tries += 1) {
      const hit = hits[search.index]
      if (hit === undefined || facts === undefined) break
      search.visited.add(hit.turn)
      this.disclosure = { ...this.disclosure, forced: new Set(search.visited) }
      this.publish()
      const row = facts.rowOf(hit.part)
      if (row !== undefined) {
        this.cursorIds = [row]
        this.cursorRev += 1
        break
      }
      search.index = (search.index + step + hits.length) % hits.length
    }
    this.publish()
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

  dispose(): void {
    this.offTick?.()
    this.offTick = undefined
    this.unmount()
    this.views.clear()
    this.active = undefined
    this.screen = undefined
  }

  /** Texts and policy changed under the same ids: forget the kept rows and publish. */
  private rewrite(): void {
    for (const view of this.views.values()) view.facts.reset()
    this.publish()
    this.screen?.requestRender(true)
  }

  private publish(now = Date.now()): void {
    const slot = this.slot
    if (slot === undefined) return
    const view = this.active === undefined ? undefined : this.views.get(this.active)
    const model = view === undefined ? null : typeof view.source === 'function' ? view.source() : view.source
    this.syncSearch(model)
    if (view === undefined || model === null) {
      slot.set(null)
      slot.setTurns(0)
      return
    }
    const facts = view.facts.build(model, {
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
  }

  /** A conversation that moved on while a search is open: its hits are found again, and the line says how many there are now. */
  private syncSearch(model: TranscriptModel | null): void {
    const search = this.search
    if (search === undefined) return
    if (model !== search.model) {
      const current = search.result.hits[search.index]
      search.model = model
      search.result = model === null ? EMPTY_RESULT : findHits(model, search.read)
      const kept = current === undefined ? -1 : search.result.hits.findIndex(hit => hit.part === current.part && hit.nth === current.nth)
      search.index = search.phase === 'input' ? -1 : kept >= 0 ? kept : Math.min(search.index, search.result.hits.length - 1)
    }
    search.line.set(this.searchStatus(search))
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
      this.publish(now)
      this.screen?.requestRender()
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
      // Focus moves up into the stream at its newest row; `Esc` and `Alt+↓` give it back to the prompt.
      onFocus: () => {
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
      onFocusChange: (focused) => { if (!this.searching) this.options.focusMode?.(focused ? 'conversation' : 'prompt') },
      // `Esc` or `Alt+↓` while a search holds the cursor ends the search and stays in the conversation.
      onLeave: () => { if (this.search === undefined) this.slot?.release(); else this.endSearch() },
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
    if (actionId === STREAM.findDown) this.beginSearch(true)
    else if (actionId === STREAM.findUp) this.beginSearch(false)
    else if (actionId === STREAM.matchPrev) this.searchStep(-1)
    else if (actionId === STREAM.matchNext) this.searchStep(1)
    else if (actionId === STREAM.matchAgain) this.searchRepeat(true)
    else if (actionId === STREAM.matchBack) this.searchRepeat(false)
  }

  private accept(itemId: string | undefined): void {
    const facts = this.active === undefined ? undefined : this.views.get(this.active)?.facts
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
    this.closeSearch()
    this.slot?.dispose()
    this.slot = undefined
  }
}
