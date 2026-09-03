/**
 * Empty runtime entry for the opt-in ecosystem composition bundle.
 * The five plugin Fibers are mounted exclusively by cordis.patch.yml.
 *
 * @module @mayfly-example/ecosystem
 */
import type { Context } from '@deepseek-ai/cordis'

export const name = '@mayfly-example/ecosystem'

/** Bind the otherwise empty bundle entry to its Cordis Fiber. */
export function apply(ctx: Context): void {
  ctx.effect(() => () => {})
}
