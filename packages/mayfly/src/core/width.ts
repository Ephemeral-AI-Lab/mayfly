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

export { sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'

import { sliceByColumn, visibleWidth } from '@earendil-works/pi-tui'

/** Clamp an arbitrary viewport width to a usable positive column count. */
export function safeWidth(width: number): number {
  return Math.max(1, Number.isFinite(width) ? Math.floor(width) : 1)
}

/** Keep a row as-is when it fits, otherwise cut it to the column budget. */
export function fitText(value: string, width: number): string {
  const available = safeWidth(width)
  return visibleWidth(value) <= available ? value : sliceByColumn(value, 0, available, true)
}
