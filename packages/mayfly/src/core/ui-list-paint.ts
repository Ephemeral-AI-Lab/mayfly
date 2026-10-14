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
import { segmentLine, type SegmentView } from './ui-list-segment.ts'
import type { UiRowCache } from './ui-row-cache.ts'
import { countWork, type MayflyWorkCounters } from './ui-work-counters.ts'
import { concatRows, mapRows, sliceRows, virtualRows } from './ui-rows.ts'
import { countMatches, highlightLine, highlightPattern } from './ui-find.ts'
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

/** A `body` or `item` entry carries its rows as the painters made them: the band and the search marks are laid over them last. */
interface RowFlags {
  /** The cursor row's block takes the band. */
  readonly banded: boolean
  /** The row belongs to the cursor's block, whose current match is drawn stronger. */
  readonly block: boolean
}

type Entry =
  | { readonly kind: 'group' | 'rule' | 'gap', readonly lines: readonly string[] }
  | ({ readonly kind: 'body', readonly lines: readonly string[] } & RowFlags)
  | ({ readonly kind: 'item', readonly id: string, readonly lines: readonly string[] } & RowFlags)

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

type ListNodeView = Pick<MayflyListNode, 'items' | 'marker' | 'marks' | 'mode' | 'tree' | 'numbered' | 'maxRows' | 'highlight'>

/** A one-row meter: `▰` filled in the tone, `▱` empty and muted. */
function meterText(meter: NonNullable<MayflyListItem['meter']>, colors: MayflySemanticColors): string {
  const width = meter.width ?? DEFAULT_METER_WIDTH
  const filled = Math.round((meter.value / meter.max) * width)
  return `${paintTone(meter.tone ?? 'primary', '▰'.repeat(filled), colors)}${colors.muted('▱'.repeat(width - filled))}`
}

/** The text after the label: the live mark, badge, and meter. The description follows in its own column. */
function labelTail(item: MayflyListItem, colors: MayflySemanticColors): string {
  const current = item.current === true ? ` ${colors.primary('✓')}` : ''
  const badge = item.badge === undefined ? '' : ` ${colors.muted(`[${item.badge}]`)}`
  const meter = item.meter === undefined ? '' : ` ${meterText(item.meter, colors)}`
  return `${current}${badge}${meter}`
}

/** The row's description, muted: the item's `detail` (or `detailSpans`) and the reason a row is disabled; empty when it has none. */
function descriptionOf(item: MayflyListItem, colors: MayflySemanticColors): string {
  const detail = item.detailSpans !== undefined
    ? item.detailSpans.length === 0 ? '' : spansText(item.detailSpans, colors)
    : item.detail === undefined ? '' : colors.muted(item.detail.startsWith('—') ? item.detail.slice(1).trimStart() : item.detail)
  const reason = item.disabled === true && item.disabledReason !== undefined ? colors.muted(`— ${item.disabledReason}`) : ''
  return [detail, reason].filter(part => part.length > 0).join(' ')
}

/** The columns between a row's label and its description. */
const COLUMN_GAP = 2
/** The widest share of the row the label column may take, so a long name never pushes its description off the row. */
const COLUMN_SHARE = 0.6
const labelColumns = new WeakMap<readonly MayflyListItem[], number>()

/** The visible width of a row's label with its live mark, badge, and meter: what the description column lines up behind. */
function labelWidth(item: MayflyListItem): number {
  const label = item.labelSpans !== undefined ? item.labelSpans.reduce((sum, span) => sum + visibleWidth(span.text), 0) : visibleWidth(item.label)
  const current = item.current === true ? 2 : 0
  const badge = item.badge === undefined ? 0 : visibleWidth(item.badge) + 3
  const meter = item.meter === undefined ? 0 : (item.meter.width ?? DEFAULT_METER_WIDTH) + 1
  return label + current + badge + meter
}

const segmentLists = new WeakMap<readonly MayflyListItem[], { readonly label: string | undefined } | null>()

/** The segment a list carries (the caption its first segment names itself with), or `null` when no row has one; kept for the list's items. */
function segmentOf(items: readonly MayflyListItem[]): { readonly label: string | undefined } | null {
  let found = segmentLists.get(items)
  if (found === undefined) {
    const first = items.find(item => item.segment !== undefined)
    found = first === undefined ? null : { label: first.segment!.label }
    segmentLists.set(items, found)
  }
  return found
}

/** The widest label of a list, kept for the list's items: the column stays put while a filter narrows the rows. */
function labelColumn(items: readonly MayflyListItem[]): number {
  let width = labelColumns.get(items)
  if (width === undefined) {
    width = 0
    for (const item of items) if (item.gap !== true && item.rule === undefined && item.wrap !== true) width = Math.max(width, labelWidth(item))
    labelColumns.set(items, width)
  }
  return width
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
  /** The columns the label (with its mark) takes before the description column starts; 0 when the row has no column. */
  readonly column: number
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
  const number = state.number === '' ? '' : `${colors.muted(`${state.number}.`)} `
  const check = state.check === '' ? '' : `${state.check === '○' || disabled ? colors.muted(state.check) : colors.primary(state.check)} `
  return `${gutter}${indent}${guides}${disclosure}${number}${check}`
}

function labelOf(state: RowState, colors: MayflySemanticColors): string {
  const item = state.spec.item
  if (item.labelSpans !== undefined) return spansText(item.labelSpans, colors)
  if (item.disabled === true) return colors.muted(item.label)
  // One rule for every picker: the cursor row is bold white, the live row takes the theme color (bold when the cursor is on it).
  const painted = item.current === true ? colors.primary(item.label) : state.on ? colors.textStrong(item.label) : colors.text(item.label)
  return state.on ? strong(painted) : painted
}

/** The row's head as one painted line, before wrapping, the strip, and the right spans. */
function headOf(state: RowState, colors: MayflySemanticColors): { readonly prefix: string, readonly line: string } {
  const prefix = prefixOf(state, colors)
  const item = state.spec.item
  const head = `${prefix}${labelOf(state, colors)}${labelTail(item, colors)}`
  const description = state.width <= DETAIL_MIN_WIDTH ? '' : descriptionOf(item, colors)
  if (description.length === 0) return { prefix, line: head }
  // The description starts in a column behind the widest label; a wrapped row keeps it one space after its label.
  const lead = state.column === 0 ? 1 : Math.max(COLUMN_GAP, visibleWidth(prefix) + state.column + COLUMN_GAP - visibleWidth(head))
  return { prefix, line: `${head}${' '.repeat(lead)}${description}` }
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

/** Where the current match of a search stands: which entry, which of its rows, and which match of that row. */
interface CurrentMatch {
  readonly entry: number
  readonly line: number
  readonly within: number
}

/**
 * The `nth` match (counted through the rows of the cursor's block, head first) of a search, or the last one when the block
 * holds fewer.
 */
function currentMatch(entries: readonly Entry[], find: RegExp, nth: number | undefined): CurrentMatch | undefined {
  if (nth === undefined) return undefined
  const counts: { readonly entry: number, readonly line: number, readonly count: number }[] = []
  let total = 0
  entries.forEach((entry, index) => {
    if ((entry.kind !== 'item' && entry.kind !== 'body') || !entry.block) return
    for (let line = 0; line < entry.lines.length; line += 1) {
      const count = countMatches(entry.lines[line]!, find)
      if (count === 0) continue
      counts.push({ entry: index, line, count })
      total += count
    }
  })
  if (total === 0) return undefined
  let remaining = Math.min(Math.max(0, nth), total - 1)
  for (const found of counts) {
    if (remaining < found.count) return { entry: found.entry, line: found.line, within: remaining }
    remaining -= found.count
  }
  return undefined
}

/**
 * The lines of a list, windowed to `height`. `node` carries the list's presentation fields; `options.rows` are the
 * materialized visible rows in order. The painted rows come from the memo when an item's state bits are unchanged.
 */
export function paintList(node: ListNodeView, width: number, height: number, colors: MayflySemanticColors, options: ListPaintOptions): string[] {
  // The wrapper hands over a finite width; the floor of one column keeps every ladder total.
  const available = Math.max(1, Math.floor(width))
  const numbered = node.numbered !== undefined && node.numbered !== false
  const digits = String(options.total ?? options.rows.length).length
  const prefixGuess = 2 + (numbered ? digits + 2 : 0)
  const column = Math.min(labelColumn(node.items), Math.max(8, Math.floor((available - prefixGuess) * COLUMN_SHARE)))
  const entries: Entry[] = []
  let group: string | undefined
  let footerFor: SegmentView | undefined
  if (options.lead !== undefined) entries.push({ kind: 'group', lines: [options.lead] })
  // The line is reserved while any row of the list carries a segment, so focus never moves a row.
  const segmentInfo = segmentOf(node.items)
  const needsFooter = segmentInfo !== null
  let focusedWithout = false
  // Which item each row sits under, so a band can follow the chain from a body to its call to the head.
  const find = highlightPattern(node.highlight)
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
      number: numbered ? String(spec.position + 1).padStart(digits) : '',
      column,
      view,
    }
    // The line under the rows names the focused row's level; a row without a segment leaves it blank.
    if (on && options.focused) { if (view === undefined) focusedWithout = true; else footerFor = view }
    if (item.gap === true || item.rule !== undefined) {
      entries.push({ kind: item.gap === true ? 'gap' : 'rule', lines: headLines(state, colors, options.translate) })
      continue
    }
    const key = [
      available, column, state.marker, on ? 1 : 0, options.focused ? 1 : 0, node.marker ?? '', state.check, state.number,
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
    const block = options.cursorId !== undefined && (on || within(item, options.cursorId, parents))
    entries.push({ kind: 'item', id: item.id, lines: painted, banded, block })
    if (!leaded && spec.open && item.body !== undefined) {
      const counters = options.memo?.counters
      const body = options.memo === undefined || moves
        ? bodyLines(spec, available, colors, options.body, counters)
        : options.memo.cache.readLines(colors, item, `body\x01${String(available)}\x01${options.flow === true ? 1 : 0}\x01${node.highlight?.current === undefined ? 0 : 1}`, () => bodyLines(spec, available, colors, options.body, counters), counters)
      if (body.length > 0) entries.push({ kind: 'body', lines: body, banded, block })
    }
  }

  // The search marks go on last, with the current match (inside the cursor's block) drawn stronger; then the band.
  const current = find === undefined ? undefined : currentMatch(entries, find, node.highlight?.current)
  const laid = entries.map((entry, index): Entry => {
    if (entry.kind !== 'item' && entry.kind !== 'body') return entry
    const at = current?.entry === index ? current : undefined
    const marked = find === undefined ? entry.lines : mapRows(entry.lines, (line, row) => highlightLine(line, find, at?.line === row ? at.within : undefined))
    const lines = entry.banded ? mapRows(marked, line => ` ${colors.selectedBg(sliceByColumn(padTo(line, available), 1, Math.max(0, available - 2), true))} `) : marked
    return { ...entry, lines }
  })

  // maxRows windows over entries (a group heading and an open body each count as one), with the rest counted as hidden.
  let shown: readonly Entry[] = laid
  let hiddenAbove = 0
  let hiddenBelow = 0
  const total = options.total ?? options.rows.length
  if (node.maxRows !== undefined && total > node.maxRows) {
    const at = Math.max(0, laid.findIndex(entry => entry.kind === 'item' && entry.id === options.cursorId))
    const start = Math.max(0, Math.min(laid.length - node.maxRows, at - Math.floor(node.maxRows / 2)))
    shown = laid.slice(start, start + node.maxRows)
    hiddenAbove = (options.before ?? 0) + start
    hiddenBelow = (options.after ?? 0) + laid.length - start - shown.length
  }

  // The prefix sums of the shown entries' line counts place the cursor row, whatever height each row has.
  const footer = needsFooter ? 2 : 0
  const baseHidden = hiddenAbove + hiddenBelow
  const starts: number[] = []
  let lineCount = 0
  for (const entry of shown) { starts.push(lineCount); lineCount += entry.lines.length }
  const room = Math.max(1, (Number.isFinite(height) ? Math.floor(height) : 1) - footer)
  // A window cut by height hides rows too: the overflow row is reserved before the rows are cut.
  const windowed = lineCount > room - (baseHidden > 0 ? 1 : 0)
  const limit = Math.max(1, room - (baseHidden > 0 || windowed ? 1 : 0))
  // The entries stay parts: an open body may be a virtual array, and the concat reads only the rows the window asks for.
  let lines: string[] = concatRows(...shown.map(entry => entry.lines))
  let begin = 0
  if (lineCount > limit) {
    const focusAt = shown.findIndex(entry => entry.kind === 'item' && entry.id === options.cursorId)
    const first = focusAt < 0 ? 0 : starts[focusAt]!
    const rows = focusAt < 0 ? 1 : shown[focusAt]!.lines.length
    begin = focusAt < 0 ? 0 : Math.min(Math.max(0, first - Math.floor(limit / 2) + Math.floor(rows / 2)), lineCount - limit)
    if (focusAt >= 0) begin = Math.max(Math.min(begin, first), first + rows - limit)
    // A search match inside a block taller than the window decides where the window sits: the match is centered.
    const target = current === undefined ? -1 : shown.indexOf(laid[current.entry]!)
    if (target >= 0) begin = Math.max(0, Math.min(starts[target]! + current!.line - Math.floor(limit / 2), lineCount - limit))
    lines = sliceRows(lines, begin, begin + limit)
    hiddenAbove += begin
    hiddenBelow += lineCount - begin - limit
  }
  // Rows past either edge are marked in the gutter of the edge row (`↑`, `↓`) and counted in a muted row under the list.
  const marked = hiddenAbove + hiddenBelow > 0
  if (marked) {
    const last = Math.min(lineCount, limit) - 1
    lines = mapRows(lines, (line, index) => {
      const glyph = index === 0 && hiddenAbove > 0 ? '↑' : index === last && hiddenBelow > 0 ? '↓' : undefined
      return glyph === undefined || !line.startsWith(' ') ? line : `${colors.muted(glyph)}${line.slice(1)}`
    })
  }
  const tail: string[] = []
  if (marked) {
    const count = hiddenAbove + hiddenBelow
    const text = options.translate?.('… +{count} more', { count }) ?? `… +${String(count)} more`
    tail.push(`   ${colors.muted(text)}`)
  }
  if (needsFooter) {
    // A focused row without a segment says so on the same line, so the line is never an unexplained gap.
    const absent = (): string => {
      const label = segmentInfo.label ?? options.segmentLabel ?? 'Options'
      const reason = options.translate?.('no choice') ?? 'no choice'
      return `  ${colors.muted(`○ ${label}: ${reason}`)}`
    }
    tail.push('', footerFor !== undefined ? segmentLine(footerFor, available, colors, footerFor.segment.label ?? options.segmentLabel ?? 'Options') : focusedWithout ? clipRow(absent(), available) : '')
  }
  return tail.length === 0 ? lines : concatRows(lines, tail)
}
