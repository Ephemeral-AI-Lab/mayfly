/**
 * Opt-in renderer-neutral header pane demonstrating a shared user kit.
 *
 * @module @mayfly-example/header
 */
import type { Context } from '@deepseek-ai/cordis'
// Pull in the direct Mayfly pane service Context merge.
import type {} from '@ephemeral-ai/mayfly-ui'
import { summaryMetric } from '@mayfly-example/user-kit'

export const name = '@mayfly-example/header'
export const inject = ['mayflyPanes']

/** Register the example header contribution for this plugin Fiber. */
export function apply(ctx: Context): void {
  ctx.mayflyPanes.register({
    id: 'example.header.summary',
    title: 'Workspace',
    placement: 'header',
    size: { min: 1, preferred: 3, max: 4 },
    narrow: 'hidden',
  }, summaryMetric.render({ label: 'Branch', value: 'main', detail: 'Mayfly ecosystem example' }))
}
