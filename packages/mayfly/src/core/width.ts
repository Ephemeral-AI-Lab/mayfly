/**
 * L0 width-truth seam: the single entry point for pi-tui's width utilities
 * inside core and in cross-package tests (the source-plane convention —
 * transcript/interaction specs import this file by relative path). Only
 * core declares `@earendil-works/pi-tui` as a dependency, so routing every
 * consumer through here keeps version resolution unique (D4: no other
 * package names pi-tui) and lets the width-property spec pin the semantics
 * the `MayflyComponent` contract and the exit clamp depend on.
 *
 * @module @ephemeral-ai/mayfly/core/width
 */

import { sliceByColumn, visibleWidth } from '@earendil-works/pi-tui'

export { sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'

/**
 * The marker every signalling truncation uses when text must be elided. It is
 * exactly one display column wide, so a caller can reserve it with one column
 * and never split a grapheme. Silent clips keep their explicit `''` at the
 * call site.
 */
export const OVERFLOW_ELLIPSIS = '…'

/**
 * Fits plain text into one row by eliding the middle (`head…tail`, the head one column longer when the room is odd) or
 * the start (`…tail`), so the distinguishing end of a path or a title stays visible. Text that fits is returned as is;
 * otherwise exactly `width` columns are used, and a width of zero or less yields an empty row.
 */
export function truncateMiddle(text: string, width: number, where: 'middle' | 'start' = 'middle'): string {
  const room = Math.floor(width)
  if (room <= 0) return ''
  const total = visibleWidth(text)
  if (total <= room) return text
  if (room === 1) return OVERFLOW_ELLIPSIS
  if (where === 'start') return `${OVERFLOW_ELLIPSIS}${sliceByColumn(text, total - (room - 1), room - 1, true)}`
  const head = Math.ceil((room - 1) / 2)
  const tail = Math.floor((room - 1) / 2)
  return `${sliceByColumn(text, 0, head, true)}${OVERFLOW_ELLIPSIS}${tail === 0 ? '' : sliceByColumn(text, total - tail, tail, true)}`
}
