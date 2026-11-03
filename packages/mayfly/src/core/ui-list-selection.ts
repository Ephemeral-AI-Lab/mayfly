/**
 * The selected item ids of a list node. `selectedIds` is optional on the wire and means none selected, so every core
 * reader goes through one function and gets one shared empty array (a stable identity for the caches).
 *
 * @module @ephemeral-ai/mayfly/core/ui-list-selection
 */

import type { MayflyListNode } from '@ephemeral-ai/mayfly-ui'

const NO_SELECTION: readonly string[] = Object.freeze([])

/** The ids a list declares as selected; `[]` when the node omits the field. */
export function listSelectedIds(node: Pick<MayflyListNode, 'selectedIds'>): readonly string[] {
  return node.selectedIds ?? NO_SELECTION
}
