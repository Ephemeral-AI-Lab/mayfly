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
import { truncateToWidth, visibleWidth } from './width.ts'

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
    const rendered = entries.map((entry, index) => widths[index] === 0 ? [] : entry.component.render(widths[index]!))
    const height = rendered.reduce((max, lines) => Math.max(max, lines.length), 0)
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
          return base
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
    return result
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

/** What a cell row asks of its host. */
interface CellRowOptions {
  /** The cells the row is divided into; more children than cells share the row evenly. */
  readonly cells: number
  readonly gap: number
  /** The children visible at this paint, in order. */
  readonly children: () => readonly Component[]
}

/**
 * A row divided into equal cells: each child is painted at the width of one cell, as its first row, and padded to the
 * cell. The cell is a share of the width however many children there are, so an item stays where it is when another
 * appears or goes. A child that does not fit is the child's to cut.
 */
export class CellRow implements Component {
  constructor(private readonly options: CellRowOptions) {}

  render(width: number): string[] {
    const columns = Math.max(1, Math.floor(width))
    const children = this.options.children()
    if (children.length === 0) return []
    const count = Math.max(this.options.cells, children.length)
    const gap = this.options.gap
    const cell = Math.max(1, Math.floor((columns - gap * (count - 1)) / count))
    const line = children.map((child, index) => {
      const row = child.render(cell)[0] ?? ''
      const clipped = visibleWidth(row) > cell ? truncateToWidth(row, cell, '') : row
      return `${clipped}\x1b[0m${' '.repeat(Math.max(0, cell - visibleWidth(clipped)))}${index === children.length - 1 ? '' : ' '.repeat(gap)}`
    }).join('')
    return [truncateToWidth(line.replace(/ +$/u, ''), columns, '')]
  }

  invalidate(): void {}
}
