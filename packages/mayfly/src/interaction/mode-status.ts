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
export const inject = ['mayflyStatus', 'mayflyCurrentAgent', 'mayflySessionStart', 'sessionProjections']

/** The native projections whose change can move either badge. */
const MODE_KEYS: ReadonlySet<string> = new Set(['plan', 'permissions'])

/** Register the current Agent's independent plan and yolo badges. */
export function apply(ctx: Context): void {
  const t = interactionTranslator(ctx)
  const node = (): MayflyStatusNode | null => {
    const agent = ctx.mayflyCurrentAgent.current()
    const state = agent === null ? undefined : sessionModeSnapshot(ctx, agent)
    // The start surface has no Agent to carry plan state; the pending
    // selection is shown as a queued badge that the first session takes.
    const startPlan = agent === null
      && ctx.mayflyCurrentAgent.primary() === null
      && ctx.mayflySessionStart.planActive()
    const pending = startPlan || state?.plan?.pending === true
    const plan: MayflyStatusNode | null = startPlan || state?.plan?.active === true || state?.plan?.pending === true
      ? { kind: 'text', content: pending ? t('plan…') : t('plan'), tone: 'accent' }
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
  // A native projection change re-reads both modes; only a changed badge
  // republishes (and recompiles the footer).
  const refresh = (): void => {
    const next = node()
    const nextSignature = JSON.stringify(next)
    if (nextSignature === signature) return
    signature = nextSignature
    registration.set(next)
  }
  const offAgent = ctx.mayflyCurrentAgent.subscribe(refresh)
  const offStartPlan = ctx.mayflySessionStart.subscribePlan(refresh)
  const offProjection = ctx.sessionProjections.onChanged((session, key) => {
    if (session !== ctx.mayflyCurrentAgent.current()?.session) return
    // Only the plan and permission projections can change the badges; the
    // change feed already reports the effective post-write value.
    if (!MODE_KEYS.has(key)) return
    refresh()
  })
  ctx.effect(() => () => {
    offAgent()
    offStartPlan()
    offProjection()
    registration.dispose()
  })
}
