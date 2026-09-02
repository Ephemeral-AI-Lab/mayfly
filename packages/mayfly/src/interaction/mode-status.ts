/** Session-mode status contribution backed by native dsh state.
 * @module @ephemeral-ai/mayfly/interaction/mode-status
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-plan-mode'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '../app/index.ts'
import type {} from '@ephemeral-ai/mayfly-ui'
import { sessionModeSnapshot } from './mode-commands.ts'

export const name = 'mayfly-status-mode'
export const inject = ['mayflyStatus', 'mayflyCurrentAgent', 'sessionProjections']

/** Register the current Agent's plan/yolo badge. */
export function apply(ctx: Context): void {
  const model = () => {
    const agent = ctx.mayflyCurrentAgent.current()
    const state = agent === null ? undefined : sessionModeSnapshot(ctx, agent)
    const text = state?.mode === 'yolo'
      ? 'yolo'
      : state?.mode === 'plan' ? state.plan?.pending === true ? 'plan...' : 'plan' : ''
    return {
      id: 'mayfly.status.mode',
      priority: 2,
      node: { kind: 'text' as const, content: text, tone: text === 'yolo' ? 'warning' as const : 'accent' as const },
      visible: text !== '',
    }
  }
  const registration = ctx.mayflyStatus.register(model)
  const refresh = (): void => registration.refresh()
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
