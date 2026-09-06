/**
 * Renderer-neutral transcript projection consumer and its semantic TUI
 * controller. The selected session supplies one source; this module owns
 * generation-isolated reconciliation, bounded mounting, width-safe rendering,
 * and screen change notification.
 *
 * @module @ephemeral-ai/mayfly/transcript/transcript-model
 */

import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import {
  GutterComponent,
  type MayflyComponent,
  type MayflyComponents,
  type MayflyScreen,
  type MayflySemanticColors,
} from '../core/index.ts'
import {
  freezeModel,
  type TranscriptEntryModel,
  type TranscriptImageModel,
  type TranscriptModel,
  type TranscriptToolModel,
  type MayflyTranslate,
} from '../frontend/index.ts'
import {
  AssistantMessageComponent,
  ErrorMessageComponent,
  InterruptedMarkerComponent,
  ToolCallComponent,
  UserMessageComponent,
  type UserMessageImages,
} from './components.ts'
import { ThinkingComponent } from './thinking.ts'
import { ToolModelComponent, toolResultChip } from './tool-model.ts'
import { ReadGroupComponent, groupReadsByFile } from './read-group.ts'
import { SearchGroupComponent } from './search-group.ts'
import { parseToolArguments, summarizeToolCall } from './present.ts'
import { summarizeToolText } from './envelope.ts'
import { renderCanonicalNode, type CanonicalNodeRenderer } from './canonical-node-renderer.ts'
import type { TranscriptToolItem } from './types.ts'
import {
  DEFAULT_TRANSCRIPT_PRESENTATION,
  type TranscriptPresentationPolicy,
  type TranscriptPresentationSnapshot,
} from './presentation-policy.ts'

interface ExpandableComponent extends MayflyComponent { setExpanded?(expanded: boolean): void }

type Source = TranscriptModel | (() => TranscriptModel | null)

/** Legacy export retained for consumers; transcript rendering no longer drops history. */
export const TRANSCRIPT_MODEL_WINDOW = 200

/** Renderer-only dependencies for semantic transcript entries. */
export interface TranscriptModelRenderer extends CanonicalNodeRenderer {
  readonly colors: MayflySemanticColors
  readonly components: MayflyComponents
  readonly images: () => UserMessageImages
  readonly requestRender: () => void
  readonly presentation?: TranscriptPresentationPolicy
  /** Dynamic translator for transcript-owned renderer chrome. */
  readonly t?: MayflyTranslate
  /** Disable semantic component chrome while retaining canonical width-safe rendering. */
  readonly semantic?: boolean
}

/** Renderer dependencies owned by the one product conversation controller. */
export interface TranscriptControllerOptions {
  readonly renderer?: TranscriptModelRenderer
}

/** Build an immutable transcript model from already-projected entries. */
export function createTranscriptModel(
  id: string,
  entries: readonly (MayflyUiNode | TranscriptEntryModel)[],
  streaming?: boolean,
  generation = 0,
): TranscriptModel {
  return freezeModel({ kind: 'transcript', id, generation, entries: [...entries], ...(streaming === undefined ? {} : { streaming }) })
}

/** Append one projected canonical node or semantic entry without folding events. */
export function appendTranscriptNode(
  model: TranscriptModel,
  entry: MayflyUiNode | TranscriptEntryModel,
  streaming = model.streaming,
): TranscriptModel {
  return createTranscriptModel(model.id, [...model.entries, entry], streaming, model.generation)
}

function isSemantic(entry: MayflyUiNode | TranscriptEntryModel): entry is TranscriptEntryModel {
  return entry.kind.startsWith('transcript-')
}

function asToolItem(entry: TranscriptToolModel): TranscriptToolItem {
  const parsedArguments = parseToolArguments(entry.arguments)
  return {
    kind: 'tool',
    seq: entry.seq,
    turn: entry.turn,
    step: entry.step,
    callId: entry.callId,
    name: entry.name,
    arguments: entry.arguments,
    ...(parsedArguments === undefined ? {} : { parsedArguments }),
    startedAt: entry.startedAt,
    ...(entry.result === undefined ? {} : { result: entry.result }),
  }
}

function asImageRef(image: TranscriptImageModel): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(image.attachmentId),
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...(image.name === undefined ? {} : { name: image.name }),
    ...(image.originalDimensions === undefined ? {} : {
      originalDimensions: { ...image.originalDimensions },
    }),
  }
}

interface CachedComponent {
  readonly kind: TranscriptEntryModel['kind']
  readonly component: MayflyComponent
  readonly target: MayflyComponent
  revision: number
  rows: EntryRowsCache | undefined
  readonly update: (entry: TranscriptEntryModel) => boolean
}

interface EntryRowsCache {
  readonly revision: number
  readonly width: number
  readonly expanded: boolean
  readonly policy: TranscriptPresentationSnapshot
  readonly rows: string[]
}

interface RenderedRowsCache {
  readonly model: TranscriptModel
  readonly width: number
  readonly expanded: boolean
  readonly policy: TranscriptPresentationSnapshot
  readonly rows: string[]
}

function entryRevision(entry: TranscriptEntryModel): number {
  return entry.updatedSeq ?? Number.NaN
}

/** Bounded semantic transcript component with id-based reconciliation. */
export class TranscriptModelComponent implements MayflyComponent {
  private readonly cached = new Map<string, CachedComponent>()
  private expanded = false
  private renderedRows: RenderedRowsCache | undefined
  private generation: number | undefined

  constructor(
    private readonly source: () => TranscriptModel | null,
    private readonly renderer: TranscriptModelRenderer,
  ) {}

  render(width: number): string[] {
    const model = this.source()
    if (model === null) {
      this.renderedRows = undefined
      this.prune(new Set())
      this.generation = undefined
      return []
    }
    if (this.generation !== model.generation) {
      this.renderedRows = undefined
      this.prune(new Set())
      this.generation = model.generation
    }
    const bounded = model.entries
    const policy = this.presentation()
    const rendered = this.renderedRows
    if (rendered?.model === model
      && rendered.width === width
      && rendered.expanded === this.expanded
      && rendered.policy === policy) return rendered.rows
    const turns = [...new Set(bounded.filter(isSemantic).map(entry => entry.turn))]
    const visibleTurns = new Set(turns.slice(-policy.windowTurns))
    const entries = bounded.filter(entry => !isSemantic(entry) || visibleTurns.has(entry.turn))
    const expandableTurns = new Set(turns.slice(-policy.expandTurns))
    const live = new Set(entries.filter(isSemantic).map(entry => entry.id))
    this.prune(live)
    const rows = entries.flatMap(entry => isSemantic(entry)
      ? this.renderSemantic(entry, width, expandableTurns.has(entry.turn), policy)
      : renderCanonicalNode(entry, width, this.renderer))
    this.renderedRows = { model, width, expanded: this.expanded, policy, rows }
    return rows
  }

  /** Apply the global recent-detail expansion state to mounted entries. */
  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return
    this.expanded = expanded
    this.renderedRows = undefined
    for (const cached of this.cached.values()) {
      cached.rows = undefined
      cached.target.invalidate()
    }
  }

  invalidate(): void {
    this.renderedRows = undefined
    for (const cached of this.cached.values()) {
      cached.rows = undefined
      cached.component.invalidate()
    }
  }

  /** Dispose timers and async renderer resources held by cached components. */
  dispose(): void {
    this.renderedRows = undefined
    this.prune(new Set())
  }

  private renderSemantic(entry: TranscriptEntryModel, width: number, expandable: boolean, policy: TranscriptPresentationSnapshot): string[] {
    if (this.renderer.semantic === false) return renderCanonicalNode({ kind: 'text', content: this.plainText(entry) }, width, this.renderer)
    const revision = entryRevision(entry)
    let cached = this.cached.get(entry.id)
    if (cached !== undefined && (cached.kind !== entry.kind || (cached.revision !== revision && !cached.update(entry)))) {
      this.disposeComponent(cached.target)
      this.cached.delete(entry.id)
      cached = undefined
    }
    if (cached === undefined) {
      cached = this.createComponent(entry)
      this.cached.set(entry.id, cached)
    } else if (cached.revision !== revision) {
      cached.revision = revision
      cached.rows = undefined
    }
    const expanded = this.applyExpansion(cached.target, entry, expandable, policy)
    const rendered = cached.rows
    if (rendered?.revision === revision
      && rendered.width === width
      && rendered.expanded === expanded
      && rendered.policy === policy) return rendered.rows
    const rows = cached.component.render(width)
    cached.rows = { revision, width, expanded, policy, rows }
    return rows
  }

  private invalidateEntry(id: string): void {
    const cached = this.cached.get(id)
    if (cached !== undefined) cached.rows = undefined
    this.renderedRows = undefined
  }

  /** Current tree policy, or immutable shipped defaults for standalone consumers. */
  private presentation(): TranscriptPresentationSnapshot {
    return this.renderer?.presentation?.snapshot() ?? DEFAULT_TRANSCRIPT_PRESENTATION
  }

  /** Compose Ctrl-O's recent-turn override over category defaults. */
  private applyExpansion(target: MayflyComponent, entry: TranscriptEntryModel, expandable: boolean, policy: TranscriptPresentationSnapshot): boolean {
    const expanded = this.expanded && expandable
      ? true
      : entry.kind === 'transcript-thinking'
        ? policy.thinkingExpanded
        : entry.kind === 'transcript-tool' || entry.kind === 'transcript-read-group' || entry.kind === 'transcript-search-group'
          ? policy.toolsExpanded
          : false
    ;(target as ExpandableComponent).setExpanded?.(expanded)
    return expanded
  }

  private createComponent(entry: TranscriptEntryModel): CachedComponent {
    const renderer = this.renderer
    let target: MayflyComponent
    let update: (entry: TranscriptEntryModel) => boolean = () => false
    switch (entry.kind) {
      case 'transcript-user': {
        const images = renderer.images()
        target = new UserMessageComponent({
          kind: 'user', seq: entry.seq, turn: entry.turn, text: entry.text, images: entry.images.map(asImageRef),
        }, renderer.colors, renderer.components, {
          ...images,
          onReady: () => {
            this.invalidateEntry(entry.id)
            images.onReady?.()
          },
          presentation: () => this.presentation(),
          ...(renderer.t === undefined ? {} : { t: renderer.t }),
        })
        break
      }
      case 'transcript-assistant': {
        const item = { kind: 'assistant' as const, seq: entry.seq, turn: entry.turn, step: entry.step, text: entry.text, streaming: entry.streaming }
        target = new AssistantMessageComponent(item, renderer.colors, renderer.components)
        update = (next): boolean => {
          const assistant = next as Extract<TranscriptEntryModel, { readonly kind: 'transcript-assistant' }>
          item.text = assistant.text
          item.streaming = assistant.streaming
          target.invalidate()
          return true
        }
        break
      }
      case 'transcript-thinking': {
        const item = { kind: 'thinking' as const, seq: entry.seq, turn: entry.turn, step: entry.step, text: entry.text, streaming: entry.streaming }
        target = new ThinkingComponent(item, renderer.colors, renderer.components, () => {
          this.invalidateEntry(entry.id)
          renderer.requestRender()
        })
        update = (next): boolean => {
          const thinking = next as Extract<TranscriptEntryModel, { readonly kind: 'transcript-thinking' }>
          item.text = thinking.text
          item.streaming = thinking.streaming
          target.invalidate()
          return true
        }
        break
      }
      case 'transcript-tool': {
        let tool = entry
        const body = new ToolModelComponent(() => tool.presentation ?? null, renderer)
        const component = new ToolCallComponent(asToolItem(entry), renderer.colors, renderer.components, body, toolResultChip(entry.presentation))
        target = component
        update = (next): boolean => {
          tool = next as Extract<TranscriptEntryModel, { readonly kind: 'transcript-tool' }>
          component.update(asToolItem(tool), toolResultChip(tool.presentation))
          return true
        }
        break
      }
      case 'transcript-read-group': {
        const group = new ReadGroupComponent(entry, renderer.colors, renderer.components)
        target = group
        update = (next): boolean => {
          group.update(next as Extract<TranscriptEntryModel, { readonly kind: 'transcript-read-group' }>)
          return true
        }
        break
      }
      case 'transcript-search-group': {
        const group = new SearchGroupComponent(entry, renderer.colors, renderer.components)
        target = group
        update = (next): boolean => {
          group.update(next as Extract<TranscriptEntryModel, { readonly kind: 'transcript-search-group' }>)
          return true
        }
        break
      }
      case 'transcript-error':
        target = new ErrorMessageComponent({
          kind: 'error', seq: entry.seq, turn: entry.turn, message: entry.message,
          ...(entry.code === undefined ? {} : { code: entry.code }),
        }, renderer.colors, renderer.components)
        break
      case 'transcript-interrupted':
        target = new InterruptedMarkerComponent(renderer.colors, renderer.components, renderer.t)
        break
    }
    return {
      kind: entry.kind,
      revision: entryRevision(entry),
      target,
      component: new GutterComponent(target),
      rows: undefined,
      update,
    }
  }

  private plainText(entry: TranscriptEntryModel): string {
    switch (entry.kind) {
      case 'transcript-user': return entry.text
      case 'transcript-assistant': return entry.text
      case 'transcript-thinking': return entry.text
      case 'transcript-tool': {
        const text = entry.result?.fullText ?? entry.result?.text
        return text === undefined ? summarizeToolCall(entry.name, entry.arguments) : summarizeToolText(text)
      }
      case 'transcript-read-group': {
        const paths = groupReadsByFile(entry.reads).map(group => group.path)
        return `Read ${String(entry.reads.length)} ${entry.reads.length === 1 ? 'call' : 'calls'}${paths.length === 0 ? '' : `: ${paths.join(', ')}`}`
      }
      case 'transcript-search-group': {
        const patterns = entry.searches.map(call => call.pattern ?? 'search')
        return `Searched ${String(entry.searches.length)} ${entry.searches.length === 1 ? 'time' : 'times'}: ${patterns.join(', ')}`
      }
      case 'transcript-error': return entry.code === undefined ? entry.message : `${entry.message} (${entry.code})`
      case 'transcript-interrupted': return 'Interrupted'
    }
  }

  private prune(live: ReadonlySet<string>): void {
    for (const [id, cached] of this.cached) {
      if (live.has(id)) continue
      this.disposeComponent(cached.target)
      this.cached.delete(id)
    }
  }

  private disposeComponent(component: MayflyComponent): void {
    ;(component as MayflyComponent & { dispose?: () => void }).dispose?.()
  }
}

interface MountedTranscript {
  readonly component: TranscriptModelComponent
  readonly unmount: () => void
}

/** Single-source bridge from the selected conversation projection to its fixed slot. */
export class TranscriptController {
  private source: Source | undefined
  private mounted: MountedTranscript | undefined
  private screen: MayflyScreen | undefined
  private expanded = false

  constructor(
    private readonly owner: Context,
    screen?: MayflyScreen,
    private readonly options: TranscriptControllerOptions = {},
  ) {
    this.screen = screen
  }

  attach(screen: MayflyScreen): void {
    this.unmount()
    this.screen = screen
    this.mount()
  }

  setSource(source: Source): void {
    this.unmount()
    this.source = source
    this.mount()
  }

  refresh(): void {
    if (this.source === undefined) return
    const screen = this.screen
    if (screen === undefined) return
    const paused = screen.contentChanged()
    this.owner.emit('mayfly/transcript-content-changed', paused)
    screen.requestRender()
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded
    this.mounted?.component.setExpanded(expanded)
  }

  /** Re-read presentation policy and invalidate mounted semantic components. */
  refreshPresentationPolicy(): void {
    this.mounted?.component.invalidate()
    this.screen?.requestRender(true)
  }

  /** Invalidate renderer-owned copy after a locale provider revision. */
  refreshLocale(): void {
    this.mounted?.component.invalidate()
    this.screen?.requestRender(true)
  }

  /** Expose the current immutable policy for diagnostics and tests. */
  presentationPolicy(): TranscriptPresentationSnapshot {
    return this.options.renderer?.presentation?.snapshot() ?? DEFAULT_TRANSCRIPT_PRESENTATION
  }

  dispose(): void {
    this.unmount()
    this.source = undefined
    this.screen = undefined
  }

  private mount(): void {
    const screen = this.screen
    const source = this.source
    const renderer = this.options.renderer
    if (screen === undefined || source === undefined || renderer === undefined) return
    const component = new TranscriptModelComponent(
      () => typeof source === 'function' ? source() : source,
      renderer,
    )
    component.setExpanded(this.expanded)
    const slot = screen.mountContentSlot('transcript.conversation', component)
    this.mounted = { component, unmount: () => slot.dispose() }
    screen.requestRender()
  }

  private unmount(): void {
    const mounted = this.mounted
    if (mounted === undefined) return
    mounted.component.dispose()
    mounted.unmount()
    this.mounted = undefined
  }
}
