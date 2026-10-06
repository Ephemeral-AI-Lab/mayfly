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
}

/** A fresh sink with every counter at zero. */
export function createWorkCounters(): MayflyWorkCounters {
  return { nodesValidated: 0, unitsCompiled: 0, rowsPainted: 0, stringsMeasured: 0 }
}

/** Adds to one counter; a missing sink (production) does nothing. */
export function countWork(counters: MayflyWorkCounters | undefined, counter: keyof MayflyWorkCounters, amount = 1): void {
  if (counters !== undefined) counters[counter] += amount
}
