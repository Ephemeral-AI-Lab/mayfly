/**
 * Opt-in renderer-neutral bottom log pane.
 *
 * @module @mayfly-example/bottom-log
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@ephemeral-ai/mayfly-ui'
import { ui } from '@ephemeral-ai/mayfly-ui'

export const name = '@mayfly-example/bottom-log'
export const inject = ['mayflyPanes']

/** Register a bounded passive log in the bottom surface lane. */
export function apply(ctx: Context): void {
  ctx.mayflyPanes.register({
    id: 'example.log.recent',
    title: 'Recent activity',
    placement: 'bottom',
    size: { min: 2, preferred: 4, max: 6 },
    narrow: 'bottom',
  }, ui.surface({
      chrome: 'lane',
      child: ui.sections([
        { body: ui.text('Plugin loaded', { tone: 'success' }) },
        { body: ui.text('Waiting for the next host event', { tone: 'muted' }) },
      ]),
    }))
}
