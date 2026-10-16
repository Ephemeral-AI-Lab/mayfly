/**
 * The shed ranks of the status row: what the row gives up first when it does not fit (see `MayflyShedNode`). A lower rank
 * gives way earlier, across every entry of the row, so the order below is the order the row thins out in: the
 * provider, the thinking level, the git facts, the directory's depth, the cache bar, the context bar's width (down to
 * its percentage), the context readout, and last the model.
 *
 * @module @ephemeral-ai/mayfly/transcript/status-shed
 */

import { ui, type MayflyShedForm, type MayflyStatusNode } from '@ephemeral-ai/mayfly-ui'

/** Shed ranks, in the order they are given up. */
export const SHED = Object.freeze({ provider: 10, effort: 20, git: 30, cwd: 40, cache: 50, bar: 55, context: 60, model: 70 })

/**
 * A status node with its narrower forms, or the node itself when it has none.
 * @param full - the form shown while the row fits.
 * @param narrower - the forms the row falls back to, each at its rank.
 * @returns the node to publish.
 */
export function shedNode(full: MayflyStatusNode, narrower: readonly MayflyShedForm[]): MayflyStatusNode {
  return narrower.length === 0 ? full : ui.shed(full, narrower)
}
