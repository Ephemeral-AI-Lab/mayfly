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

/** Render the bounded goal summary shared by the live producer and tests.
 *
 * Completed goals render nothing (the todo pane hides them too, so a finished
 * goal never lingers in the footer). The fraction carries its `round` unit,
 * and the process-local activation flag stays silent in its default `armed`
 * state — only a disarmed goal appends the human `auto-continue off` marker.
 */
export function goalStatusText(goal: GoalView | undefined, t: MayflyTranslate = interpolateLocaleMessage): string {
  if (goal === undefined || goal.phase === 'complete') return ''
  return t(goal.activation === 'disarmed'
    ? 'Goal {phase} · round {rounds}/{total} · auto-continue off'
    : 'Goal {phase} · round {rounds}/{total}', {
    phase: t(PHASE_LABEL[goal.phase]),
    rounds: goal.roundsStarted,
    total: goal.maxGoalRounds,
  })
}

/** Register the direct status contribution. */
export function apply(ctx: Context): void {
  const t = transcriptTranslator(ctx, 'transcript')
  let text = ''
  let tone: 'accent' | 'muted' | 'danger' = 'muted'
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
    // Tone follows the todo pane's goal badge: accent while active, danger
    // when blocked, muted otherwise (paused, or unreachable completed goals).
    const nextTone = goal?.phase === 'active'
      ? 'accent'
      : goal?.phase === 'blocked'
        ? 'danger'
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
