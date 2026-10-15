/**
 * Priority admission for a `stack.row` whose children carry a `priority`: they are admitted in order while they fit,
 * the first that does not either takes the room that is left or drops out, and the admitted children sit in their
 * bands. It is the design's one rule for rows of unequal worth (the status row, a toolbar), so a plugin entry and a
 * Mayfly entry are admitted the same way. Before admission the row sheds: children with narrower forms (shed nodes) give
 * them up in rank order until the row fits.
 *
 * @module @ephemeral-ai/mayfly/core/ui-admission
 */

import type { Component } from '@earendil-works/pi-tui'
import type { MayflyUiChild } from '@ephemeral-ai/mayfly-ui'
import type { MayflyComponents, MayflySemanticColors } from './types.ts'
import { declaredWidthOf } from './ui-rows.ts'
import { countWork, type MayflyWorkCounters } from './ui-work-counters.ts'

/** The narrowest room a truncated child takes; a smaller remainder drops it. */
export const ADMISSION_MIN_TRUNCATED = 8

/** A child's natural width is measured at this width, or at the row's when that is wider. */
const ADMISSION_PROBE_WIDTH = 120

/** The gap between admitted children when the row names none. */
const ADMISSION_GAP = 2

/** What admission reads of one child. */
interface AdmissionEntry {
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

/** One form of an admission child: what the row paints for it once the row has shed down to `rank`. */
interface AdmissionForm {
  /** The shed rank at which the child falls back to this form; the full form carries `-1`. */
  readonly rank: number
  /** The form, or `null` for a hidden child. */
  readonly component: Component | null
}

/** One child of an admission row. */
interface AdmissionChild {
  /** Its forms from the full one; a child that cannot shed has just that one. */
  readonly forms: readonly AdmissionForm[]
  readonly priority?: number | undefined
  readonly overflow?: MayflyUiChild['overflow'] | undefined
  readonly band: 'left' | 'center' | 'right'
  /** A heavy line under the child's words, on the row's second line. */
  readonly mark?: 'underline' | undefined
}

const ANSI = /\x1b\[[0-9;]*m/gu

/** The width of a painted row without its trailing blank cells. */
function contentWidth(row: string, components: Pick<MayflyComponents, 'visibleWidth'>): number {
  return components.visibleWidth(row.replace(ANSI, '').trimEnd())
}

/**
 * The columns where each band's cluster starts in a row `layoutBands` lays out, for what sits under a child of a band.
 * It mirrors `layoutBands` exactly: the same room for the center, the same right edge.
 */
function bandStarts(widths: { readonly left: number, readonly center: number, readonly right: number }, width: number, gap: number): { readonly left: number, readonly center: number, readonly right: number } {
  if (widths.center === 0) return { left: 0, center: 0, right: widths.right === 0 ? widths.left : widths.left + Math.max(gap, width - widths.left - widths.right) }
  const roomStart = widths.left + (widths.left === 0 ? 0 : gap)
  const roomEnd = Math.max(roomStart, width - widths.right - (widths.right === 0 ? 0 : gap))
  const start = Math.min(Math.max(roomStart, Math.floor((width - widths.center) / 2)), Math.max(roomStart, roomEnd - widths.center))
  return { left: 0, center: start, right: width - widths.right }
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
interface AdmissionRowOptions {
  readonly components: Pick<MayflyComponents, 'visibleWidth' | 'truncateToWidth'>
  /** Paints the mark under a child (`muted`). */
  readonly colors: Pick<MayflySemanticColors, 'muted' | 'primary'>
  readonly gap?: number | undefined
  /** The work sink; the row counts the one row it paints. */
  readonly counters?: MayflyWorkCounters | undefined
  /** The children that are visible at this paint, in order. */
  readonly children: () => readonly AdmissionChild[]
}

/** The mark's glyph: a heavy line. */
const MARK_GLYPH = '━'

/**
 * The row component. Each form is painted once at the probe width to learn its natural width; an admitted child that
 * fits reuses those rows, and a truncated one is painted again at its room. Only the first row of a child is drawn.
 *
 * Before the children are admitted, the row sheds: while its children's natural widths do not fit, it gives up forms in
 * rank order, lowest first, across every child that has narrower forms (a child falls back to its form of the highest
 * rank reached; a hidden form takes the child out). Only what still does not fit goes through admission. A child with a
 * mark adds a second row with a heavy line under its words.
 */
export class AdmissionRow implements Component {
  constructor(private readonly options: AdmissionRowOptions) {}

  render(width: number): string[] {
    const columns = Math.max(1, Math.floor(width))
    const gap = this.options.gap ?? ADMISSION_GAP
    const { components } = this.options
    const probe = Math.max(ADMISSION_PROBE_WIDTH, columns)
    const measured = new Map<Component, { readonly rows: string[], readonly natural: number }>()
    const measure = (component: Component): { readonly rows: string[], readonly natural: number } => {
      let known = measured.get(component)
      if (known === undefined) {
        const rows = component.render(probe)
        const declared = declaredWidthOf(rows)
        known = { rows, natural: Math.min(probe, declared === undefined ? rows.reduce((max, row) => Math.max(max, contentWidth(row, components)), 0) : declared) }
        measured.set(component, known)
      }
      return known
    }
    const all = this.options.children()
    const chosen = all.map(() => 0)
    const live = (): readonly number[] => all.flatMap((child, index) => child.forms[chosen[index]!]!.component === null ? [] : [index])
    const total = (): number => {
      const shown = live()
      return shown.reduce((sum, index) => sum + measure(all[index]!.forms[chosen[index]!]!.component!).natural, 0) + Math.max(0, shown.length - 1) * gap
    }
    const steps = all
      .flatMap((child, index) => child.forms.slice(1).map((form, at) => ({ index, form: at + 1, rank: form.rank })))
      .toSorted((left, right) => left.rank - right.rank || left.index - right.index)
    for (const step of steps) {
      if (total() <= columns) break
      chosen[step.index] = Math.max(chosen[step.index]!, step.form)
    }
    const children = all.flatMap((child, index) => {
      const form = child.forms[chosen[index]!]!.component
      if (form === null) return []
      const { rows, natural } = measure(form)
      return [{ ...child, component: form, rows, natural }]
    })
    const admitted = admitWidths(children, columns, gap)
    const painted = (band: AdmissionChild['band']): string => children
      .flatMap((child, index) => {
        const room = admitted.get(index)
        if (room === undefined || child.band !== band) return []
        const fits = room >= child.natural
        const row = (fits ? child.rows : child.component.render(Math.max(1, room)))[0] ?? ''
        // A wrapped first row can end inside its style; the reset keeps it out of the gap and the next child.
        return [`${components.truncateToWidth(row, fits ? child.natural : room, '')}\x1b[0m`]
      })
      .join(' '.repeat(gap))
    countWork(this.options.counters, 'rowsPainted')
    const bands = { left: painted('left'), center: painted('center'), right: painted('right') }
    const line = components.truncateToWidth(layoutBands(bands, columns, gap, components), columns, '')
    if (!children.some((child, index) => child.mark !== undefined && admitted.has(index))) return [line]
    // The mark's row: each child's column is its band's start plus what the children before it in the band take.
    const widths = { left: components.visibleWidth(bands.left), center: components.visibleWidth(bands.center), right: components.visibleWidth(bands.right) }
    const starts = bandStarts(widths, columns, gap)
    const used = { left: 0, center: 0, right: 0 }
    let underline = ''
    for (const [index, child] of children.entries()) {
      const room = admitted.get(index)
      if (room === undefined) continue
      const own = Math.min(room, child.natural)
      const at = starts[child.band] + used[child.band]
      used[child.band] += own + gap
      if (child.mark === undefined) continue
      underline += ' '.repeat(Math.max(0, at - components.visibleWidth(underline))) + MARK_GLYPH.repeat(Math.max(0, Math.min(own, columns - at)))
    }
    return [line, this.options.colors.primary(underline)]
  }

  invalidate(): void {}
}
