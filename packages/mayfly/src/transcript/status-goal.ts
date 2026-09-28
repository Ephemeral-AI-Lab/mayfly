/**
 * Compact current-goal state in the Mayfly status footer.
 *
 * @module @ephemeral-ai/mayfly/transcript/status-goal
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import type { SessionFactsService } from './session-facts.ts'
import type { MayflyStatusNode } from '@ephemeral-ai/mayfly-ui'
import { interpolateLocaleMessage, type MayflyTranslate } from '../frontend/index.ts'
import { transcriptTranslator } from './locale.ts'

/** Stable Cordis plugin name. */
export const name = 'mayfly-status-goal'

/** Native and Mayfly services required by the status contribution. */
export const inject = ['mayflyStatus', 'mayflyCurrentAgent', 'mayflySessionFacts', 'goals']

/** Durable phase spellings resolved through the catalog. */
const PHASE_LABEL = {
  active: 'active',
  paused: 'paused',
  blocked: 'blocked',
  complete: 'complete',
} as const satisfies Record<GoalView['phase'], string>

/** Process-local activation spellings resolved through the catalog. */
const ACTIVATION_LABEL = {
  armed: 'armed',
  disarmed: 'disarmed',
} as const satisfies Record<GoalView['activation'], string>

/** Render the bounded goal summary shared by the live producer and tests. */
export function goalStatusText(goal: GoalView | undefined, t: MayflyTranslate = interpolateLocaleMessage): string {
  if (goal === undefined) return ''
  return t('Goal {phase} · {rounds}/{total} · {activation}', {
    phase: t(PHASE_LABEL[goal.phase]),
    rounds: goal.roundsStarted,
    total: goal.maxGoalRounds,
    activation: t(ACTIVATION_LABEL[goal.activation]),
  })
}

/** Register the direct status contribution. */
export function apply(ctx: Context): void {
  const t = transcriptTranslator(ctx, 'transcript')
  let text = ''
  let tone: 'accent' | 'success' | 'warning' | 'muted' = 'muted'
  let status: ReturnType<typeof ctx.mayflyStatus.register>
  const node = (): MayflyStatusNode | null => text === '' ? null : { kind: 'text', content: text, tone }
  const derive = (): void => {
    const agent = ctx.mayflyCurrentAgent.current()
    let goal: GoalView | undefined
    try {
      goal = agent === null ? undefined : ctx.goals.get(agent)
    } catch (error) {
      ctx.logger.warn(`could not read current goal for status: ${error instanceof Error ? error.message : String(error)}`)
    }
    const nextText = goalStatusText(goal, t)
    const nextTone = goal?.phase === 'active'
      ? 'accent'
      : goal?.phase === 'complete'
        ? 'success'
        : goal?.phase === 'blocked' || goal?.phase === 'paused'
          ? 'warning'
          : 'muted'
    if (nextText === text && nextTone === tone) return
    text = nextText
    tone = nextTone
    status?.set(node())
  }
  status = ctx.mayflyStatus.register({
    id: 'mayfly.status.goal',
    priority: 2,
    overflow: 'hide',
  }, node())
  const facts = ctx.get('mayflySessionFacts') as SessionFactsService
  const offGoal = facts.subscribeGoal(() => derive())
  const offAgent = ctx.mayflyCurrentAgent.subscribe(() => derive())
  ctx.on('goal/changed', ({ agent }) => {
    if (agent === ctx.mayflyCurrentAgent.current()) derive()
  })
  ctx.on('agent/created', ({ agent }) => {
    if (agent === ctx.mayflyCurrentAgent.current()) derive()
  })
  ctx.effect(() => () => {
    offGoal()
    offAgent()
  })
}
