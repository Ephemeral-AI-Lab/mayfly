/**
 * The stacks compiled surfaces are built from, and where each child sits in them. They produce the rows pi-tui's stacks
 * produce and add two things a frame needs. A horizontal stack pays for a row only when the row changes: pi-tui renders
 * every child at the full width to learn a width it then ignores for a child with a fixed basis, and composites every
 * row through a general column splice, and a layout measures a stack by rendering it, so the stack that pads a pane
 * composited every row of a long scroll on each frame that changed one of them. Every stack also remembers the row its
 * children start at, so a moving cell can be placed against the window of the scroll view that holds it and the clock
 * armed only while the cell is on screen.
 *
 * @module @ephemeral-ai/mayfly/core/ui-stacks
 */

import { HStack, ScrollView, VStack, compositeTuiLine, type Component } from '@earendil-works/pi-tui'
import { allocateStackSizes, visibleStackEntries } from '@earendil-works/pi-tui/dist/components/stack.js'
import { blankRows, concatRows, declaredWidthOf, isVirtualRows, rowSourceOf, sliceRows, virtualRows } from './ui-rows.ts'
import { visibleWidth } from './width.ts'

/** A leaf that can fill the height a row settles on, used by a vertical divider between columns. */
export interface FillHeightComponent {
  renderHeight?: (height: number, width: number) => string[]
}

/** How many composited rows one stack remembers before its next render starts over. */
export const ROW_STACK_ENTRIES = 4096

/** Where a component sits in the container that last rendered it: the container, and the first of its rows there. */
const placements = new WeakMap<Component, { readonly parent: Component, readonly top: number }>()

/**
 * Records that `child` starts at row `top` of `parent`'s rows.
 * @param child - the contained component.
 * @param parent - the stack, scroll view, or frame that holds it.
 * @param top - the child's first row among the parent's rows.
 */
export function placeChild(child: Component, parent: Component, top: number): void {
  const known = placements.get(child)
  if (known?.parent !== parent || known.top !== top) placements.set(child, { parent, top })
}

/**
 * Whether any row of a component can be on screen: false only when a scroll view around it is known to show other rows.
 * A component whose containers are not all known (its first frame, a container that keeps no placements) counts as on
 * screen, so a moving cell is never frozen by a guess.
 * @param component - the component, placed by the stacks that rendered it.
 * @param rows - how many rows it painted.
 * @returns whether the component may be visible.
 */
export function onScreen(component: Component, rows: number): boolean {
  let top = 0
  for (let at = placements.get(component), hops = 0; at !== undefined && hops < 64; at = placements.get(at.parent), hops += 1) {
    top += at.top
    if (!(at.parent instanceof ScrollView)) continue
    // A view that has not been laid out yet has no window to be outside of.
    if (at.parent.viewportHeight === 0) return true
    if (top + rows <= at.parent.scrollTop || top >= at.parent.scrollTop + at.parent.viewportHeight) return false
    top -= at.parent.scrollTop
  }
  return true
}

/** A vertical stack that remembers the row each child starts at. Its rows are pi-tui's `VStack` rows. */
export class ColumnStack extends VStack {
  override render(width: number): string[] {
    const safeWidth = Math.max(1, width)
    const entries = visibleStackEntries(this.entries, { width: safeWidth, height: Number.MAX_SAFE_INTEGER })
    const rendered = entries.map(entry => entry.component.render(safeWidth))
    const sizes = allocateStackSizes(entries, rendered.map(lines => lines.length), undefined, this.gap)
    if (rendered.some(lines => isVirtualRows(lines))) {
      // A windowed child stays a window: the stack's rows are a lazy concat of the children's facades, so reading a
      // row paints only the part it lands in.
      const parts: string[][] = []
      let top = 0
      for (const [index, entry] of entries.entries()) {
        if (index > 0) parts.push(blankRows(this.gap))
        placeChild(entry.component, this, top)
        const size = sizes[index]!
        const childLines = sliceRows(rendered[index]!, 0, size)
        parts.push(childLines)
        const padding = size - Math.min(size, rendered[index]!.length)
        if (padding > 0) parts.push(blankRows(padding))
        top += size + this.gap
      }
      return concatRows(...parts)
    }
    const lines: string[] = []
    for (const [index, entry] of entries.entries()) {
      if (index > 0) for (let gap = 0; gap < this.gap; gap += 1) lines.push('')
      placeChild(entry.component, this, lines.length)
      const size = sizes[index]!
      const childLines = rendered[index]!.slice(0, size)
      for (const line of childLines) lines.push(line)
      for (let padding = childLines.length; padding < size; padding += 1) lines.push('')
    }
    return lines
  }
}

/** A horizontal stack that skips the measure nobody reads and remembers each composited row by what went into it. */
export class RowStack extends HStack {
  /** The widest row of a child's rows, by the rows themselves: a retained child answers with the same array. */
  private readonly widest = new WeakMap<readonly string[], number>()
  /** Composited rows by the column they were spliced into, then by the row under them, then by the row spliced in. */
  private readonly composited = new Map<string, Map<string, Map<string, string>>>()
  private remembered = 0
  /** A pre-painted column rule placed in each gap, or undefined for none. */
  rule: string | undefined

  override render(width: number): string[] {
    const safeWidth = Math.max(1, width)
    const entries = visibleStackEntries(this.entries, { width: safeWidth, height: Number.MAX_SAFE_INTEGER })
    if (entries.length === 0) return []
    // A full memo starts over before a render, never in the middle of one.
    if (this.remembered >= ROW_STACK_ENTRIES) {
      this.composited.clear()
      this.remembered = 0
    }
    // Only a child sized by its content is rendered to be measured; a fixed basis is the size whatever the content.
    const intrinsic = entries.map(entry => typeof entry.basis === 'number' ? 0 : this.widestRow(entry.component.render(safeWidth)))
    const widths = allocateStackSizes(entries, intrinsic, safeWidth, this.gap)
    const measured = entries.map((entry, index) => widths[index] === 0 ? [] : entry.component.render(widths[index]!))
    const height = measured.reduce((max, lines) => Math.max(max, lines.length), 0)
    const rendered = measured.map((lines, index) => {
      const fill = (entries[index]!.component as FillHeightComponent).renderHeight
      return fill === undefined || widths[index] === 0 ? lines : fill(height, widths[index]!)
    })
    const columns: number[] = []
    {
      let column = 0
      for (const childWidth of widths) { columns.push(column); column += childWidth + this.gap }
    }
    const offsets = rendered.map(lines => this.align === 'center' ? Math.floor((height - lines.length) / 2) : this.align === 'end' ? height - lines.length : 0)
    for (const [index, entry] of entries.entries()) placeChild(entry.component, this, offsets[index]!)
    if (rendered.some(lines => isVirtualRows(lines))) {
      // A windowed child stays a window: one result row splices the row each child contributes at its offset, painted
      // on first read through the same remembered composite. The layout is this render's; a child whose row map
      // moves still moves the rows read from it.
      const moving = rendered.map(lines => rowSourceOf(lines)).filter(source => source?.revision !== undefined)
      return virtualRows({
        length: height,
        get revision() { return moving.length === 0 ? undefined : moving.reduce((total, source) => total + source!.revision!, 0) },
        markerFree: rendered.every(lines => rowSourceOf(lines)?.markerFree === true),
        row: row => {
          let base = ''
          for (const [index, lines] of rendered.entries()) {
            const source = row - offsets[index]!
            if (source < 0 || source >= lines.length) continue
            base = this.splice(this.splices(`${String(columns[index])}|${String(widths[index])}|${String(safeWidth)}`), base, lines[source]!, columns[index]!, widths[index]!, safeWidth)
          }
          return this.rule === undefined ? base : this.applyRule(base, columns, safeWidth)
        },
      })
    }
    const result = Array.from({ length: height }, () => '')
    for (const [index, lines] of rendered.entries()) {
      const childWidth = widths[index]!
      const offset = offsets[index]!
      const splices = this.splices(`${String(columns[index])}|${String(childWidth)}|${String(safeWidth)}`)
      for (const [row, line] of lines.entries()) result[row + offset] = this.splice(splices, result[row + offset]!, line, columns[index]!, childWidth, safeWidth)
    }
    return this.rule === undefined ? result : result.map(row => this.applyRule(row, columns, safeWidth))
  }

  /** Place the column rule in each gap between visible children, on one composited row. */
  private applyRule(row: string, columns: readonly number[], width: number): string {
    if (this.rule === undefined || this.gap === 0) return row
    let painted = row
    for (const column of columns.slice(1)) {
      if (column <= 0) continue
      painted = compositeTuiLine(painted, this.rule, column - Math.ceil(this.gap / 2), 1, width)
    }
    return painted
  }

  private widestRow(lines: readonly string[]): number {
    const declared = declaredWidthOf(lines)
    if (declared !== undefined) return declared
    let width = this.widest.get(lines)
    if (width === undefined) {
      width = lines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0)
      this.widest.set(lines, width)
    }
    return width
  }

  /** The rows remembered for one column: where it starts, how wide it is, and how wide the whole row is. */
  private splices(geometry: string): Map<string, Map<string, string>> {
    let splices = this.composited.get(geometry)
    if (splices === undefined) {
      splices = new Map()
      this.composited.set(geometry, splices)
    }
    return splices
  }

  /** One row of a child spliced over what the children before it left there. The splice is a pure function of its inputs. */
  private splice(splices: Map<string, Map<string, string>>, base: string, line: string, column: number, childWidth: number, totalWidth: number): string {
    let over = splices.get(base)
    if (over === undefined) {
      over = new Map()
      splices.set(base, over)
    }
    let row = over.get(line)
    if (row === undefined) {
      row = compositeTuiLine(base, line, column, childWidth, totalWidth)
      over.set(line, row)
      this.remembered += 1
    }
    return row
  }
}

/** The tallest a group of pages has been, by `width|viewport rows`; it lives as long as its owner (the surface, the views lane). */
export type PagePeaks = Map<string, number>

/**
 * The one height rule of every surface that switches pages in place (a tab strip, a wizard, a record rail, the views of
 * the status row): the page on show is padded with blank rows to the tallest page of its group at this width and
 * viewport (component-development-spec §1 rule 13), so switching pages never moves the rows around the surface. The
 * tallest is remembered per `key`, so a page that narrows (a filter, a list that empties) does not shrink the group; a
 * different viewport is a different key, so a shorter terminal lowers the hold.
 * @param rows - the page on show.
 * @param peaks - the group's remembered heights.
 * @param key - the width and the viewport rows, `${width}|${rows}`.
 * @param others - the tallest of the other pages now.
 */
export function holdHeight(rows: string[], peaks: PagePeaks, key: string, others: number): string[] {
  const peak = Math.max(peaks.get(key) ?? 0, rows.length, others)
  peaks.delete(key)
  peaks.set(key, peak)
  // A handful of sizes is remembered (a resize drags through many); the oldest go first.
  while (peaks.size > 6) peaks.delete(peaks.keys().next().value!)
  return rows.length >= peak ? rows : concatRows(rows, blankRows(peak - rows.length))
}

/** The pages of one tab strip in one compile, and the height each is known to have at the width last measured. */
export class PageGroup {
  readonly pages: PageHold[] = []
  private measuredAt = ''
  private readonly heights = new Map<PageHold, number>()

  constructor(readonly peaks: PagePeaks, readonly measure: <Result>(paint: () => Result) => Result) {}

  /** The height of every other page at `key`, measured once per key: a hidden page costs nothing again until the width or the viewport changes. */
  others(except: PageHold, width: number, key: string): number {
    if (key !== this.measuredAt) { this.measuredAt = key; this.heights.clear() }
    let tallest = 0
    for (const page of this.pages) {
      if (page === except) continue
      let rows = this.heights.get(page)
      if (rows === undefined) { rows = this.measure(() => page.inner.render(width)).length; this.heights.set(page, rows) }
      tallest = Math.max(tallest, rows)
    }
    return tallest
  }

  /** The page on show painted `rows`: that is its height now. */
  shown(page: PageHold, rows: number, key: string): void {
    if (key === this.measuredAt) this.heights.set(page, rows)
  }
}

/**
 * One page of a tab strip. A panel with several pages keeps one height ({@link holdHeight}): the page on show is padded
 * with blank rows to the tallest page at this width and viewport, so switching pages (or a list that narrows to a few
 * matches) never moves the rows under the panel. The other pages are measured with the clock and the focus bindings of the visible page left alone.
 */
export class PageHold implements Component {
  constructor(readonly inner: Component, private readonly group: PageGroup, private readonly viewport: () => string) {
    group.pages.push(this)
  }

  render(width: number): string[] {
    const rows = this.inner.render(width)
    const key = `${String(width)}|${this.viewport()}`
    const others = this.group.others(this, width, key)
    this.group.shown(this, rows.length, key)
    return holdHeight(rows, this.group.peaks, key, others)
  }

  invalidate(): void { this.inner.invalidate?.() }
}
