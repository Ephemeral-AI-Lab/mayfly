/**
 * Package-private rendering adapter for canonical frontend nodes. It supplies
 * runtime dependencies to core's sole validator/compiler without converting
 * to another model vocabulary or owning width calculations.
 *
 * @module @ephemeral-ai/mayfly/transcript/canonical-node-renderer
 */

import type { MayflyUiEvent, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { compileMayflyUiNode, type MayflyComponents, type MayflySemanticColors } from '../core/index.ts'

/** Renderer dependencies already owned by the active frontend tree. */
export interface CanonicalNodeRenderer {
  readonly components: MayflyComponents
  readonly colors: MayflySemanticColors
  readonly viewportRows?: () => number
}

const PASSIVE_EVENT_SINK = Function.prototype as (event: MayflyUiEvent) => void

function positiveInteger(value: number): number {
  return Math.max(1, Number.isFinite(value) ? Math.floor(value) : 1)
}

/**
 * Validate, compile, and render one canonical node at the assigned width.
 * @param node - canonical renderer-neutral UI tree.
 * @param width - assigned terminal width.
 * @param renderer - tree-scoped compiler dependencies.
 * @param maxLeafRows - optional official-model leaf budget.
 * @returns width-contained rows or core's structured rejection component.
 */
export function renderCanonicalNode(
  node: MayflyUiNode,
  width: number,
  renderer: CanonicalNodeRenderer,
  maxLeafRows?: number,
): string[] {
  const columns = positiveInteger(width)
  const rows = positiveInteger(renderer.viewportRows?.() ?? Number.MAX_SAFE_INTEGER)
  const result = compileMayflyUiNode(node, {
    components: renderer.components,
    colors: renderer.colors,
    getViewport: () => ({ columns, rows }),
    screenMode: 'main',
    ...(maxLeafRows === undefined ? {} : { maxLeafRows }),
    emit: PASSIVE_EVENT_SINK,
  })
  return result.ok
    ? result.value.component.render(columns)
    : result.errorComponent.render(columns)
}
