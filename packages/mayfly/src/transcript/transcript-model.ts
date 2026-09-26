/**
 * Renderer-neutral transcript projection consumer and its semantic TUI
 * controller. The selected session supplies one source; this module owns
 * generation-isolated reconciliation, bounded mounting, width-safe rendering,
 * and screen change notification.
 *
 * @module @ephemeral-ai/mayfly/transcript/transcript-model
 */

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
  type TranscriptTurnModel,
  type MayflyTranslate,
  interpolateLocaleMessage,
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
import { ToolLineComponent, isLineTool } from './tool-line.ts'
import { ProcessTitleComponent, TurnHeaderComponent } from './process-rows.ts'
import { buildDisplay, runningTurnOf, type DisplayItem, type EntryItem, type ProcessTitleItem, type TurnHeaderItem } from './process-groups.ts'
import { ToolModelComponent, toolResultChip } from './tool-model.ts'
import { ReadGroupComponent, groupReadsByFile } from './read-group.ts'
import { SearchGroupComponent } from './search-group.ts'
import { CommandGroupComponent } from './command-group.ts'
import { parseToolArguments, summarizeToolCall } from './present.ts'
import { summarizeToolText } from './envelope.ts'
import { renderCanonicalNode, type CanonicalNodeRenderer } from './canonical-node-renderer.ts'
import type { TranscriptThinkingItem, TranscriptToolItem } from './types.ts'
import {
  DEFAULT_TRANSCRIPT_PRESENTATION,
  type TranscriptPresentationPolicy,
  type TranscriptPresentationSnapshot,
} from './presentation-policy.ts'

/** A mounted card's disclosure setters; every one is optional. */
interface DisclosureTarget extends MayflyComponent {
  setExpanded?(expanded: boolean): void
  setScope?(scope: { readonly hint: boolean, readonly turnClosed: boolean }): void
}

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
    ...(entry.title === undefined ? {} : { title: entry.title }),
    ...(entry.terminal === undefined ? {} : { terminal: entry.terminal }),
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
  /** Presentation variant: `line` or `card` for tools, the kind otherwise. */
  readonly variant: string
  readonly component: MayflyComponent
  readonly target: MayflyComponent
  revision: number | string
  rows: EntryRowsCache | undefined
  readonly update: (entry: TranscriptEntryModel) => boolean
}

interface EntryRowsCache {
  readonly revision: number | string
  readonly width: number
  readonly disclosure: string
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
  readonly streaming: boolean | undefined
  readonly turns: TranscriptModel['turns']
  readonly entries: TranscriptModel['entries']
  readonly ids: ReadonlySet<string>
  readonly expandableTurns: ReadonlySet<number>
  readonly runningTurn: number | undefined
  /** Index of the running turn's first entry; everything before it is stable. */
  readonly split: number
}

/** Rows of every turn before the running one, reused across live frames. */
interface PrefixRowsCache {
  readonly width: number
  readonly expanded: boolean
  readonly items: readonly DisplayItem[]
  readonly rows: string[]
  readonly lastSeq: number | undefined
}

/** One header or group-title row component and its gutter. */
type RowComponent =
  | { readonly kind: 'turn-header', readonly target: TurnHeaderComponent, readonly component: GutterComponent }
  | { readonly kind: 'process-title', readonly target: ProcessTitleComponent, readonly component: GutterComponent }

/**
 * One ephemeral component anchored into the durable flow: it renders after the
 * last visible item whose seq does not exceed `seq`, orders among siblings by
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

/** A tool entry renders as one row or as a card; other kinds have one form. */
function variantOf(entry: TranscriptEntryModel): string {
  return entry.kind === 'transcript-tool' ? isLineTool(entry) ? 'line' : 'card' : entry.kind
}

/** The anchor-ordering seq of the last item that carries one. */
function lastItemSeq(items: readonly DisplayItem[], fallback: number | undefined): number | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const seq = items[index]!.seq
    if (seq !== undefined) return seq
  }
  return fallback
}

/** Bounded semantic transcript component with id-based reconciliation. */
export class TranscriptModelComponent implements MayflyComponent {
  private readonly cached = new Map<string, CachedComponent>()
  private readonly rowComponents = new Map<string, RowComponent>()
  private readonly anchored = new Map<string, AnchoredContent>()
  private canonicalRows = new WeakMap<object, { readonly width: number, readonly rows: string[] }>()
  private expanded = false
  private renderedRows: RenderedRowsCache | undefined
  private generation: number | undefined
  private plan: TranscriptRenderPlan | undefined
  private prefix: PrefixRowsCache | undefined
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
      this.pruneRows(new Set())
      this.clearAnchored()
      this.generation = undefined
      this.plan = undefined
      this.prefix = undefined
      this.liveIds.clear()
      return []
    }
    if (this.generation !== model.generation) {
      this.renderedRows = undefined
      this.canonicalRows = new WeakMap()
      this.prune(new Set())
      this.pruneRows(new Set())
      // Anchors appended since the last render keep their position on the
      // first pass; a real generation change (new session content) drops them.
      if (this.generation !== undefined) this.clearAnchored()
      this.generation = model.generation
      this.plan = undefined
      this.prefix = undefined
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
      || plan.liveTurn !== model.live?.turn || plan.liveStep !== model.live?.step
      || plan.streaming !== model.streaming || plan.turns !== model.turns) {
      const bounded = model.live === undefined ? model.entries : model.entries.filter(entry => !((entry.kind === 'transcript-thinking' || entry.kind === 'transcript-assistant')
        && entry.turn === model.live!.turn && entry.step === model.live!.step))
      const turns = [...new Set([...bounded.filter(isSemantic).map(entry => entry.turn), ...(model.live === undefined ? [] : [model.live.turn])])]
      const visibleTurns = new Set(turns.slice(-policy.windowTurns))
      const entries = bounded.filter(entry => !isSemantic(entry) || visibleTurns.has(entry.turn))
      const ids = new Set(entries.filter(isSemantic).map(entry => entry.id))
      const runningTurn = runningTurnOf(model, entries)
      const first = runningTurn === undefined ? -1 : entries.findIndex(entry => isSemantic(entry) && entry.turn === runningTurn)
      plan = {
        sourceEntries: model.entries, policy, liveTurn: model.live?.turn, liveStep: model.live?.step,
        streaming: model.streaming, turns: model.turns, entries, ids,
        expandableTurns: new Set(turns.slice(-policy.expandTurns)), runningTurn, split: first < 0 ? entries.length : first,
      }
      this.plan = plan
      this.prefix = undefined
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
    const flat = model.streaming === undefined || this.renderer.semantic === false
    const tailEntries = [...plan.entries.slice(plan.split), ...liveEntries]
    const tailFirst = tailEntries.find(isSemantic)?.seq
    const display = (entries: TranscriptModel['entries'], previousSeq?: number): DisplayItem[] => buildDisplay({
      entries, policy: policy.process, runningTurn: plan.runningTurn, turns: model.turns,
      expanded: this.expanded, scope: plan.expandableTurns, flat, previousSeq,
    })
    let prefix = this.prefix
    if (prefix === undefined || prefix.width !== width || prefix.expanded !== this.expanded) {
      const items = display(plan.entries.slice(0, plan.split))
      const anchors = [...this.anchored.values()].filter(item => tailFirst === undefined || item.seq < tailFirst)
      prefix = { width, expanded: this.expanded, items, rows: this.renderItems(items, anchors, width, policy), lastSeq: lastItemSeq(items, undefined) }
      this.prefix = prefix
    }
    const tailItems = tailEntries.length === 0 ? [] : display(tailEntries, prefix.lastSeq)
    this.pruneRows(new Set([...prefix.items, ...tailItems].flatMap(item => item.kind === 'entry' ? [] : [item.id])))
    // A live frame is a fresh array over the shared stable rows: identity
    // caches downstream (the frame clamp) see the change without a scan.
    let rows = prefix.rows
    if (tailFirst !== undefined) {
      const anchors = [...this.anchored.values()].filter(item => item.seq >= tailFirst)
      rows = [...prefix.rows, ...this.renderItems(tailItems, anchors, width, policy)]
    }
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
   * item whose seq does not exceed `seq`. Anchored content is presentation-only
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
   * Group anchored items by the display index they render before. Each item
   * carries an ordering seq (a canonical node inherits the preceding one;
   * leading canonicals keep header position), so an anchor past every seq
   * lands at the tail of whatever items are visible — folding and grouping
   * never displace it.
   */
  private anchoredInsertions(items: readonly DisplayItem[], anchors: readonly AnchoredContent[]): Map<number, AnchoredContent[]> | undefined {
    if (anchors.length === 0) return undefined
    const insertions = new Map<number, AnchoredContent[]>()
    for (const anchor of [...anchors].sort((a, b) => a.seq - b.seq || a.order - b.order)) {
      let index = 0
      let lastSeq = Number.NEGATIVE_INFINITY
      for (let at = 0; at < items.length; at += 1) {
        const seq = items[at]!.seq
        if (seq !== undefined) lastSeq = seq
        if (lastSeq <= anchor.seq) index = at + 1
      }
      const list = insertions.get(index)
      if (list === undefined) insertions.set(index, [anchor])
      else list.push(anchor)
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

  /** Render display items with their anchored locals interleaved. */
  private renderItems(items: readonly DisplayItem[], anchors: readonly AnchoredContent[], width: number, policy: TranscriptPresentationSnapshot): string[] {
    const insertions = this.anchoredInsertions(items, anchors)
    if (insertions === undefined) return items.flatMap(item => this.renderItem(item, width, policy))
    return [
      ...this.anchoredRowsAt(insertions, 0, width),
      ...items.flatMap((item, index) => [...this.renderItem(item, width, policy), ...this.anchoredRowsAt(insertions, index + 1, width)]),
    ]
  }

  private renderItem(item: DisplayItem, width: number, policy: TranscriptPresentationSnapshot): string[] {
    if (item.kind !== 'entry') return this.renderRow(item, width)
    return isSemantic(item.entry)
      ? this.renderSemantic(item.entry, width, item, policy)
      : this.renderCanonical(item.entry, width)
  }

  /** Render one turn header or group title through its reused row component. */
  private renderRow(item: TurnHeaderItem | ProcessTitleItem, width: number): string[] {
    // Header and title ids carry distinct prefixes, so an id never changes kind.
    let row = this.rowComponents.get(item.id)
    if (row === undefined) {
      const onTick = (): void => {
        this.renderedRows = undefined
        this.renderer.requestRender()
      }
      const t = this.renderer.t ?? interpolateLocaleMessage
      if (item.kind === 'turn-header') {
        const target = new TurnHeaderComponent(this.renderer.colors, this.renderer.components, onTick, t)
        row = { kind: 'turn-header', target, component: new GutterComponent(target) }
      } else {
        const target = new ProcessTitleComponent(this.renderer.colors, this.renderer.components, onTick, t)
        row = { kind: 'process-title', target, component: new GutterComponent(target) }
      }
      this.rowComponents.set(item.id, row)
    }
    if (row.kind === 'turn-header') row.target.update(item as TurnHeaderItem)
    else row.target.update(item as ProcessTitleItem)
    return row.component.render(width)
  }

  /** Dispose header and title rows that left the display plan. */
  private pruneRows(live: ReadonlySet<string>): void {
    for (const [id, row] of this.rowComponents) {
      if (live.has(id)) continue
      this.disposeComponent(row.target)
      this.rowComponents.delete(id)
    }
  }

  private clearAnchored(): void {
    for (const item of this.anchored.values()) this.disposeComponent(item.component)
    this.anchored.clear()
  }

  private dropRows(): void {
    this.renderedRows = undefined
    this.prefix = undefined
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
    this.dropRows()
    for (const cached of this.cached.values()) {
      cached.rows = undefined
      cached.target.invalidate()
    }
  }

  invalidate(): void {
    this.dropRows()
    this.canonicalRows = new WeakMap()
    for (const cached of this.cached.values()) {
      cached.rows = undefined
      cached.component.invalidate()
    }
    for (const row of this.rowComponents.values()) row.component.invalidate()
    for (const item of this.anchored.values()) {
      item.cached = undefined
      item.component.invalidate()
    }
  }

  /** Dispose timers and async renderer resources held by cached components. */
  dispose(): void {
    this.dropRows()
    this.plan = undefined
    this.liveIds.clear()
    this.canonicalRows = new WeakMap()
    this.clearAnchored()
    this.prune(new Set())
    this.pruneRows(new Set())
  }

  private renderSemantic(entry: TranscriptEntryModel, width: number, disclosure: EntryItem, policy: TranscriptPresentationSnapshot): string[] {
    if (this.renderer.semantic === false) return renderCanonicalNode({ kind: 'text', content: this.plainText(entry) }, width, this.renderer)
    const revision = entryRevision(entry)
    const variant = variantOf(entry)
    let cached = this.cached.get(entry.id)
    if (cached !== undefined && (cached.kind !== entry.kind || cached.variant !== variant || (cached.revision !== revision && !cached.update(entry)))) {
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
    const target = cached.target as DisclosureTarget
    target.setExpanded?.(disclosure.expanded)
    target.setScope?.({ hint: disclosure.hint, turnClosed: disclosure.turnClosed })
    const key = `${String(disclosure.expanded)}:${String(disclosure.hint)}:${String(disclosure.turnClosed)}`
    const rendered = cached.rows
    if (rendered?.revision === revision
      && rendered.width === width
      && rendered.disclosure === key
      && rendered.policy === policy) return rendered.rows
    const rows = cached.component.render(width)
    cached.rows = { revision, width, disclosure: key, policy, rows }
    return rows
  }

  private invalidateEntry(id: string): void {
    const cached = this.cached.get(id)
    if (cached !== undefined) cached.rows = undefined
    this.renderedRows = undefined
    if (this.plan?.ids.has(id)) this.prefix = undefined
  }

  /** Current tree policy, or immutable shipped defaults for standalone consumers. */
  private presentation(): TranscriptPresentationSnapshot {
    return this.renderer?.presentation?.snapshot() ?? DEFAULT_TRANSCRIPT_PRESENTATION
  }

  private createComponent(entry: TranscriptEntryModel): CachedComponent {
    const renderer = this.renderer
    const t = renderer.t ?? interpolateLocaleMessage
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
          t,
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
        const item: TranscriptThinkingItem = {
          kind: 'thinking', seq: entry.seq, turn: entry.turn, step: entry.step, text: entry.text, streaming: entry.streaming,
          outputProgress: entry.outputProgress, durationMs: entry.durationMs, startedAt: entry.startedAt,
        }
        target = new ThinkingComponent(item, renderer.colors, renderer.components, () => {
          this.invalidateEntry(entry.id)
          renderer.requestRender()
        }, () => this.presentation().process.settledReasoningPreview, t)
        update = (next): boolean => {
          const thinking = next as Extract<TranscriptEntryModel, { readonly kind: 'transcript-thinking' }>
          item.text = thinking.text
          item.streaming = thinking.streaming
          item.outputProgress = thinking.outputProgress
          item.durationMs = thinking.durationMs
          item.startedAt = thinking.startedAt
          target.invalidate()
          return true
        }
        break
      }
      case 'transcript-tool': {
        if (isLineTool(entry)) {
          const line = new ToolLineComponent(entry, renderer.colors, renderer.components, t)
          target = line
          update = (next): boolean => {
            line.update(next as TranscriptToolModel)
            return true
          }
          break
        }
        let tool = entry
        const body = new ToolModelComponent(() => tool.presentation ?? null, renderer)
        const component = new ToolCallComponent(asToolItem(entry), renderer.colors, renderer.components, body, toolResultChip(entry.presentation), t)
        target = component
        update = (next): boolean => {
          tool = next as Extract<TranscriptEntryModel, { readonly kind: 'transcript-tool' }>
          component.update(asToolItem(tool), toolResultChip(tool.presentation))
          return true
        }
        break
      }
      case 'transcript-read-group': {
        const group = new ReadGroupComponent(entry, renderer.colors, renderer.components, t)
        target = group
        update = (next): boolean => {
          group.update(next as Extract<TranscriptEntryModel, { readonly kind: 'transcript-read-group' }>)
          return true
        }
        break
      }
      case 'transcript-search-group': {
        const group = new SearchGroupComponent(entry, renderer.colors, renderer.components, t)
        target = group
        update = (next): boolean => {
          group.update(next as Extract<TranscriptEntryModel, { readonly kind: 'transcript-search-group' }>)
          return true
        }
        break
      }
      case 'transcript-command-group': {
        const group = new CommandGroupComponent(entry, renderer.colors, renderer.components, t)
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
      variant: variantOf(entry),
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
