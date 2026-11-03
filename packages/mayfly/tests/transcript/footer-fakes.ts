/**
 * The footer as a screen paints it: the status row (`buildStatusFooter`) over a status registry's entries, compiled by the real
 * compiler into rows at a width. The width scans and the plugin specs read the footer through this.
 * @module transcript-footer-fakes
 */

import type { MayflyStatusEntry } from '@ephemeral-ai/mayfly-ui'
import type { MayflyComponents, MayflySemanticColors } from '../../src/core/types.ts'
import { compileMayflyUiNode } from '../../src/core/ui-compiler.ts'
import { buildStatusFooter, type StatusFooterState } from '../../src/transcript/status-rows.ts'

/**
 * The rows of the footer at a width.
 * @param entries - the registry's entries (and the lane's items).
 * @param width - the width to paint at.
 * @param components - the width helpers.
 * @param colors - the palette.
 * @param state - the entered item, if any.
 * @returns the rows, or none when no entry has anything to show.
 */
export function footerRows(entries: readonly MayflyStatusEntry[], width: number, components: MayflyComponents, colors: MayflySemanticColors, state: StatusFooterState = {}): string[] {
  const node = buildStatusFooter(entries, state)
  if (node === null) return []
  const compiled = compileMayflyUiNode(node, { components, colors, getViewport: () => ({ columns: width, rows: 24 }), screenMode: 'alternate', emit: () => {} })
  return (compiled.ok ? compiled.value.component : compiled.errorComponent).render(width)
}
