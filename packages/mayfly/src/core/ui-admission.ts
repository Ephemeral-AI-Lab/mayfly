/**
 * Priority admission for a `stack.row` whose children carry a `priority`: they are admitted in order while they fit,
 * the first that does not either takes the room that is left or drops out, and the admitted children sit in their
 * bands. It is the design's one rule for rows of unequal worth (the status rows, a toolbar), so a plugin entry and a
 * Mayfly entry are admitted the same way.
 *
 * @module @ephemeral-ai/mayfly/core/ui-admission
 */

import type { Component } from '@earendil-works/pi-tui'
import type { MayflyUiChild } from '@ephemeral-ai/mayfly-ui'
import type { MayflyComponents } from './types.ts'

/** The narrowest room a truncated child takes; a smaller remainder drops it. */
export const ADMISSION_MIN_TRUNCATED = 8

/** A child's natural width is measured at this width, or at the row's when that is wider. */
export const ADMISSION_PROBE_WIDTH = 120

/** The gap between admitted children when the row names none. */
export const ADMISSION_GAP = 2

/** What admission reads of one child. */
export interface AdmissionEntry {
  readonly priority?: number | undefined
  readonly overflow?: MayflyUiChild['overflow'] | undefined
  /** The width the child asks for when nothing constrains it. */
  readonly natural: number
}

/**
 * The widths of the children that are admitted into a row of `width` columns, by index. Children without a priority
 * always take their natural width; the rest follow in priority order (ties keep their position). A child that does not
 * fit either `truncate`s into the room that is left (at least eight columns, and the row is then full), drops out with
 * `hide` while later children may still fit, or, with no `overflow`, ends admission: it and every later child drop.
 */
export function admitWidths(entries: readonly AdmissionEntry[], width: number, gap: number): ReadonlyMap<number, number> {
  const admitted = new Map<number, number>()
  let used = 0
  const take = (index: number, room: number): void => {
    used += (admitted.size > 0 ? gap : 0) + room
    admitted.set(index, room)
  }
  entries.forEach((entry, index) => { if (entry.priority === undefined) take(index, entry.natural) })
  const order = entries
    .map((entry, index) => ({ entry, index }))
    .filter(candidate => candidate.entry.priority !== undefined)
    .toSorted((left, right) => left.entry.priority! - right.entry.priority! || left.index - right.index)
  let full = false
  for (const { entry, index } of order) {
    if (full) break
    const need = entry.natural + (admitted.size > 0 ? gap : 0)
    if (used + need <= width) take(index, entry.natural)
    else if (entry.overflow === 'truncate' && width - used - gap >= ADMISSION_MIN_TRUNCATED) {
      take(index, width - used - gap)
      full = true
    } else if (entry.overflow !== 'hide') full = true
  }
  return admitted
}

/** One child of an admission row. */
export interface AdmissionChild extends AdmissionEntry {
  readonly component: Component
  readonly band: 'left' | 'center' | 'right'
}

const ANSI = /\x1b\[[0-9;]*m/gu

/** The width of a painted row without its trailing blank cells. */
function contentWidth(row: string, components: Pick<MayflyComponents, 'visibleWidth'>): number {
  return components.visibleWidth(row.replace(ANSI, '').trimEnd())
}

/**
 * Lays the admitted children out in their bands as one row: a left cluster, a centered cluster that gives way to its
 * neighbours, and a right cluster at the edge. Without a right cluster the row ends at its last cell.
 */
export function layoutBands(bands: { readonly left: string, readonly center: string, readonly right: string }, width: number, gap: number, components: Pick<MayflyComponents, 'visibleWidth'>): string {
  const left = components.visibleWidth(bands.left)
  const center = components.visibleWidth(bands.center)
  const right = components.visibleWidth(bands.right)
  if (bands.center === '') return bands.right === '' ? bands.left : `${bands.left}${' '.repeat(Math.max(gap, width - left - right))}${bands.right}`
  const roomStart = left + (bands.left === '' ? 0 : gap)
  const roomEnd = Math.max(roomStart, width - right - (bands.right === '' ? 0 : gap))
  const start = Math.min(Math.max(roomStart, Math.floor((width - center) / 2)), Math.max(roomStart, roomEnd - center))
  const line = `${bands.left}${' '.repeat(Math.max(0, start - left))}${bands.center}`
  return bands.right === '' ? line : `${line}${' '.repeat(Math.max(0, width - start - center - right))}${bands.right}`
}

/** What an admission row needs from its compiled children and its host. */
export interface AdmissionRowOptions {
  readonly components: Pick<MayflyComponents, 'visibleWidth' | 'truncateToWidth'>
  readonly gap?: number | undefined
  /** The children that are visible at this paint, in order. */
  readonly children: () => readonly Omit<AdmissionChild, 'natural'>[]
}

/**
 * The row component. Each child is painted once at the probe width to learn its natural width; an admitted child that
 * fits reuses those rows, and a truncated one is painted again at its room. Only the first row of a child is drawn.
 */
export class AdmissionRow implements Component {
  constructor(private readonly options: AdmissionRowOptions) {}

  render(width: number): string[] {
    const columns = Math.max(1, Math.floor(width))
    const gap = this.options.gap ?? ADMISSION_GAP
    const { components } = this.options
    const probe = Math.max(ADMISSION_PROBE_WIDTH, columns)
    const children = this.options.children().map(child => {
      const rows = child.component.render(probe)
      return { ...child, rows, natural: Math.min(probe, Math.max(0, ...rows.map(row => contentWidth(row, components)))) }
    })
    const admitted = admitWidths(children, columns, gap)
    const painted = (band: AdmissionChild['band']): string => children
      .flatMap((child, index) => {
        const room = admitted.get(index)
        if (room === undefined || child.band !== band) return []
        const fits = room >= child.natural
        const row = (fits ? child.rows : child.component.render(Math.max(1, room)))[0] ?? ''
        return [components.truncateToWidth(row, fits ? child.natural : room, '')]
      })
      .join(' '.repeat(gap))
    const line = layoutBands({ left: painted('left'), center: painted('center'), right: painted('right') }, columns, gap, components)
    return [components.truncateToWidth(line, columns, '')]
  }

  invalidate(): void {}
}
