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
import type { MayflyScreenService } from '../core/screen.ts'
import type { MayflyDecisionRequest, MayflyScreen } from '../core/types.ts'
import type { ApprovalMark, CompactionMark } from '../conversation/types.ts'
import type { MayflyTranslate } from '../frontend/locale.ts'
import { freezeModel, materializeTranscriptEntries, type TranscriptEntryModel, type TranscriptModel, type TranscriptTurnModel } from '../frontend/models.ts'
import { NO_DISCLOSURE, toggleCall, toggleGroup, toggleRows, toggleTurn, type Disclosure } from './disclosure.ts'
import type { CopyMode } from './row-text.ts'
import { StreamFacts } from './stream-facts.ts'
import type { TickSource } from './tick.ts'
import {
  DEFAULT_TRANSCRIPT_PRESENTATION,
  type TranscriptPresentationPolicy,
  type TranscriptPresentationSnapshot,
} from './presentation-policy.ts'

type Source = TranscriptModel | (() => TranscriptModel | null)

/** The screen as the transcript uses it: the L1 contract and the conversation node slot. */
export type TranscriptScreen = MayflyScreen & Pick<MayflyScreenService, 'mountNodeSlot'>

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
  readonly context?: () => { readonly marks?: readonly CompactionMark[] | undefined, readonly window?: number | undefined, readonly tokens?: number | undefined, readonly approvals?: readonly ApprovalMark[] | undefined } | undefined
  /** Where the references of the images the stream shows are kept for the byte loader. */
  readonly imageRefs?: Map<string, { readonly attachmentId: string, readonly mediaType: string }>
  /** What `c` and `Ctrl+G` do with the row under the cursor. */
  readonly rows?: StreamRowActions
  /** Called when the stream gains or loses keyboard focus, for the mode the status line names. */
  readonly focusMode?: (mode: 'conversation' | 'prompt') => void
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
    const node = TranscriptStream(facts, this.cursorRev === 0 ? undefined : { rev: this.cursorRev, ...ids.length === 0 ? {} : { ids } })
    slot.set(node)
    // A cursor just sent also takes the keyboard focus, so the key that follows acts on that row.
    const target = streamTarget(node)
    if (target !== undefined && this.sentRev !== this.cursorRev) {
      this.sentRev = this.cursorRev
      slot.focusRow(STREAM.list, target)
    }
    this.keepTime(facts)
  }

  private compactionInputs(): { readonly compactions?: readonly CompactionMark[], readonly contextWindow?: number, readonly contextTokens?: number, readonly approvals?: readonly ApprovalMark[] } {
    const context = this.options.context?.()
    if (context === undefined) return {}
    return {
      ...context.marks === undefined ? {} : { compactions: context.marks },
      ...context.window === undefined ? {} : { contextWindow: context.window },
      ...context.tokens === undefined ? {} : { contextTokens: context.tokens },
      ...context.approvals === undefined ? {} : { approvals: context.approvals },
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
      keys: { 'ctrl+c': STREAM.copyRaw },
      onEvent: event => { this.onEvent(event) },
      // Focus moves up into the stream at its newest row; `Esc` and `Alt+↓` give it back to the prompt.
      onFocus: () => {
        // A focused stream shows the window around its cursor, so the view returns to the tail where the cursor starts: a
        // reader who had scrolled away would otherwise find the window below the view and nothing above it.
        this.screen?.followContent()
        this.cursorIds = undefined
        this.cursorRev += 1
        this.publish()
      },
      onFocusChange: (focused) => { this.options.focusMode?.(focused ? 'conversation' : 'prompt') },
      onLeave: () => { this.slot?.release() },
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
    this.slot?.dispose()
    this.slot = undefined
  }
}
