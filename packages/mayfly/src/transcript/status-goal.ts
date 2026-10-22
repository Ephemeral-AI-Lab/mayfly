/**
 * Compact current-goal state in the Mayfly status footer.
 *
 * @module @ephemeral-ai/mayfly/transcript/status-goal
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import type { SessionFactsService } from './session-facts.ts'
import type { MayflyStatusNode } from '@ephemeral-ai/mayfly-ui'

/** Stable Cordis plugin name. */
export const name = 'mayfly-status-goal'

/** Native and Mayfly services required by the status contribution. */
export const inject = ['mayflyStatus', 'mayflyCurrentAgent', 'mayflySessionFacts', 'goals']

/** Render the bounded goal summary shared by the live producer and tests. */
export function goalStatusText(goal: GoalView | undefined): string {
  if (goal === undefined) return ''
  return `Goal ${goal.phase} · ${String(goal.roundsStarted)}/${String(goal.maxGoalRounds)} · ${goal.activation}`
}

/** Register the direct status contribution. */
export function apply(ctx: Context): void {
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
    const nextText = goalStatusText(goal)
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
  ctx.on('agent/session-start', ({ agent }) => {
    if (agent === ctx.mayflyCurrentAgent.current()) derive()
  })
  ctx.effect(() => () => {
    offGoal()
    offAgent()
  })
}
