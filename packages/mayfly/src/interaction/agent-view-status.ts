/**
 * Compact status indication for the retained primary/auxiliary conversation.
 * @module @ephemeral-ai/mayfly/interaction/agent-view-status
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MayflyStatusNode } from '@ephemeral-ai/mayfly-ui'
import type {} from '../app/current-agent.ts'
import { ACTION_CLOSE_AGENT_VIEW, ACTION_TOGGLE_AGENT_VIEW, interactionKeyHint } from './keys.ts'

/** Stable child-plugin name. */
export const name = 'mayfly-agent-view-status'
/** App selection and direct status registry required by the indicator. */
export const inject = ['mayflyCurrentAgent', 'mayflyStatus', 'mayflyKeymap']

/** Register the centered primary/auxiliary scope indicator. */
export function apply(ctx: Context): void {
  const node = (): MayflyStatusNode | null => {
    const snapshot = ctx.mayflyCurrentAgent.view()
    const auxiliary = snapshot.auxiliary
    if (auxiliary === null) return null
    const kind = auxiliary.kind === 'btw' ? 'BTW' : 'SUBAGENT'
    const controls = ` · ${interactionKeyHint(ctx.mayflyKeymap, ACTION_TOGGLE_AGENT_VIEW, 'F7')} switch · ${interactionKeyHint(ctx.mayflyKeymap, ACTION_CLOSE_AGENT_VIEW, 'F8')} close`
    return {
      kind: 'rich-text',
      spans: snapshot.displayed === 'primary'
        ? [
            { text: 'MAIN', tone: 'accent', styles: ['strong'] },
            { text: controls, tone: 'muted' },
            { text: ` ⇄ ${kind} · ${auxiliary.label}`, tone: 'muted' },
            ...(auxiliary.access === 'readonly' ? [{ text: ' · read-only', tone: 'muted' as const }] : []),
          ]
        : [
            { text: kind, tone: 'accent', styles: ['strong'] },
            { text: controls, tone: 'muted' },
            { text: ` · ${auxiliary.label} ⇄ MAIN`, tone: 'muted' },
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
