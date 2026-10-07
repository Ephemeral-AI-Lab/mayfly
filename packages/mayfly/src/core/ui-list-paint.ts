/**
 * The list painter (spec 4.4): rows of one list as the kit draws them, in their cacheable form. A row is a function of
 * its item and its state bits (focused, selected, open, segment, width), so a cursor move repaints two rows. Rows have
 * varying height (a wrapped label, a body), so windowing runs over a prefix-sum index of the rows' line counts, and
 * `maxRows` windows over entries with the `↑ n more · ↓ n more` row.
 *
 * @module @ephemeral-ai/mayfly/core/ui-list-paint
 */

import type { MayflyInlineSpan, MayflyListItem, MayflyListNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflySemanticColors } from './types.ts'
import { paintSpan, paintTone } from './ui-paint.ts'
import { inlineSegmentStrip, segmentFitsInline, segmentFooter, type SegmentView } from './ui-list-segment.ts'
import type { UiRowCache } from './ui-row-cache.ts'
import type { MayflyWorkCounters } from './ui-work-counters.ts'
import { sliceByColumn, visibleWidth, wrapTextWithAnsi } from './width.ts'

/** One visible row of a list: the item and how the model sees it (tree depth, disclosure) and where it sits. */
export interface ListRowSpec {
  readonly item: MayflyListItem
  readonly depth: number
  readonly last: boolean
  readonly expandable: boolean
  readonly open: boolean
  /** The visible position of the row, so numbers stay stable while the window scrolls. */
  readonly position: number
}

/** Where `paintList` keeps the rows it has painted, and the sink that counts the ones it had to paint. */
export interface ListRowMemo {
  readonly cache: UiRowCache
  readonly counters?: MayflyWorkCounters | undefined
}

export interface ListPaintOptions {
  readonly rows: readonly ListRowSpec[]
  /** The list's cursor row, drawn bold even while the list has no focus. */
  readonly cursorId: string | undefined
  /** The list holds focus: its cursor row shows the arrow. */
  readonly focused: boolean
  /** The focus marker that rides after the arrow. */
  readonly marker: string
  readonly selectedIds: readonly string[]
  /** A row's segment state, for the strip on the focused row. */
  readonly segment?: ((item: MayflyListItem) => SegmentView | undefined) | undefined
  /** The strip's caption in the reserved footer when the segment has no label of its own. */
  readonly segmentLabel?: string
  /** Paints a node body at a width. */
  readonly body?: ((item: MayflyListItem, width: number) => readonly string[]) | undefined
  /** Items before and after the materialized rows, which `maxRows` counts as hidden. */
  readonly before?: number
  readonly after?: number
  /** All visible items of the list, for the `maxRows` test; the materialized rows when absent. */
  readonly total?: number
  /** A painted row ahead of the list's own, windowed with them (a legacy filter echo). */
  readonly lead?: string
  readonly translate?: ((key: string, values?: Readonly<Record<string, string | number>>) => string) | undefined
  readonly memo?: ListRowMemo | undefined
}

type Entry =
  | { readonly kind: 'group' | 'body' | 'rule' | 'gap', readonly lines: readonly string[] }
  | { readonly kind: 'item', readonly id: string, readonly lines: readonly string[] }

const strong = (text: string): string => `\x1b[1m${text}\x1b[22m`
const DEFAULT_METER_WIDTH = 8
const DETAIL_MIN_WIDTH = 40
const ELLIPSIS = '…'

function safeWidth(width: number): number {
  return Math.max(1, Number.isFinite(width) ? Math.floor(width) : 1)
}

/** Pad a painted line to `width` columns, or return it unchanged when it is already as wide. */
function padTo(line: string, width: number): string {
  const missing = width - visibleWidth(line)
  return missing > 0 ? `${line}${' '.repeat(missing)}` : line
}

/** Cut a painted line to `width` columns; the ellipsis keeps the style the cut left open, and the row ends reset. */
export function clipRow(line: string, width: number): string {
  return visibleWidth(line) <= width ? line : `${sliceByColumn(line, 0, Math.max(0, width - 1), true)}${ELLIPSIS}\x1b[0m`
}

function spansText(spans: readonly MayflyInlineSpan[], colors: MayflySemanticColors): string {
  return spans.map(span => paintSpan(span, colors)).join('')
}

/** The check column of a row: `●` chosen, `○` not, `◐` for a parent with some of its children chosen. */
function checkOf(node: ListNodeView, spec: ListRowSpec, selected: boolean, selectedIds: readonly string[]): string {
  if (node.mode !== 'multiple' && node.marks !== true) return ''
  if (node.mode === 'multiple' && node.tree === true) {
    const children = node.items.filter(child => child.parentId === spec.item.id)
    if (children.length > 0) {
      const chosen = children.filter(child => selectedIds.includes(child.id)).length
      return chosen === 0 ? (selected ? '●' : '○') : chosen === children.length ? '●' : '◐'
    }
  }
  return selected ? '●' : '○'
}

type ListNodeView = Pick<MayflyListNode, 'items' | 'marker' | 'marks' | 'mode' | 'tree' | 'numbered' | 'maxRows'>

/** A one-row meter: `▰` filled in the tone, `▱` empty and muted. */
function meterText(meter: NonNullable<MayflyListItem['meter']>, colors: MayflySemanticColors): string {
  const width = meter.width ?? DEFAULT_METER_WIDTH
  const filled = Math.round((meter.value / meter.max) * width)
  return `${paintTone(meter.tone ?? 'primary', '▰'.repeat(filled), colors)}${colors.muted('▱'.repeat(width - filled))}`
}

/** The text after the label: badge, meter, detail, and the reason a row is disabled. */
function trailer(item: MayflyListItem, width: number, colors: MayflySemanticColors): string {
  const badge = item.badge === undefined ? '' : ` ${colors.muted(`[${item.badge}]`)}`
  const meter = item.meter === undefined ? '' : ` ${meterText(item.meter, colors)}`
  if (width <= DETAIL_MIN_WIDTH) return `${badge}${meter}`
  const detail = item.detailSpans !== undefined
    ? item.detailSpans.length === 0 ? '' : ` ${colors.muted('—')} ${spansText(item.detailSpans, colors)}`
    : item.detail === undefined ? '' : ` ${colors.muted(item.detail.startsWith('—') ? item.detail : `— ${item.detail}`)}`
  const reason = item.disabled === true && item.disabledReason !== undefined ? ` ${colors.muted(`— ${item.disabledReason}`)}` : ''
  return `${badge}${meter}${detail}${reason}`
}

interface RowState {
  readonly node: ListNodeView
  readonly spec: ListRowSpec
  readonly on: boolean
  readonly focused: boolean
  readonly width: number
  readonly marker: string
  readonly check: string
  readonly number: string
  readonly view: SegmentView | undefined
}

/** The columns before the label: the gutter, indent, tree guides, disclosure, number, and check. */
function prefixOf(state: RowState, colors: MayflySemanticColors): string {
  const { spec, on, focused } = state
  const item = spec.item
  const disabled = item.disabled === true
  const showArrow = on && !disabled && (focused || state.node.marker === 'selection')
  const arrow = showArrow ? strong(focused ? colors.primary('→') : colors.muted('→')) : ' '
  const gutter = `${arrow}${showArrow && focused ? state.marker : ' '}`
  const indent = item.indent === undefined ? '' : ' '.repeat(item.indent)
  const guides = spec.depth === 0 ? '' : `${'  '.repeat(spec.depth - 1)}${colors.muted(spec.last ? '╰ ' : '│ ')}`
  const glyph = spec.open ? '▾' : '▸'
  const disclosure = spec.expandable ? `${on ? colors.primary(glyph) : colors.muted(glyph)} ` : ''
  const number = state.number === '' ? '' : `${colors.muted(state.number)}  `
  const check = state.check === '' ? '' : `${state.check === '○' || disabled ? colors.muted(state.check) : colors.primary(state.check)} `
  return `${gutter}${indent}${guides}${disclosure}${number}${check}`
}

function labelOf(state: RowState, colors: MayflySemanticColors): string {
  const item = state.spec.item
  if (item.labelSpans !== undefined) return spansText(item.labelSpans, colors)
  if (item.disabled === true) return colors.muted(item.label)
  return state.on ? strong(colors.text(item.label)) : colors.text(item.label)
}

/** The row's head as one painted line, before wrapping, the strip, and the right spans. */
function headOf(state: RowState, colors: MayflySemanticColors): { readonly prefix: string, readonly line: string } {
  const prefix = prefixOf(state, colors)
  return { prefix, line: `${prefix}${labelOf(state, colors)}${trailer(state.spec.item, state.width, colors)}` }
}

/** Wrap a row's text under its own prefix: continuation lines align under the label, `wrapMax` keeps the first lines. */
function wrapped(state: RowState, head: { readonly prefix: string, readonly line: string }, colors: MayflySemanticColors, translate: ListPaintOptions['translate']): readonly string[] {
  const hang = visibleWidth(head.prefix)
  const text = head.line.slice(head.prefix.length)
  const room = Math.max(1, state.width - hang)
  const pieces = wrapTextWithAnsi(text, room)
  const lines = pieces.map((piece, index) => `${index === 0 ? head.prefix : ' '.repeat(hang)}${piece}`)
  const limit = state.spec.item.wrapMax
  if (limit === undefined || lines.length <= limit) return lines
  const more = translate?.('▸ {count} more lines · Enter', { count: lines.length - limit }) ?? `▸ ${String(lines.length - limit)} more lines · Enter`
  return [...lines.slice(0, limit), `${' '.repeat(hang)}${colors.muted(more)}`]
}

/** The rows of one item: its head (wrapped or one line, with its strip or right spans) and nothing else. */
function headLines(state: RowState, colors: MayflySemanticColors, translate: ListPaintOptions['translate']): readonly string[] {
  const { spec, width } = state
  const item = spec.item
  if (item.gap === true) return ['']
  if (item.rule !== undefined) {
    const text = item.rule.length === 0 ? '' : ` ${item.rule}`
    return [colors.muted(`  ${'─'.repeat(Math.max(2, width - 2 - visibleWidth(text)))}${text}`)]
  }
  const head = headOf(state, colors)
  let line = head.line
  if (state.on && state.focused && state.view !== undefined) {
    const strip = inlineSegmentStrip(state.view, width - visibleWidth(head.line) - 2, colors)
    if (strip !== undefined) return [`${padTo(head.line, width - strip.width)}${strip.text}`]
  }
  const spans = state.on && item.rightFocus !== undefined ? item.rightFocus : item.right
  if (spans !== undefined) {
    const right = spansText(spans, colors)
    line = `${padTo(clipRow(line, Math.max(1, width - visibleWidth(right) - 1)), width - visibleWidth(right))}${right}`
  }
  if (item.wrap === true) return wrapped(state, { prefix: head.prefix, line }, colors, translate)
  return [clipRow(line, width)]
}

/** The lines of an open body: guides for text, content for a node. */
function bodyLines(spec: ListRowSpec, width: number, colors: MayflySemanticColors, paintBody: ListPaintOptions['body']): readonly string[] {
  const item = spec.item
  if (item.body === undefined) return []
  const indent = ' '.repeat(item.indent ?? 0)
  const always = item.bodyAlways === true
  if (typeof item.body === 'string') {
    const lines = item.body.split('\n')
    if (always) return lines.map(line => clipRow(`${indent}       ${colors.muted(line)}`, width))
    return lines.map((line, index) => clipRow(`${indent}    ${colors.muted(index === lines.length - 1 ? '╰ ' : '│ ')}${colors.muted(line)}`, width))
  }
  if (paintBody === undefined) return []
  if (always) return paintBody(item, Math.max(1, width - 2 - indent.length)).map(line => `${indent}  ${line}`)
  return paintBody(item, Math.max(1, width - 6 - indent.length)).map((line, index, all) => `${indent}    ${colors.muted(index === all.length - 1 ? '╰ ' : '│ ')}${line}`)
}

/** The width of a row's head: what the strip has to share the line with. */
function headWidth(state: RowState, colors: MayflySemanticColors): number {
  return visibleWidth(headOf({ ...state, on: true }, colors).line)
}

/**
 * The lines of a list, windowed to `height`. `node` carries the list's presentation fields; `options.rows` are the
 * materialized visible rows in order. The painted rows come from the memo when an item's state bits are unchanged.
 */
export function paintList(node: ListNodeView, width: number, height: number, colors: MayflySemanticColors, options: ListPaintOptions): string[] {
  const available = safeWidth(width)
  const numbered = node.numbered !== undefined && node.numbered !== false
  const entries: Entry[] = []
  let group: string | undefined
  let footerFor: SegmentView | undefined
  if (options.lead !== undefined) entries.push({ kind: 'group', lines: [options.lead] })
  let needsFooter = false
  for (const spec of options.rows) {
    const item = spec.item
    if (item.group !== undefined && item.group !== group) {
      group = item.group
      entries.push({ kind: 'group', lines: [clipRow(colors.muted(item.group), available)] })
    }
    const on = options.cursorId === item.id && item.disabled !== true
    const selected = options.selectedIds.includes(item.id)
    const view = options.segment?.(item)
    const state: RowState = {
      node, spec, on, focused: options.focused, width: available, marker: options.marker,
      check: checkOf(node, spec, selected, options.selectedIds),
      number: numbered && spec.position < 9 ? String(spec.position + 1) : '',
      view,
    }
    if (view !== undefined) {
      if (!segmentFitsInline(view, available - headWidth(state, colors) - 2, colors)) needsFooter = true
      if (on && options.focused) footerFor = view
    }
    if (item.gap === true || item.rule !== undefined) {
      entries.push({ kind: item.gap === true ? 'gap' : 'rule', lines: headLines(state, colors, options.translate) })
      continue
    }
    const key = [
      available, state.marker, on ? 1 : 0, options.focused ? 1 : 0, node.marker === 'selection' ? 1 : 0, state.check, state.number,
      spec.depth, spec.last ? 1 : 0, spec.expandable ? 1 : 0, spec.open ? 1 : 0,
      view === undefined ? '' : `${view.active ?? ''}\0${view.pinned ?? ''}`,
    ].join('\x01')
    const painted = options.memo === undefined
      ? headLines(state, colors, options.translate)
      : options.memo.cache.readLines(colors, item, key, () => headLines(state, colors, options.translate), options.memo.counters)
    entries.push({ kind: 'item', id: item.id, lines: painted })
    if (spec.open && item.body !== undefined) {
      const body = options.memo === undefined
        ? bodyLines(spec, available, colors, options.body)
        : options.memo.cache.readLines(colors, item, `body\x01${String(available)}\x01${spec.open ? 1 : 0}`, () => bodyLines(spec, available, colors, options.body), options.memo.counters)
      if (body.length > 0) entries.push({ kind: 'body', lines: body })
    }
  }

  // maxRows windows over entries (a group heading and an open body each count as one), with the rest counted as hidden.
  let shown: readonly Entry[] = entries
  let hiddenAbove = 0
  let hiddenBelow = 0
  const total = options.total ?? options.rows.length
  if (node.maxRows !== undefined && total > node.maxRows) {
    const at = Math.max(0, entries.findIndex(entry => entry.kind === 'item' && entry.id === options.cursorId))
    const start = Math.max(0, Math.min(entries.length - node.maxRows, at - Math.floor(node.maxRows / 2)))
    shown = entries.slice(start, start + node.maxRows)
    hiddenAbove = (options.before ?? 0) + start
    hiddenBelow = (options.after ?? 0) + entries.length - start - shown.length
  }

  // The prefix sums of the shown entries' line counts place the cursor row, whatever height each row has.
  const footer = needsFooter ? 2 : 0
  const more = hiddenAbove > 0 || hiddenBelow > 0 ? 1 : 0
  const limit = Math.max(1, (Number.isFinite(height) ? Math.floor(height) : 1) - footer - more)
  const starts: number[] = []
  let lineCount = 0
  for (const entry of shown) { starts.push(lineCount); lineCount += entry.lines.length }
  let lines = shown.flatMap(entry => entry.lines)
  if (lineCount > limit) {
    const focusAt = shown.findIndex(entry => entry.kind === 'item' && entry.id === options.cursorId)
    const first = focusAt < 0 ? 0 : starts[focusAt]!
    const rows = focusAt < 0 ? 1 : shown[focusAt]!.lines.length
    let begin = focusAt < 0 ? 0 : Math.min(Math.max(0, first - Math.floor(limit / 2) + Math.floor(rows / 2)), lineCount - limit)
    if (focusAt >= 0) begin = Math.max(Math.min(begin, first), first + rows - limit)
    lines = lines.slice(begin, begin + limit)
  }
  if (more > 0) {
    const text = options.translate?.('↑ {above} more · ↓ {below} more', { above: hiddenAbove, below: hiddenBelow }) ?? `↑ ${String(hiddenAbove)} more · ↓ ${String(hiddenBelow)} more`
    lines.push(`   ${colors.muted(text)}`)
  }
  if (needsFooter) {
    lines.push('', footerFor === undefined ? '' : segmentFooter(footerFor, available, colors, footerFor.segment.label ?? options.segmentLabel ?? 'Options'))
  }
  return lines
}
