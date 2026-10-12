/**
 * Renderer-neutral transcript projection consumer and the controller that publishes it. The selected session supplies
 * one source; this module keeps one stream view per displayed or retained conversation, maps the displayed model to the
 * stream's facts, and publishes `TranscriptView` into the conversation node slot. It owns neither widths nor rows: the
 * screen compiles the node and scrolls it.
 *
 * @module @ephemeral-ai/mayfly/transcript/transcript-model
 */

import type { MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { latestTurnOf, TranscriptView } from '../components/transcript-view.ts'
import type { MayflyNodeSlot } from '../core/node-slot.ts'
import type { MayflyScreenService } from '../core/screen.ts'
import type { MayflyScreen } from '../core/types.ts'
import type { MayflyTranslate } from '../frontend/locale.ts'
import { freezeModel, materializeTranscriptEntries, type TranscriptEntryModel, type TranscriptModel, type TranscriptTurnModel } from '../frontend/models.ts'
import { StreamFacts } from './stream-facts.ts'
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
  private expanded = false

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

  setExpanded(expanded: boolean): void {
    this.expanded = expanded
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

  private publish(): void {
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
      expanded: this.expanded,
      liveTurnHeader: view.options.liveTurnHeader === true,
      t: this.options.t,
      queued: this.options.queued(),
    })
    slot.setTurns(latestTurnOf(facts))
    slot.set(TranscriptView(facts))
  }

  private mount(): void {
    const screen = this.screen
    if (screen === undefined) return
    this.slot = screen.mountNodeSlot('transcript.conversation', { region: 'content' })
    this.publish()
    screen.requestRender()
  }

  private unmount(): void {
    this.slot?.dispose()
    this.slot = undefined
  }
}
