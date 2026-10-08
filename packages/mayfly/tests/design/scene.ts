/**
 * Scene frames rebuilt with the real renderer: each scene page is the real `ui.*` node the prototype's page draws,
 * compiled under the probe palette at the scene's width, and compared cell by cell with its golden frame.
 */

import { ui, type MayflyUiNode } from '../../../ui/src/index.ts'
import { compileMayflyUiNode } from '../../src/core/ui-compiler.ts'
import { compareCells, parseCells, PROBE_PALETTE, parityComponents, readGoldenFrames, type ParityDiff, type ParityWaiver } from './parity.ts'
import type { PendingParity } from './pending.ts'
import type { MayflyComponents } from '../../src/core/types.ts'

/** The muted caption every prototype scene prints above its body. */
export const caption = (text: string): MayflyUiNode => ui.text(text, { tone: 'muted' })

/** Paints a static node at a width with the real compiler, the probe palette, and no focus. */
export function paint(node: MayflyUiNode, width: number, components: MayflyComponents = parityComponents()): string[] {
  const result = compileMayflyUiNode(node, {
    components,
    colors: PROBE_PALETTE,
    getViewport: () => ({ columns: width, rows: 200 }),
    screenMode: 'alternate',
  })
  if (!result.ok) throw new Error(result.message)
  return result.value.component.render(width)
}

/** The rows of one golden frame. */
export function goldenRows(directory: string, walk: string, frame: number): readonly string[] {
  const frames = readGoldenFrames(directory, walk)
  const found = frames[frame]
  if (found === undefined) throw new Error(`${directory}/${walk} has no frame ${String(frame)}`)
  return found.rows
}

/**
 * Compares real rows with a golden frame at `columns` and returns the differences, each with the plain text of both
 * rows so a failure reads like a diff.
 */
export async function frameDiffs(expectedRows: readonly string[], actualRows: readonly string[], columns: number, waivers: readonly ParityWaiver[] = [], pending: readonly PendingParity[] = []): Promise<readonly (ParityDiff & { readonly rowText: string })[]> {
  const expected = await parseCells(expectedRows, columns, 'prototype')
  const actual = await parseCells(actualRows, columns, 'real')
  const text = (cells: readonly { readonly ch: string }[] | undefined): string => (cells ?? []).map(cell => cell.ch).join('').trimEnd()
  // A pending entry skips its cells; the slice it names will match them.
  const owed = (diff: ParityDiff): boolean => pending.some(entry => (entry.rows === undefined || (diff.row >= entry.rows[0] && diff.row <= entry.rows[1]))
    && (entry.cols === undefined || (diff.col >= entry.cols[0] && diff.col <= entry.cols[1])))
  return compareCells(expected, actual, waivers).filter(diff => !owed(diff)).map(diff => ({ ...diff, rowText: `${text(expected[diff.row])}\n${text(actual[diff.row])}` }))
}

/** One line per differing row: the first differing cell, then both rows' text, so a failure reads like a diff. */
export function diffReport(diffs: readonly (ParityDiff & { readonly rowText: string })[]): string {
  const rows = new Map<number, (ParityDiff & { readonly rowText: string })[]>()
  for (const diff of diffs) rows.set(diff.row, [...rows.get(diff.row) ?? [], diff])
  return [...rows.entries()].map(([row, cells]) => {
    const [expected, actual] = cells[0]!.rowText.split('\n')
    return `row ${String(row)} (${String(cells.length)} cells) col ${String(cells[0]!.col)}: ${cells[0]!.expected} != ${cells[0]!.actual}\n  - ${expected}\n  + ${actual}`
  }).join('\n')
}
