/** Session-mode status contribution backed by native dsh state.
 * @module @ephemeral-ai/mayfly/interaction/mode-status
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-plan-mode'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '../app/index.ts'
import type { MayflyStatusNode } from '@ephemeral-ai/mayfly-ui'
import { interactionTranslator } from './locale.ts'
import { sessionModeSnapshot } from './mode-commands.ts'

export const name = 'mayfly-status-mode'
export const inject = ['mayflyStatus', 'mayflyCurrentAgent', 'sessionProjections']

/** Register the current Agent's independent plan and yolo badges. */
export function apply(ctx: Context): void {
  const t = interactionTranslator(ctx)
  const node = (): MayflyStatusNode | null => {
    const agent = ctx.mayflyCurrentAgent.current()
    const state = agent === null ? undefined : sessionModeSnapshot(ctx, agent)
    const plan: MayflyStatusNode | null = state?.plan?.active === true || state?.plan?.pending === true
      ? { kind: 'text', content: state.plan.pending ? t('plan…') : t('plan'), tone: 'accent' }
      : null
    const yolo: MayflyStatusNode | null = state?.yolo === true
      ? { kind: 'text', content: t('yolo'), tone: 'warning' }
      : null
    if (plan === null) return yolo
    if (yolo === null) return plan
    return { kind: 'stack', direction: 'row', gap: 1, children: [{ node: plan }, { node: yolo }] }
  }
  const initial = node()
  let signature = JSON.stringify(initial)
  const registration = ctx.mayflyStatus.register({ id: 'mayfly.status.mode', priority: 2 }, initial)
  // Every current-session event re-reads the modes; only a changed badge
  // republishes (and recompiles the footer).
  const refresh = (): void => {
    const next = node()
    const nextSignature = JSON.stringify(next)
    if (nextSignature === signature) return
    signature = nextSignature
    registration.set(next)
  }
  const offAgent = ctx.mayflyCurrentAgent.subscribe(refresh)
  const offSession = ctx.on('session/event', (session, event) => {
    if (session !== ctx.mayflyCurrentAgent.current()?.session) return
    // Only plan and permission facts can change the badges; stream deltas
    // and the rest of the session log cannot, so they never re-read the
    // projections.
    if (event.type !== 'plan/mode' && event.type !== 'permission/preset') return
    refresh()
  })
  ctx.effect(() => () => {
    offAgent()
    offSession()
    registration.dispose()
  })
}
