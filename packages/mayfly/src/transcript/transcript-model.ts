/**
 * Renderer-neutral transcript projection consumer and its semantic TUI
 * controller. The selected session supplies one source; this module owns
 * generation-isolated reconciliation, bounded mounting, width-safe rendering,
 * and screen change notification.
 *
 * @module @ephemeral-ai/mayfly/transcript/transcript-model
 */

import { workDetailEntries } from './work-details.ts'
import { Service, type Context } from '@deepseek-ai/cordis'
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
  materializeTranscriptEntries,
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
import { CommandGroupComponent } from './command-group.ts'
import { parseToolArguments, summarizeToolCall } from './present.ts'
import { summarizeToolText } from './envelope.ts'
import { renderCanonicalNode, type CanonicalNodeRenderer } from './canonical-node-renderer.ts'
import type { TranscriptToolItem } from './types.ts'
import {
  DEFAULT_TRANSCRIPT_PRESENTATION,
  type TranscriptFamily,
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
  return createTranscriptModel(model.id, [...materializeTranscriptEntries(model), entry], streaming, model.generation)
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
  revision: number | string
  rows: EntryRowsCache | undefined
  readonly update: (entry: TranscriptEntryModel) => boolean
}

interface EntryRowsCache {
  readonly revision: number | string
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

interface TranscriptRenderPlan {
  readonly sourceEntries: TranscriptModel['entries']
  readonly policy: TranscriptPresentationSnapshot
  readonly liveTurn: number | undefined
  readonly liveStep: number | undefined
  readonly entries: TranscriptModel['entries']
  readonly ids: ReadonlySet<string>
  readonly expandableTurns: ReadonlySet<number>
}

interface DurableRowsCache {
  readonly width: number
  readonly expanded: boolean
  readonly rows: string[]
}

/**
 * One ephemeral component anchored into the durable flow: it renders after the
 * last durable entry whose seq does not exceed `seq`, orders among siblings by
 * `order`, and drops on generation change or explicit removal.
 */
interface AnchoredContent {
  readonly component: MayflyComponent
  readonly seq: number
  readonly order: number
  cached: { readonly width: number, readonly rows: string[] } | undefined
}

function entryRevision(entry: TranscriptEntryModel): number | string {
  return entry.renderRevision ?? entry.updatedSeq ?? Number.NaN
}

/** Bounded semantic transcript component with id-based reconciliation. */
export class TranscriptModelComponent implements MayflyComponent {
  private readonly cached = new Map<string, CachedComponent>()
  private readonly anchored = new Map<string, AnchoredContent>()
  private canonicalRows = new WeakMap<object, { readonly width: number, readonly rows: string[] }>()
  private expanded = false
  private renderedRows: RenderedRowsCache | undefined
  private generation: number | undefined
  private plan: TranscriptRenderPlan | undefined
  private durableRows: DurableRowsCache | undefined
  private liveIds = new Set<string>()
  private anchorOrder = 0

  constructor(
    private readonly source: () => TranscriptModel | null,
    private readonly renderer: TranscriptModelRenderer,
  ) {}

  render(width: number): string[] {
    const model = this.source()
    if (model === null) {
      this.renderedRows = undefined
      this.canonicalRows = new WeakMap()
      this.prune(new Set())
      this.clearAnchored()
      this.generation = undefined
      this.plan = undefined
      this.durableRows = undefined
      this.liveIds.clear()
      return []
    }
    if (this.generation !== model.generation) {
      this.renderedRows = undefined
      this.canonicalRows = new WeakMap()
      this.prune(new Set())
      // Anchors appended since the last render keep their position on the
      // first pass; a real generation change (new session content) drops them.
      if (this.generation !== undefined) this.clearAnchored()
      this.generation = model.generation
      this.plan = undefined
      this.durableRows = undefined
      this.liveIds.clear()
    }
    const policy = this.presentation()
    const rendered = this.renderedRows
    if (rendered?.model === model
      && rendered.width === width
      && rendered.expanded === this.expanded
      && rendered.policy === policy) return rendered.rows
    const liveEntries = model.live?.entries ?? []
    const liveIds = new Set(liveEntries.map(entry => entry.id))
    let plan = this.plan
    if (plan === undefined || plan.sourceEntries !== model.entries || plan.policy !== policy
      || plan.liveTurn !== model.live?.turn || plan.liveStep !== model.live?.step) {
      const bounded = model.live === undefined ? model.entries : model.entries.filter(entry => !((entry.kind === 'transcript-thinking' || entry.kind === 'transcript-assistant')
        && entry.turn === model.live!.turn && entry.step === model.live!.step))
      const turns = [...new Set([...bounded.filter(isSemantic).map(entry => entry.turn), ...(model.live === undefined ? [] : [model.live.turn])])]
      const visibleTurns = new Set(turns.slice(-policy.windowTurns))
      const entries = bounded.filter(entry => !isSemantic(entry) || visibleTurns.has(entry.turn))
      const ids = new Set(entries.filter(isSemantic).map(entry => entry.id))
      plan = { sourceEntries: model.entries, policy, liveTurn: model.live?.turn, liveStep: model.live?.step, entries, ids, expandableTurns: new Set(turns.slice(-policy.expandTurns)) }
      this.plan = plan
      this.durableRows = undefined
      this.prune(new Set([...ids, ...liveIds]))
    } else {
      for (const id of this.liveIds) {
        if (liveIds.has(id) || plan.ids.has(id)) continue
        const cached = this.cached.get(id)
        if (cached !== undefined) this.disposeComponent(cached.target)
        this.cached.delete(id)
      }
    }
    this.liveIds = liveIds
    let durableRows = this.durableRows
    if (durableRows === undefined || durableRows.width !== width || durableRows.expanded !== this.expanded) {
      const insertions = this.anchoredInsertions(plan.entries)
      const displayEntries = model.streaming === undefined || this.renderer.semantic === false ? plan.entries : workDetailEntries(plan.entries, model.streaming, policy.mode, this.expanded)
      const rows = insertions === undefined
        ? displayEntries.flatMap(entry => this.renderPlanEntry(entry, width, plan, policy))
        : [
            ...this.anchoredRowsAt(insertions, 0, width),
            ...plan.entries.flatMap((entry, index) => [
              ...this.renderPlanEntry(entry, width, plan, policy),
              ...this.anchoredRowsAt(insertions, index + 1, width),
            ]),
          ]
      durableRows = { width, expanded: this.expanded, rows }
      this.durableRows = durableRows
    }
    // A live frame is a fresh array over the shared durable rows: identity
    // caches downstream (the frame clamp) see the change without a scan.
    const rows = liveEntries.length === 0
      ? durableRows.rows
      : [...durableRows.rows, ...liveEntries.flatMap(entry => this.renderSemantic(entry, width, plan.expandableTurns.has(entry.turn), policy))]
    this.renderedRows = { model, width, expanded: this.expanded, policy, rows }
    return rows
  }

  private renderCanonical(entry: MayflyUiNode, width: number): string[] {
    const cached = this.canonicalRows.get(entry)
    if (cached?.width === width) return cached.rows
    const rows = renderCanonicalNode(entry, width, this.renderer)
    this.canonicalRows.set(entry, { width, rows })
    return rows
  }

  /**
   * Anchor an ephemeral component into the durable flow after the last visible
   * entry whose seq does not exceed `seq`. Anchored content is presentation-only
   * and drops on generation change, a null source, or `removeAnchored`.
   */
  appendAnchored(id: string, component: MayflyComponent, seq: number): void {
    this.anchored.set(id, { component: new GutterComponent(component), seq, order: this.anchorOrder, cached: undefined })
    this.anchorOrder += 1
    this.dropRows()
  }

  /** Remove one anchored component early; unknown ids are ignored. */
  removeAnchored(id: string): void {
    const item = this.anchored.get(id)
    if (item === undefined) return
    this.anchored.delete(id)
    this.disposeComponent(item.component)
    this.dropRows()
  }

  /**
   * Group anchored items by the durable-entry index they render before. A
   * canonical node inherits the seq of the preceding semantic entry (leading
   * canonicals keep header position), so an anchor past every seq lands at
   * the tail of whatever entries are visible.
   */
  private anchoredInsertions(entries: TranscriptModel['entries']): Map<number, AnchoredContent[]> | undefined {
    if (this.anchored.size === 0) return undefined
    const insertions = new Map<number, AnchoredContent[]>()
    const items = [...this.anchored.values()].sort((a, b) => a.seq - b.seq || a.order - b.order)
    for (const item of items) {
      let index = 0
      let lastSeq = Number.NEGATIVE_INFINITY
      for (let at = 0; at < entries.length; at += 1) {
        const entry = entries[at]!
        if (isSemantic(entry)) lastSeq = entry.seq
        if (lastSeq <= item.seq) index = at + 1
      }
      const list = insertions.get(index)
      if (list === undefined) insertions.set(index, [item])
      else list.push(item)
    }
    return insertions
  }

  /** Render every anchored item parked at one insertion index, cached per width. */
  private anchoredRowsAt(insertions: Map<number, AnchoredContent[]>, index: number, width: number): string[] {
    const items = insertions.get(index)
    if (items === undefined) return []
    return items.flatMap(item => {
      if (item.cached?.width !== width) item.cached = { width, rows: item.component.render(width) }
      return item.cached.rows
    })
  }

  private renderPlanEntry(
    entry: TranscriptModel['entries'][number],
    width: number,
    plan: TranscriptRenderPlan,
    policy: TranscriptPresentationSnapshot,
  ): string[] {
    return isSemantic(entry)
      ? this.renderSemantic(entry, width, plan.expandableTurns.has(entry.turn), policy)
      : this.renderCanonical(entry, width)
  }

  private clearAnchored(): void {
    for (const item of this.anchored.values()) this.disposeComponent(item.component)
    this.anchored.clear()
  }

  private dropRows(): void {
    this.renderedRows = undefined
    this.durableRows = undefined
  }

  renderWindow(width: number, offset: number, rows: number): { readonly rows: string[], readonly total: number } {
    const rendered = this.render(width)
    const safeRows = Math.max(1, Number.isFinite(rows) ? Math.floor(rows) : 1)
    const safeOffset = Math.max(0, Number.isFinite(offset) ? Math.floor(offset) : 0)
    const end = Math.max(0, rendered.length - safeOffset)
    return { rows: rendered.slice(Math.max(0, end - safeRows), end), total: rendered.length }
  }

  /** Apply the global recent-detail expansion state to mounted entries. */
  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return
    this.expanded = expanded
    this.renderedRows = undefined
    this.durableRows = undefined
    for (const cached of this.cached.values()) {
      cached.rows = undefined
      cached.target.invalidate()
    }
  }

  invalidate(): void {
    this.renderedRows = undefined
    this.durableRows = undefined
    this.canonicalRows = new WeakMap()
    for (const cached of this.cached.values()) {
      cached.rows = undefined
      cached.component.invalidate()
    }
    for (const item of this.anchored.values()) {
      item.cached = undefined
      item.component.invalidate()
    }
  }

  /** Dispose timers and async renderer resources held by cached components. */
  dispose(): void {
    this.renderedRows = undefined
    this.durableRows = undefined
    this.plan = undefined
    this.liveIds.clear()
    this.canonicalRows = new WeakMap()
    this.clearAnchored()
    this.prune(new Set())
  }

  private renderSemantic(entry: TranscriptEntryModel, width: number, expandable: boolean, policy: TranscriptPresentationSnapshot): string[] {
    if (entry.kind === 'transcript-tool' && entry.preparing !== undefined) {
      return renderCanonicalNode({ kind: 'text', content: `Preparing ${entry.name} · ${entry.preparing.characters} characters`, tone: 'muted' }, width, this.renderer)
    }
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
    if (this.plan?.ids.has(id)) this.durableRows = undefined
  }

  /** Current tree policy, or immutable shipped defaults for standalone consumers. */
  private presentation(): TranscriptPresentationSnapshot {
    return this.renderer?.presentation?.snapshot() ?? DEFAULT_TRANSCRIPT_PRESENTATION
  }

  /** The configured family an entry renders under, or `undefined` for non-tool kinds. */
  private familyOf(entry: TranscriptEntryModel): TranscriptFamily | undefined {
    switch (entry.kind) {
      case 'transcript-thinking': return 'thinking'
      case 'transcript-command-group': return 'command'
      case 'transcript-read-group': return 'read'
      case 'transcript-search-group': return 'search'
      case 'transcript-tool': return entry.family
      default: return undefined
    }
  }

  /** Compose Ctrl-O's recent-turn override over per-family detail defaults. */
  private applyExpansion(target: MayflyComponent, entry: TranscriptEntryModel, expandable: boolean, policy: TranscriptPresentationSnapshot): boolean {
    const family = this.familyOf(entry)
    const expanded = (this.expanded && expandable)
      || (family !== undefined && policy.detail[family] === 'full')
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
        const item = { kind: 'thinking' as const, seq: entry.seq, turn: entry.turn, step: entry.step, text: entry.text, streaming: entry.streaming, outputProgress: entry.outputProgress }
        target = new ThinkingComponent(item, renderer.colors, renderer.components, () => {
          this.invalidateEntry(entry.id)
          renderer.requestRender()
        }, () => this.presentation().detail.thinking)
        update = (next): boolean => {
          const thinking = next as Extract<TranscriptEntryModel, { readonly kind: 'transcript-thinking' }>
          item.text = thinking.text
          item.streaming = thinking.streaming
          item.outputProgress = thinking.outputProgress
          target.invalidate()
          return true
        }
        break
      }
      case 'transcript-tool': {
        let tool = entry
        const family = entry.family
        const body = new ToolModelComponent(() => tool.presentation ?? null, renderer)
        const component = new ToolCallComponent(asToolItem(entry), renderer.colors, renderer.components, body, toolResultChip(entry.presentation), () => this.presentation().detail[family])
        target = component
        update = (next): boolean => {
          tool = next as Extract<TranscriptEntryModel, { readonly kind: 'transcript-tool' }>
          component.update(asToolItem(tool), toolResultChip(tool.presentation))
          return true
        }
        break
      }
      case 'transcript-read-group': {
        const group = new ReadGroupComponent(entry, renderer.colors, renderer.components, () => this.presentation().detail.read)
        target = group
        update = (next): boolean => {
          group.update(next as Extract<TranscriptEntryModel, { readonly kind: 'transcript-read-group' }>)
          return true
        }
        break
      }
      case 'transcript-search-group': {
        const group = new SearchGroupComponent(entry, renderer.colors, renderer.components, () => this.presentation().detail.search)
        target = group
        update = (next): boolean => {
          group.update(next as Extract<TranscriptEntryModel, { readonly kind: 'transcript-search-group' }>)
          return true
        }
        break
      }
      case 'transcript-command-group': {
        const group = new CommandGroupComponent(entry, renderer.colors, renderer.components, () => this.presentation().detail.command)
        target = group
        update = (next): boolean => {
          group.update(next as Extract<TranscriptEntryModel, { readonly kind: 'transcript-command-group' }>)
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
      case 'transcript-command-group': {
        const commands = entry.commands.slice(0, 3).map(call => call.command)
        return `Ran ${String(entry.commands.length)} ${entry.commands.length === 1 ? 'command' : 'commands'}: ${commands.join(', ')}${entry.commands.length > 3 ? '…' : ''}`
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
  private localSerial = 0

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

  /**
   * Append an ephemeral component into the conversation flow at the current
   * durable tail: later durable entries render below it and it scrolls up with
   * the transcript instead of pinning above the editor. The entry never becomes
   * session data and drops on generation change or explicit removal.
   * @param component - the component to mount; the transcript applies its gutter.
   * @returns a disposer removing the entry early; a no-op when nothing is mounted.
   */
  appendLocal(component: MayflyComponent): () => void {
    const mounted = this.mounted
    if (mounted === undefined) return () => {}
    // `mounted` implies `setSource` ran, so the source exists; a function
    // source may still report a null model (no session attached).
    const source = this.source!
    const model = typeof source === 'function' ? source() : source
    let seq = -1
    for (const entry of model?.entries ?? []) {
      if (isSemantic(entry) && entry.seq > seq) seq = entry.seq
    }
    const id = `local.${this.localSerial += 1}`
    mounted.component.appendAnchored(id, component, seq)
    this.refresh()
    let live = true
    return () => {
      if (!live) return
      live = false
      mounted.component.removeAnchored(id)
      this.screen?.requestRender()
    }
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

declare module '@deepseek-ai/cordis' {
  interface Context { mayflyTranscriptLocals: TranscriptLocalsService }
}

/**
 * `ctx.mayflyTranscriptLocals` — appends ephemeral local components into the
 * mounted conversation flow. Entries render where they were appended and
 * scroll up with the transcript instead of pinning to its tail; they are
 * presentation-only and never become session events. Consumers resolve the
 * service through `ctx.get` and fall back to local content slots when absent.
 */
export class TranscriptLocalsService extends Service {
  constructor(ctx: Context, private readonly controller: TranscriptController) {
    super(ctx, 'mayflyTranscriptLocals')
  }

  /** Append one ephemeral component at the current durable tail. */
  append(component: MayflyComponent): () => void {
    return this.controller.appendLocal(component)
  }
}
