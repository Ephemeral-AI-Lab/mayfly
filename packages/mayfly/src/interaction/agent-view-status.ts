/**
 * Compact status indication for the retained primary/auxiliary conversation.
 * @module @ephemeral-ai/mayfly/interaction/agent-view-status
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MayflyStatusNode } from '@ephemeral-ai/mayfly-ui'
import type {} from '../app/current-agent.ts'

/** Stable child-plugin name. */
export const name = 'mayfly-agent-view-status'
/** App selection and direct status registry required by the indicator. */
export const inject = ['mayflyCurrentAgent', 'mayflyStatus']

/** Register the centered primary/auxiliary scope indicator. */
export function apply(ctx: Context): void {
  const node = (): MayflyStatusNode | null => {
    const snapshot = ctx.mayflyCurrentAgent.view()
    const auxiliary = snapshot.auxiliary
    if (auxiliary === null) return null
    const kind = auxiliary.kind === 'btw' ? 'BTW' : 'SUBAGENT'
    return {
      kind: 'rich-text',
      spans: snapshot.displayed === 'primary'
        ? [
            { text: 'MAIN', tone: 'accent', styles: ['strong'] },
            { text: ` ⇄ ${kind} · ${auxiliary.label}`, tone: 'muted' },
            ...(auxiliary.access === 'readonly' ? [{ text: ' · read-only', tone: 'muted' as const }] : []),
          ]
        : [
            { text: 'MAIN ⇄ ', tone: 'muted' },
            { text: `${kind} · ${auxiliary.label}`, tone: 'accent', styles: ['strong'] },
            ...(auxiliary.access === 'readonly' ? [{ text: ' · read-only', tone: 'muted' as const }] : []),
          ],
    }
  }
  const registration = ctx.mayflyStatus.register({
    id: 'mayfly.status.agent-view',
    priority: 0,
    band: 'center',
  }, node())
  const offView = ctx.mayflyCurrentAgent.subscribeView(() => { registration.set(node()) })
  ctx.effect(() => offView)
  ctx.effect(() => () => registration.dispose())
}
