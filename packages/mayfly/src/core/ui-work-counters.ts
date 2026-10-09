/**
 * Core-private work counters for the canonical UI pipeline. A caller that wants to know how much work a publish,
 * a key, or a clock tick costs passes one {@link MayflyWorkCounters} through the validator and compiler options;
 * production passes none. The sink is owned by its caller, never by a module, so concurrent measurements cannot mix.
 *
 * @module @ephemeral-ai/mayfly/core/ui-work-counters
 */

/** Work done by the validator, the compiler, and the painters, counted in units that do not depend on the clock. */
export interface MayflyWorkCounters {
  /** Nodes and list items admitted by the validator. */
  nodesValidated: number
  /** Nodes turned into components by the compiler. */
  unitsCompiled: number
  /** Rows produced by a painter, memo hits excluded. */
  rowsPainted: number
  /** Strings measured through the injected seam and the compiler's own frame paths; painters are not counted yet. */
  stringsMeasured: number
  /** Leaf renders that painted, memo hits excluded: what one frame costs once the tree is compiled. */
  componentRenders: number
  /** Walks of the whole control tree, memo hits excluded. */
  controlWalks: number
  /** Focus reconciliations against the visible controls. */
  reconciles: number
  /** Passes over a whole compiled tree: a frame render, a constrained or geometry layout, a native layout entry. */
  layoutPasses: number
  /** Clock ticks that asked for a repaint. */
  clockTicks: number
  /** Snapshots of the whole keymap (`list()`); a workload counts them through its own keymap. */
  keymapSnapshots: number
}

/** A fresh sink with every counter at zero. */
export function createWorkCounters(): MayflyWorkCounters {
  return { nodesValidated: 0, unitsCompiled: 0, rowsPainted: 0, stringsMeasured: 0, componentRenders: 0, controlWalks: 0, reconciles: 0, layoutPasses: 0, clockTicks: 0, keymapSnapshots: 0 }
}

/** Adds to one counter; a missing sink (production) does nothing. */
export function countWork(counters: MayflyWorkCounters | undefined, counter: keyof MayflyWorkCounters, amount = 1): void {
  if (counters !== undefined) counters[counter] += amount
}
