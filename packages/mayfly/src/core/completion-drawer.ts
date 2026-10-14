/**
 * The completion palette: the editor's `/`, `@`, and `#` list drawn as plain rows over the stream, on the rows directly
 * above the editor's frame and as wide as the frame. It is an overlay, so neither the editor nor the conversation
 * reflows when it opens, and it covers whatever sits on those rows (the stream's tail, the hint above the frame). It has
 * no border, count, or key line: the focused row is marked with an arrow and the names line up with the buffer's text.
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

const strong = (text: string): string => `\x1b[1m${text}\x1b[22m`

/** What the painter reads: the list as facts, the width, and the palette. */
export interface DrawerPaint {
  readonly view: MayflyCompletionView
  /** The palette's width: the editor frame's. */
  readonly width: number
  readonly colors: MayflySemanticColors
  readonly components: Measure
  readonly glyphs: MayflyGlyphMode | undefined
}

/** The first row of the window: the focused row stays inside it, centered when the list is longer. */
function windowStart(count: number, index: number, rows: number): number {
  return Math.max(0, Math.min(index - Math.floor(rows / 2), count - rows))
}

/** One row: the arrow and the name, then the description in the muted tone, padded to the full width. */
function itemRow(paint: DrawerPaint, index: number, nameColumn: number): string {
  const { view, width, colors, components: c } = paint
  const item = view.items[index]!
  const focused = index === view.index
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
  const text = detail === '' || left >= width - 1 ? '' : c.truncateToWidth(detail, width - left - 1, '…')
  const row = c.truncateToWidth(`${lead}${text === '' ? '' : focused ? colors.text(text) : colors.muted(text)}`, width, '')
  return `${row}${' '.repeat(Math.max(0, width - c.visibleWidth(row)))}`
}

/**
 * The rows of the palette at `paint.width`: up to {@link DRAWER_ROWS} items, each padded to the full width so the stream
 * under them is covered. The last row sits directly above the editor's frame.
 * @param paint - the list, the width, and the palette.
 * @returns the rows.
 */
export function paintDrawer(paint: DrawerPaint): string[] {
  const { view, components: c } = paint
  const shown = Math.min(DRAWER_ROWS, view.items.length)
  const start = windowStart(view.items.length, view.index, shown)
  const widest = Math.max(1, ...view.items.slice(start, start + shown).map(item => c.visibleWidth(item.label)))
  // A narrow terminal gives the name column what the row can spare before the description.
  const nameColumn = Math.max(1, Math.min(MAX_NAME_COLUMN, widest, paint.width - NAME_COLUMN - 2))
  const rows: string[] = []
  for (let index = start; index < start + shown; index += 1) rows.push(itemRow(paint, index, nameColumn))
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
    return Math.min(DRAWER_ROWS, this.source.view()?.items.length ?? 0)
  }

  /** Whether the palette shows: a list with at least one item is open. */
  get open(): boolean {
    return this.rows > 0
  }

  render(width: number): string[] {
    const view = this.source.view()
    if (view === undefined || view.items.length === 0) return []
    return paintDrawer({ view, width: Math.max(1, width), colors: this.source.colors, components: this.source.components, glyphs: this.source.glyphs })
  }

  invalidate(): void {}
}
