/**
 * The completion palette: the editor's `/`, `@`, and `#` list drawn as plain rows over the stream, on the rows directly
 * above the editor's frame and as wide as the frame. It is an overlay, so neither the editor nor the conversation
 * reflows when it opens, and it covers whatever sits on those rows (the stream's tail, the hint above the frame). It has
 * no border, count, or key line: the focused row is marked with an arrow and the names line up with the buffer's text.
 * A row with a problem (an extension's own mark, or a source that failed) ends with a red `!` and, focused, one more line below it says why; while a
 * wait is pending the palette's last line says what it waits for. Those lines take their place out of the six rows.
 *
 * @module @ephemeral-ai/mayfly/core/completion-drawer
 */
import { glyphRows, type MayflyGlyphMode } from './glyphs.ts'
import type { MayflyCompletionView, MayflyComponent, MayflyComponents, MayflySemanticColors } from './types.ts'

type Measure = Pick<MayflyComponents, 'visibleWidth' | 'truncateToWidth'>

/** The most rows the list shows; the rest scroll behind the focused one. */
export const DRAWER_ROWS = 6

/** The widest name column: a longer name is cut with `…`. */
const MAX_NAME_COLUMN = 24

/** The cells before the arrow, in line with the prompt symbol of the frame (`│ > `). */
const ARROW_COLUMN = 2

/** The cells before a name: the arrow column, the arrow, and its space, so names start where the buffer's text does. */
const NAME_COLUMN = 4

/** The widest source tag; a longer extension id is cut with `…`. */
const MAX_SOURCE_COLUMN = 16

/** The least room the description keeps before a right-edge tag or cue may take the end of the row. */
const MIN_DETAIL_COLUMNS = 8

/** The least room a path keeps before the cue may take the end of its row. */
const MIN_PATH_COLUMNS = 24

/** The cue on the focused file row of an `@` list. */
const OPEN_CUE = '↗ Ctrl+G'

const strong = (text: string): string => `\x1b[1m${text}\x1b[22m`

/** What the painter reads: the list as facts, the width, and the palette. */
export interface DrawerPaint {
  readonly view: MayflyCompletionView
  /** The palette's width: the editor frame's. */
  readonly width: number
  readonly colors: MayflySemanticColors
  readonly components: Measure
  readonly glyphs: MayflyGlyphMode | undefined
  /** What the prompt waits for now (`Waiting for wiki…`), or `undefined`. */
  readonly wait: string | undefined
}

/** The first row of the window: the focused row stays inside it, centered when the list is longer. */
function windowStart(count: number, index: number, rows: number): number {
  return Math.max(0, Math.min(index - Math.floor(rows / 2), count - rows))
}

/** The last `columns` cells of a plain string, whole characters only. */
function tailByWidth(c: Measure, text: string, columns: number): string {
  let tail = ''
  for (const char of Array.from(text).reverse()) {
    if (c.visibleWidth(char + tail) > columns) break
    tail = char + tail
  }
  return tail
}

/** A path cut at the left, so the end that names the place stays: `…/mayfly/src/core/ui-prompt.ts`. */
function cutPathStart(c: Measure, path: string, columns: number): string {
  if (c.visibleWidth(path) <= columns) return path
  if (columns < 2) return c.truncateToWidth(path, columns, '…')
  return `…${tailByWidth(c, path, columns - 1)}`
}

/** What a row holds at its right edge: an extension row's source tag, or the focused file row's open cue. */
function rightEdge(paint: DrawerPaint, index: number): string {
  const { view, colors, components: c } = paint
  const item = view.items[index]!
  if (item.source !== undefined) return colors.muted(c.truncateToWidth(item.source, MAX_SOURCE_COLUMN, '…'))
  if (view.kind === 'files' && index === view.index && item.problem === undefined && !item.label.endsWith('/')) return colors.muted(OPEN_CUE)
  return ''
}

/** A file row: the whole path, cut at the left when it is wider than the row, and the open cue on the focused file. */
function fileRow(paint: DrawerPaint, index: number): string {
  const { view, width, colors, components: c } = paint
  const item = view.items[index]!
  const focused = index === view.index
  const edge = rightEdge(paint, index)
  const edgeWidth = c.visibleWidth(edge)
  const cue = edge !== '' && width - NAME_COLUMN - edgeWidth - 3 >= Math.min(MIN_PATH_COLUMNS, c.visibleWidth(item.label))
  const path = cutPathStart(c, item.label, Math.max(1, width - NAME_COLUMN - 1 - (cue ? edgeWidth + 2 : 0)))
  const text = focused ? strong(colors.primary(path)) : colors.text(path)
  const body = `${' '.repeat(ARROW_COLUMN)}${focused ? colors.primary('→') : ' '} ${text}`
  const gap = cue ? ' '.repeat(Math.max(2, width - 1 - c.visibleWidth(body) - edgeWidth)) : ''
  const row = c.truncateToWidth(`${body}${gap}${cue ? edge : ''}`, width, '')
  return `${row}${' '.repeat(Math.max(0, width - c.visibleWidth(row)))}`
}

/** One row: the arrow and the name, then the description in the muted tone, padded to the full width. */
function itemRow(paint: DrawerPaint, index: number, nameColumn: number): string {
  const { view, width, colors, components: c } = paint
  const item = view.items[index]!
  const focused = index === view.index
  if (view.kind === 'files' && item.source === undefined && item.problem === undefined) return fileRow(paint, index)
  const name = c.truncateToWidth(item.label, Math.max(1, nameColumn), '…')
  const typed = view.prefix.length > 0 && name.toLowerCase().startsWith(view.prefix.toLowerCase()) ? view.prefix.length : 0
  const label = focused
    ? strong(colors.primary(name))
    : typed > 0 ? `${strong(colors.text(name.slice(0, typed)))}${colors.text(name.slice(typed))}` : colors.text(name)
  const arrow = focused ? colors.primary('→') : ' '
  const gap = ' '.repeat(Math.max(2, nameColumn + 2 - c.visibleWidth(name)))
  const lead = `${' '.repeat(ARROW_COLUMN)}${arrow} ${label}${gap}`
  const left = c.visibleWidth(lead)
  const detail = item.detail === undefined ? '' : item.detail.replace(/[\r\n]+/gu, ' ').trim()
  // The tag or cue takes the end of the row when the description keeps room; on a narrow row it is shed first.
  const edge = rightEdge(paint, index)
  const edgeWidth = c.visibleWidth(edge)
  const edgeFits = edge !== '' && width - left - edgeWidth - 2 - 1 >= Math.min(MIN_DETAIL_COLUMNS, c.visibleWidth(detail))
  const mark = item.problem === undefined ? '' : ` ${strong(colors.error('!'))}`
  const room = width - left - 1 - (edgeFits ? edgeWidth + 2 : 0) - (mark === '' ? 0 : 2)
  const fitted = detail === '' || room < 1 ? '' : c.truncateToWidth(detail, room, '…')
  const body = `${lead}${fitted === '' ? '' : focused ? colors.text(fitted) : colors.muted(fitted)}${mark}`
  const edgeGap = edgeFits ? ' '.repeat(Math.max(2, width - 1 - c.visibleWidth(body) - edgeWidth)) : ''
  const row = c.truncateToWidth(`${body}${edgeGap}${edgeFits ? edge : ''}`, width, '')
  return `${row}${' '.repeat(Math.max(0, width - c.visibleWidth(row)))}`
}

/** How the rows divide: the items in the window, whether the focused row's problem line shows, and the wait line. */
interface DrawerLayout {
  readonly start: number
  readonly shown: number
  readonly problem: boolean
  readonly wait: boolean
}

function layoutOf(view: MayflyCompletionView, wait: string | undefined): DrawerLayout {
  const problem = view.items[view.index]?.problem !== undefined
  const lines = (problem ? 1 : 0) + (wait === undefined ? 0 : 1)
  const shown = Math.max(1, Math.min(view.items.length, DRAWER_ROWS - lines))
  return { start: windowStart(view.items.length, view.index, shown), shown, problem, wait: wait !== undefined }
}

const rowCount = (layout: DrawerLayout): number => layout.shown + (layout.problem ? 1 : 0) + (layout.wait ? 1 : 0)

/** A line under the names: the problem's reason or the wait, lined up with the names. */
function noteRow(paint: DrawerPaint, text: string, paintText: (text: string) => string): string {
  const { width, components: c } = paint
  const body = c.truncateToWidth(text.replace(/[\r\n]+/gu, ' ').trim(), Math.max(1, width - NAME_COLUMN - 1), '…')
  const row = `${' '.repeat(NAME_COLUMN)}${paintText(body)}`
  return `${row}${' '.repeat(Math.max(0, width - c.visibleWidth(row)))}`
}

/**
 * The rows of the palette at `paint.width`: up to {@link DRAWER_ROWS} lines, each padded to the full width so the stream
 * under them is covered. The last row sits directly above the editor's frame.
 * @param paint - the list, the width, and the palette.
 * @returns the rows.
 */
export function paintDrawer(paint: DrawerPaint): string[] {
  const { view, components: c, colors } = paint
  const layout = layoutOf(view, paint.wait)
  const { start, shown } = layout
  const widest = Math.max(1, ...view.items.slice(start, start + shown).map(item => c.visibleWidth(item.label)))
  // A narrow terminal gives the name column what the row can spare before the description.
  const nameColumn = Math.max(1, Math.min(MAX_NAME_COLUMN, widest, paint.width - NAME_COLUMN - 2))
  const rows: string[] = []
  for (let index = start; index < start + shown; index += 1) {
    rows.push(itemRow(paint, index, nameColumn))
    const problem = view.items[index]?.problem
    if (index === view.index && problem !== undefined) rows.push(noteRow(paint, problem, colors.error))
  }
  if (paint.wait !== undefined) rows.push(noteRow(paint, paint.wait, colors.muted))
  return glyphRows(rows, paint.glyphs)
}

/** What the palette reads at each frame: the editor's list, the frame's width, and the palette. */
export interface CompletionDrawerSource {
  /** The open list, or `undefined` while none is. */
  readonly view: () => MayflyCompletionView | undefined
  /** The frame's width in columns. */
  readonly frameWidth: () => number
  readonly colors: MayflySemanticColors
  readonly components: Measure
  readonly glyphs: MayflyGlyphMode | undefined
  /** What the prompt waits for now, or `undefined`. */
  readonly wait: () => string | undefined
}

/** The overlay component: it paints the rows while the editor shows a list and nothing otherwise. */
export class CompletionDrawer implements MayflyComponent {
  constructor(private readonly source: CompletionDrawerSource) {}

  /** The palette's width: the frame's; the overlay's width option reads it. */
  get width(): number {
    return Math.max(1, this.source.frameWidth())
  }

  /** The rows the palette shows now; the overlay's offset reads it. */
  get rows(): number {
    const view = this.source.view()
    return view === undefined || view.items.length === 0 ? 0 : rowCount(layoutOf(view, this.source.wait()))
  }

  /** Whether the palette shows: a list with at least one item is open. */
  get open(): boolean {
    return this.rows > 0
  }

  render(width: number): string[] {
    const view = this.source.view()
    if (view === undefined || view.items.length === 0) return []
    return paintDrawer({ view, width: Math.max(1, width), colors: this.source.colors, components: this.source.components, glyphs: this.source.glyphs, wait: this.source.wait() })
  }

  invalidate(): void {}
}
