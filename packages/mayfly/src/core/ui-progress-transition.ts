/**
 * The renderer-owned one-shot of a progress node's `transition`: when a revision first reaches the painter, the bar
 * drains linearly from `from` to its value over `ms`, counted in steps of the one animation clock. A node that never
 * changes revision keeps its value, and reduced motion or a runtime with no clock shows the settled value at once.
 *
 * @module @ephemeral-ai/mayfly/core/ui-progress-transition
 */

import type { MayflyProgressNode } from '@ephemeral-ai/mayfly-ui'
import { LOADER_FRAME_MS } from './ui-loader-animation.ts'

/** What to draw now, and whether the bar still needs the clock. */
export interface ProgressStep {
  readonly value: number
  readonly animating: boolean
}

export class UiProgressTransitions {
  private readonly started = new Map<string, { readonly rev: number, readonly frame: number }>()

  /** The value of a transitioning bar at the clock `frame`; the first sight of a revision starts its one-shot. */
  step(key: string, node: MayflyProgressNode & { readonly transition: NonNullable<MayflyProgressNode['transition']> }, frame: number): ProgressStep {
    const { from, ms, rev } = node.transition
    let entry = this.started.get(key)
    if (entry === undefined || entry.rev !== rev) {
      entry = { rev, frame }
      this.started.set(key, entry)
    }
    const done = Math.min(1, ((frame - entry.frame) * LOADER_FRAME_MS) / ms)
    return { value: from + (node.value - from) * done, animating: done < 1 }
  }
}
