/**
 * Renderer-neutral tool presentation registry and canonical conversion from
 * the official dsh-tools presentation vocabulary.
 *
 * @module @ephemeral-ai/mayfly/transcript/tool-model
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolCallView, ToolResult, ToolResultView } from '@deepseek-ai/dsh-tools'
import type { MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { diffChangeCounts, type MayflyComponent } from '../core/index.ts'
import { freezeModel, interpolateLocaleMessage, type MayflyTranslate, type ToolPresentationModel } from '../frontend/index.ts'
import { renderCanonicalNode, type CanonicalNodeRenderer } from './canonical-node-renderer.ts'
import { summarizeToolText } from './envelope.ts'
import { moreLinesHint } from './hints.ts'
import { summarizeToolCall } from './present.ts'

/** Rows a collapsed structured body (a diff, sections) keeps. */
const COLLAPSED_ROW_LIMIT = 12

/** Rows a collapsed plain-text result keeps. */
const COLLAPSED_TEXT_LIMIT = 3

/** Official facts required to build one renderer-neutral tool card. */
export interface ToolPresentationFacts {
  readonly id: string
  readonly name: string
  readonly call?: ToolCallView
  readonly result?: ToolResultView
  readonly outcome?: ToolResult
  readonly expanded?: boolean
}

/** Convert official call/result presentation metadata without reading events. */
export function createToolPresentationModel(facts: ToolPresentationFacts): ToolPresentationModel {
  const call = facts.call === undefined ? undefined : toolCallNode(facts.call)
  const model: ToolPresentationModel = {
    kind: 'tool',
    id: facts.id,
    name: facts.name,
    ...(call === undefined ? {} : { call }),
    ...(facts.result === undefined && facts.outcome === undefined ? {} : { result: toolResultNode(facts.result, facts.outcome, facts.name) }),
    ...(facts.expanded === undefined ? {} : { expanded: facts.expanded }),
    action: { kind: 'tool.toggle', id: facts.id },
  }
  return freezeModel(model)
}

/**
 * Map one official pending-call view to the canonical frontend vocabulary.
 * The card header already shows the view's title, so a generic call yields a
 * node only when its content or salient input adds something beyond it.
 */
export function toolCallNode(view: ToolCallView): MayflyUiNode | undefined {
  switch (view.card) {
    case 'generic': {
      const content = contentText(view.content) ?? (view.rawInput === undefined ? undefined : readableValue(view.rawInput))
      return content === undefined || content.trim() === '' || view.title.includes(content.trim()) ? undefined : { kind: 'text', content }
    }
    case 'terminal': {
      const sections: { title: string; body: Extract<MayflyUiNode, { readonly kind: 'text' | 'code' }> }[] = []
      if (view.description !== undefined || view.cwd !== undefined) sections.push({ title: view.description ?? 'cwd', body: { kind: 'text', content: view.cwd ?? '' } })
      sections.push({ title: 'Command', body: { kind: 'code', code: view.title } })
      return { kind: 'sections', sections }
    }
    case 'diff':
      return diffSections(view.title, view.diffs)
  }
}

/** Map one official settled-result view, or its canonical raw fallback. */
export function toolResultNode(view: ToolResultView | undefined, outcome: ToolResult | undefined, name: string): MayflyUiNode {
  const fallback = summarizeToolText(contentText(outcome?.content) ?? '(no output)')
  if (outcome?.isError === true) return { kind: 'text', content: fallback, tone: 'danger' }
  if (view === undefined) return { kind: 'text', content: fallback }
  switch (view.card) {
    case 'generic':
      return { kind: 'text', content: contentText(view.content) ?? fallback }
    case 'terminal': {
      const status = view.exitCode === undefined ? view.signal === undefined ? 'complete' : `signal ${view.signal}` : `exit ${String(view.exitCode)}`
      return { kind: 'sections', sections: [
        { title: view.title ?? name, body: { kind: 'code', code: view.output ?? fallback } },
        { title: 'Status', body: { kind: 'text', content: status } },
      ] }
    }
    case 'diff':
      return diffSections(view.title ?? name, view.diffs)
    case 'search': {
      // The compact registry shape: counts, never the match corpus — the
      // transcript's grouped card renders from the group model instead.
      if (view.shape === 'paths') {
        const count = view.total
        return { kind: 'fields', rows: [{ label: 'paths', value: [{ text: count === view.paths.length ? String(count) : `${String(view.paths.length)} of ${String(count)}` }] }] }
      }
      const kept = view.files.reduce((sum, file) => sum + file.matches.length, 0)
      const matches = view.truncated && view.total !== kept ? `${String(kept)} of ${String(view.total)}` : String(kept)
      return { kind: 'fields', rows: [
        { label: 'files', value: [{ text: String(view.files.length) }] },
        { label: 'matches', value: [{ text: matches }] },
      ] }
    }
    case 'read': {
      // The compact registry shape: the window facts, never the content —
      // the transcript's grouped card renders from the group model instead.
      const first = view.lines[0]?.number
      const last = view.lines.at(-1)?.number
      const window = first === undefined || last === undefined
        ? `from line ${String(view.offset)}`
        : `${String(first)}-${String(last)}`
      const open = view.totalLines > (last ?? view.offset - 1) ? ` of ${String(view.totalLines)}` : ''
      return { kind: 'fields', rows: [
        { label: 'path', value: [{ text: view.path }] },
        { label: 'lines', value: [{ text: `${window}${String(open)}` }] },
      ] }
    }
    case 'web':
      if (view.kind === 'fetch') return { kind: 'fields', rows: [
        { label: 'url', value: [{ text: view.url }] },
        { label: 'status', value: [{ text: String(view.statusCode) }] },
        { label: 'truncated', value: [{ text: view.truncated ? 'yes' : 'no' }] },
      ] }
      return { kind: 'list', role: 'browse', id: 'tool-web-sources', selectedIds: [], items: view.sources.map((source, index) => ({ id: `source-${String(index)}`, label: source.title ?? source.url, detail: source.snippet ?? source.url })) }
  }
}

/** One file section title: change counts, or the new-file shape for a create. */
function diffSectionTitle(diff: { readonly path: string; readonly oldText: string | null; readonly newText: string }): string {
  if (diff.oldText === null) {
    const { added } = diffChangeCounts('', diff.newText)
    return `${diff.path} · new file, +${String(added)} lines`
  }
  const { added, removed } = diffChangeCounts(diff.oldText, diff.newText)
  return `${diff.path} · +${String(added)} −${String(removed)}`
}

function diffSections(title: string, diffs: readonly { readonly path: string; readonly oldText: string | null; readonly newText: string }[]): MayflyUiNode {
  return { kind: 'sections', sections: diffs.length === 0
    ? [{ title, body: { kind: 'text', content: '(no changes)' } }]
    : diffs.map(diff => ({ title: diffSectionTitle(diff), body: { kind: 'diff', before: diff.oldText ?? '', after: diff.newText } })) }
}

/**
 * The semantic result chip for a tool card's header: summed `+A −D` when the
 * presentation's result is diff-shaped, or `undefined` to keep the plain line
 * count (the raw-result line count misleads on envelope-backed results).
 * @param presentation - the tool's presentation model, if any.
 * @returns the chip text, or `undefined` when no diff view contributes.
 */
export function toolResultChip(presentation: ToolPresentationModel | undefined): string | undefined {
  if (presentation === undefined) return undefined
  let added = 0
  let removed = 0
  const walk = (node: MayflyUiNode | undefined): void => {
    if (node === undefined) return
    if (node.kind === 'diff') {
      const counts = diffChangeCounts(node.before, node.after)
      added += counts.added
      removed += counts.removed
      return
    }
    if (node.kind === 'sections') for (const section of node.sections) walk(section.body)
    else if (node.kind === 'stack') for (const child of node.children) walk(child.node)
    else if (node.kind === 'surface') { walk(node.child); walk(node.footer) }
    else if (node.kind === 'scroll') walk(node.child)
    else if (node.kind === 'list') walk(node.empty)
    else if (node.kind === 'empty') walk(node.actions)
  }
  walk(presentation.result)
  if (added === 0 && removed === 0) return undefined
  return `+${String(added)} −${String(removed)}`
}

function readableValue(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) ?? String(value) } catch { return String(value) }
}

function contentText(content: readonly ContentBlock[] | undefined): string | undefined {
  if (content === undefined || content.length === 0) return undefined
  return content.map((block) => {
    switch (block.type) {
      case 'text':
      case 'reasoning': return block.text
      case 'image': return '[image]'
      case 'tool-call': return summarizeToolCall(block.name, block.arguments)
      default: return `[${String((block as { type: unknown }).type)}]`
    }
  }).join('\n')
}

/**
 * The presented body of one tool card. Collapsed it shows the settled result
 * (the pending call while running) under a row budget — three rows for plain
 * text, twelve for structured views such as diffs; expanded it shows the
 * call's own details followed by the complete result.
 */
class ToolModelComponent implements MayflyComponent {
  private expandedOverride: boolean | undefined
  private keyed = true
  constructor(
    private readonly source: () => ToolPresentationModel | null,
    private readonly renderer: CanonicalNodeRenderer & { readonly t?: MayflyTranslate | undefined },
  ) {}
  render(width: number): string[] {
    const model = this.source()
    if (model === null) return []
    const expanded = this.expandedOverride ?? model.expanded ?? false
    if (expanded) {
      // A settled structured call (a diff) repeats in its result; only a call's
      // own text details precede the result.
      const call = model.result !== undefined && model.call?.kind !== 'text' ? undefined : model.call
      return [call, model.result].flatMap(view => view === undefined ? [] : renderCanonicalNode(view, width, this.renderer))
    }
    const view = model.result ?? model.call
    if (view === undefined) return []
    // The tool component applies its own row budget after canonical content
    // has rendered completely, so its hidden-line count stays exact.
    const rows = renderCanonicalNode(view, width, this.renderer)
    const limit = view.kind === 'text' ? COLLAPSED_TEXT_LIMIT : COLLAPSED_ROW_LIMIT
    if (rows.length <= limit) return rows
    const remaining = rows.length - limit + 1
    const hint = moreLinesHint(this.renderer.t ?? interpolateLocaleMessage, remaining, rows.length, this.keyed)
    const hintRow = renderCanonicalNode({ kind: 'text', content: hint, tone: 'muted' }, width, this.renderer)[0]!
    return [...rows.slice(0, limit - 1), hintRow]
  }
  setExpanded(expanded: boolean): void { this.expandedOverride = expanded }
  /** Adopt whether Ctrl-O reaches the card, so the hint may name the key. */
  setScope(scope: { readonly hint: boolean }): void { this.keyed = scope.hint }
  invalidate(): void {}
}

export { ToolModelComponent }
