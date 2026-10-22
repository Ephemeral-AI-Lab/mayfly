/**
 * Opt-in renderer-neutral right inspector using the shared user kit.
 *
 * @module @mayfly-example/right-inspector
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@ephemeral-ai/mayfly-ui'
import { ui } from '@ephemeral-ai/mayfly-ui'
import { summaryMetric } from '@mayfly-example/user-kit'

export const name = '@mayfly-example/right-inspector'
export const inject = ['mayflyPanes']

/** Register a right lane that degrades into the bottom lane when narrow. */
export function apply(ctx: Context): void {
  ctx.mayflyPanes.register({
    id: 'example.inspector.context',
    title: 'Inspector',
    placement: 'right',
    size: { min: 20, preferred: 30, max: 40 },
    narrow: 'bottom',
  }, ui.stack.column([
      summaryMetric.render({ label: 'Context', value: '42%', detail: '12k / 28k tokens' }),
      ui.fields([
        { label: 'Mode', value: [{ text: 'normal', tone: 'success' }] },
        { label: 'Model', value: [{ text: 'deepseek-chat', tone: 'accent' }] },
      ]),
    ], { gap: 1 }))
}
