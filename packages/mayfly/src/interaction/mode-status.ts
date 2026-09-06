/** Session-mode status contribution backed by native dsh state.
 * @module @ephemeral-ai/mayfly/interaction/mode-status
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-plan-mode'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '../app/index.ts'
import type { MayflyStatusNode } from '@ephemeral-ai/mayfly-ui'
import { sessionModeSnapshot } from './mode-commands.ts'

export const name = 'mayfly-status-mode'
export const inject = ['mayflyStatus', 'mayflyCurrentAgent', 'sessionProjections']

/** Register the current Agent's independent plan and yolo badges. */
export function apply(ctx: Context): void {
  const node = (): MayflyStatusNode | null => {
    const agent = ctx.mayflyCurrentAgent.current()
    const state = agent === null ? undefined : sessionModeSnapshot(ctx, agent)
    const plan: MayflyStatusNode | null = state?.plan?.active === true || state?.plan?.pending === true
      ? { kind: 'text', content: state.plan.pending ? 'plan...' : 'plan', tone: 'accent' }
      : null
    const yolo: MayflyStatusNode | null = state?.yolo === true
      ? { kind: 'text', content: 'yolo', tone: 'warning' }
      : null
    if (plan === null) return yolo
    if (yolo === null) return plan
    return { kind: 'stack', direction: 'row', gap: 1, children: [{ node: plan }, { node: yolo }] }
  }
  const registration = ctx.mayflyStatus.register({ id: 'mayfly.status.mode', priority: 2 }, node())
  const refresh = (): void => registration.set(node())
  const offAgent = ctx.mayflyCurrentAgent.subscribe(refresh)
  const offSession = ctx.on('session/event', (session) => {
    if (session === ctx.mayflyCurrentAgent.current()?.session) refresh()
  })
  ctx.effect(() => () => {
    offAgent()
    offSession()
    registration.dispose()
  })
}
