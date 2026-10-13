/**
 * The list painter (spec 4.4): rows of one list as the kit draws them, in their cacheable form. A row is a function of
 * its item and its state bits (focused, selected, open, segment, width), so a cursor move repaints two rows. Rows have
 * varying height (a wrapped label, a body), so windowing runs over a prefix-sum index of the rows' line counts, and
 * `maxRows` windows over entries with the `↑ n more · ↓ n more` row.
 *
 * @module @ephemeral-ai/mayfly/core/ui-list-paint
 */

import { hasMotion } from './ui-motion-text.ts'
import type { MayflyInlineSpan, MayflyListItem, MayflyListNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflySemanticColors } from './types.ts'
import { scanContentLines, type ContentLineScan } from './content-segments.ts'
import { paintSpan, paintTone } from './ui-paint.ts'
import { inlineSegmentStrip, segmentFitsInline, segmentFooter, type SegmentView } from './ui-list-segment.ts'
import type { UiRowCache } from './ui-row-cache.ts'
import { countWork, type MayflyWorkCounters } from './ui-work-counters.ts'
import { concatRows, mapRows, sliceRows, virtualRows } from './ui-rows.ts'
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
  /** The list lies in flow content that an outer scroll windows: its node bodies paint in full, not to the viewport. */
  readonly flow?: boolean
  readonly memo?: ListRowMemo | undefined
}

type Entry =
  | { readonly kind: 'group' | 'body' | 'rule' | 'gap', readonly lines: readonly string[] }
  | { readonly kind: 'item', readonly id: string, readonly lines: readonly string[] }

const strong = (text: string): string => `\x1b[1m${text}\x1b[22m`
const DEFAULT_METER_WIDTH = 8
const DETAIL_MIN_WIDTH = 40
const ELLIPSIS = '…'

/** Pad a painted line to `width` columns, or return it unchanged when it is already as wide. */
function padTo(line: string, width: number): string {
  const missing = width - visibleWidth(line)
  return missing > 0 ? `${line}${' '.repeat(missing)}` : line
}

/** Cut a painted line to `width` columns; the ellipsis keeps the style the cut left open, and the row ends reset. */
function clipRow(line: string, width: number): string {
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
  const showArrow = on && !disabled && state.node.marker !== 'band' && (focused || state.node.marker === 'selection')
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

/**
 * Wrap a row's text under its own prefix: continuation lines align under the label (or under the text after a leading
 * glyph, with `hang`), `wrapMax` keeps the first lines.
 */
function wrapped(state: RowState, head: { readonly prefix: string, readonly line: string }, colors: MayflySemanticColors, translate: ListPaintOptions['translate']): readonly string[] {
  const margin = visibleWidth(head.prefix)
  const text = head.line.slice(head.prefix.length)
  // The hang is the leading glyph's width: it stays on the first line and the text wraps in the room that is left.
  const hang = Math.min(state.spec.item.hang ?? 0, visibleWidth(text))
  const lead = hang === 0 ? '' : sliceByColumn(text, 0, hang, true)
  const pieces = wrapTextWithAnsi(hang === 0 ? text : sliceByColumn(text, hang, visibleWidth(text) - hang, true), Math.max(1, state.width - margin - hang))
  const lines = pieces.map((piece, index) => `${index === 0 ? `${head.prefix}${lead}` : ' '.repeat(margin + hang)}${piece}`)
  const limit = state.spec.item.wrapMax
  if (limit === undefined || lines.length <= limit) return lines
  const more = translate?.('▸ {count} more lines · Enter', { count: lines.length - limit }) ?? `▸ ${String(lines.length - limit)} more lines · Enter`
  return [...lines.slice(0, limit), `${' '.repeat(margin + hang)}${colors.muted(more)}`]
}

/** Whether a row belongs to the block of the item that holds the cursor, however deep it sits under it. */
function within(item: MayflyListItem, cursorId: string, parents: ReadonlyMap<string, string>): boolean {
  let parent = item.under
  for (let depth = 0; parent !== undefined && depth < 4; depth += 1) {
    if (parent === cursorId) return true
    parent = parents.get(parent)
  }
  return false
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

/**
 * The line table of one item's string body, kept on the admitted item so an open body scans once and the list window
 * paints only the rows it shows — a body of any size costs the window's rows, never the document's.
 */
const bodyScans = new WeakMap<MayflyListItem, ContentLineScan>()

function bodyScan(item: MayflyListItem, body: string, counters: MayflyWorkCounters | undefined): ContentLineScan {
  let scan = bodyScans.get(item)
  if (scan === undefined) {
    scan = scanContentLines(body)
    countWork(counters, 'linesEstimated', scan.starts.length)
    bodyScans.set(item, scan)
  }
  return scan
}

/** The lines of an open body: guides for text, content for a node. */
function bodyLines(spec: ListRowSpec, width: number, colors: MayflySemanticColors, paintBody: ListPaintOptions['body'], counters: MayflyWorkCounters | undefined): readonly string[] {
  // Only an open row with a body asks for its body lines.
  const item = spec.item
  const body = item.body!
  const indent = ' '.repeat(item.indent ?? 0)
  const always = item.bodyAlways === true
  if (typeof body === 'string') {
    const scan = bodyScan(item, body, counters)
    // `split('\n')` parity: an empty body is one empty line under the guide.
    const count = Math.max(1, scan.starts.length)
    const last = count - 1
    return virtualRows({
      get length() { return count },
      declaredWidth: width,
      // Admission strips the markers from body text, so a caret or sentinel search skips the body whole.
      markerFree: true,
      row(index) {
        // The facade clamps reads to `index < count`; past `starts.length` only the empty body's single row exists.
        countWork(counters, 'rowsMaterialized')
        const line = index < scan.starts.length ? body.slice(scan.starts[index]!, scan.ends[index]!) : ''
        return always
          ? clipRow(`${indent}       ${colors.muted(line)}`, width)
          : clipRow(`${indent}    ${colors.muted(index === last ? '╰ ' : '│ ')}${colors.muted(line)}`, width)
      },
    })
  }
  if (paintBody === undefined) return []
  if (always) return mapRows(paintBody(item, Math.max(1, width - 2 - indent.length)), line => `${indent}  ${line}`)
  const lines = paintBody(item, Math.max(1, width - 6 - indent.length))
  return mapRows(lines, (line, index) => `${indent}    ${colors.muted(index === lines.length - 1 ? '╰ ' : '│ ')}${line}`)
}

/**
 * The rows of an item whose body leads them (`bodyLead`): no head line, the lead spans after the cursor gutter on the
 * body's first row, and the body in the columns that remain with its other rows under it.
 */
function leadedLines(state: RowState, colors: MayflySemanticColors, paintBody: ListPaintOptions['body']): readonly string[] {
  const item = state.spec.item
  const prefix = prefixOf(state, colors)
  const lead = spansText(item.bodyLead!, colors)
  const margin = visibleWidth(prefix) + visibleWidth(lead)
  const rows = paintBody === undefined ? [] : paintBody(item, Math.max(1, state.width - margin))
  if (rows.length === 0) return [`${prefix}${lead}`]
  const pad = ' '.repeat(margin)
  return mapRows(rows, (line, index) => `${index === 0 ? `${prefix}${lead}` : pad}${line}`)
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
  // The wrapper hands over a finite width; the floor of one column keeps every ladder total.
  const available = Math.max(1, Math.floor(width))
  const numbered = node.numbered !== undefined && node.numbered !== false
  const entries: Entry[] = []
  let group: string | undefined
  let footerFor: SegmentView | undefined
  if (options.lead !== undefined) entries.push({ kind: 'group', lines: [options.lead] })
  let needsFooter = false
  // Which item each row sits under, so a band can follow the chain from a body to its call to the head.
  const parents = new Map<string, string>()
  for (const spec of options.rows) if (spec.item.under !== undefined) parents.set(spec.item.id, spec.item.under)
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
      available, state.marker, on ? 1 : 0, options.focused ? 1 : 0, node.marker ?? '', state.check, state.number,
      spec.depth, spec.last ? 1 : 0, spec.expandable ? 1 : 0, spec.open ? 1 : 0,
      `${String(view?.active)}\0${String(view?.pinned)}`, options.flow === true ? 1 : 0,
    ].join('\x01')
    const leaded = item.bodyLead !== undefined && spec.open && item.body !== undefined
    const paintHead = (): readonly string[] => leaded ? leadedLines(state, colors, options.body) : headLines(state, colors, options.translate)
    // A row whose body carries a motion span is painted again at every clock frame: its remembered lines would freeze it.
    const moves = typeof item.body === 'object' && item.body.kind === 'rich-text' && hasMotion(item.body.spans)
    const painted = options.memo === undefined || moves ? paintHead() : options.memo.cache.readLines(colors, item, key, paintHead, options.memo.counters)
    // A `band` list marks its cursor row, the rows under it, and their bodies with the selected background, in place of an
    // arrow. The band keeps a column free at each edge of the list.
    const banded = node.marker === 'band' && options.focused && options.cursorId !== undefined && (on || within(item, options.cursorId, parents))
    const shade = (rows: readonly string[]): readonly string[] => banded
      ? mapRows(rows, line => ` ${colors.selectedBg(sliceByColumn(padTo(line, available), 1, Math.max(0, available - 2), true))} `)
      : rows
    entries.push({ kind: 'item', id: item.id, lines: shade(painted) })
    if (!leaded && spec.open && item.body !== undefined) {
      const counters = options.memo?.counters
      const body = options.memo === undefined || moves
        ? bodyLines(spec, available, colors, options.body, counters)
        : options.memo.cache.readLines(colors, item, `body\x01${String(available)}\x01${options.flow === true ? 1 : 0}`, () => bodyLines(spec, available, colors, options.body, counters), counters)
      if (body.length > 0) entries.push({ kind: 'body', lines: shade(body) })
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
  // The entries stay parts: an open body may be a virtual array, and the concat reads only the rows the window asks for.
  let lines: string[] = concatRows(...shown.map(entry => entry.lines))
  if (lineCount > limit) {
    const focusAt = shown.findIndex(entry => entry.kind === 'item' && entry.id === options.cursorId)
    const first = focusAt < 0 ? 0 : starts[focusAt]!
    const rows = focusAt < 0 ? 1 : shown[focusAt]!.lines.length
    let begin = focusAt < 0 ? 0 : Math.min(Math.max(0, first - Math.floor(limit / 2) + Math.floor(rows / 2)), lineCount - limit)
    if (focusAt >= 0) begin = Math.max(Math.min(begin, first), first + rows - limit)
    lines = sliceRows(lines, begin, begin + limit)
  }
  const tail: string[] = []
  if (more > 0) {
    const text = options.translate?.('↑ {above} more · ↓ {below} more', { above: hiddenAbove, below: hiddenBelow }) ?? `↑ ${String(hiddenAbove)} more · ↓ ${String(hiddenBelow)} more`
    tail.push(`   ${colors.muted(text)}`)
  }
  if (needsFooter) {
    tail.push('', footerFor === undefined ? '' : segmentFooter(footerFor, available, colors, footerFor.segment.label ?? options.segmentLabel ?? 'Options'))
  }
  return tail.length === 0 ? lines : concatRows(lines, tail)
}
