/**
 * The Goal item of the status row: a views pane whose summary (`● goal 2/8`: the mark, the rounds over their cap) sits in the row and whose panel (the whole objective, a blocked goal's code and reason, and the keys of the
 * `/goal` subcommands: `r` resume, `p` pause, `e` edit, `c` clear) opens under the row while the view is entered. The mark is the phase (`●` active and armed, `○` active but disarmed,
 * `⏸` paused, `✕` blocked, `✓` complete); a goal that finishes keeps its item for a few seconds and then leaves.
 * The durable goal comes from the native `goal` projection; the process-local activation is read from `ctx.goals`,
 * which also owns every write. The registration is the Fiber's.
 *
 * @module @ephemeral-ai/mayfly/transcript/status-goal
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GoalProjection, GoalView } from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MayflyUiActionEvent, MayflyUiEventContext, MayflyUiActionReply } from '@ephemeral-ai/mayfly-ui'
import type { TickSource } from './tick.ts'
import { observeTranscriptLocale, transcriptTranslator } from './locale.ts'
import { goalPanel, goalSummary, GOAL_DONE_LINGER_MS, type GoalItemState } from './goal-model.ts'
export { goalPanel, goalSummary, GOAL_DONE_LINGER_MS, type GoalItemState } from './goal-model.ts'

/** Stable Cordis plugin name. */
export const name = 'mayfly-status-goal'

/** Native and Mayfly services required by the view. */
export const inject = ['mayflyPanes', 'mayflyCurrentAgent', 'mayflyScreen', 'mayflyTick', 'goals', 'sessionProjections']

/** The goal view's place in the status row: after the model, the chips, the directory, git, agents, and jobs; before todo. */
const VIEW_PRIORITY = 13

/**
 * Read one exact Agent's current goal: the durable value from the native
 * `goal` projection, and the process-local activation from the goal service
 * that owns writes. A service read failure leaves the durable view disarmed
 * rather than hiding a goal the log still holds.
 * @param ctx - plugin context.
 * @param agent - the exact selected Agent.
 * @returns the merged view, or undefined without a current goal.
 */
function readGoal(ctx: Context, agent: Agent): GoalView | undefined {
  const projected = ctx.sessionProjections.snapshot(agent.session, ['goal']).values.goal as GoalProjection | null | undefined
  if (projected === undefined || projected === null) return undefined
  let activation: GoalView['activation'] = 'disarmed'
  try {
    activation = ctx.goals.get(agent)?.activation ?? 'disarmed'
  } catch (error) {
    ctx.logger.warn(`could not read current goal activation: ${error instanceof Error ? error.message : String(error)}`)
  }
  return {
    ...projected.goal,
    roundsStarted: projected.roundsStarted,
    createdAt: projected.createdAt,
    updatedAt: projected.updatedAt,
    activation,
  }
}

/** Register the Goal item under the calling Fiber. */
export function apply(ctx: Context): void {
  const t = transcriptTranslator(ctx, 'transcript')
  const tick = ctx.get('mayflyTick') as TickSource | undefined
  let unloaded = false
  /**
   * A button of the panel: the `/goal` subcommand of the same name on the exact current Agent and goal. An action built for
   * an older revision (the goal changed under the open panel) is refused, never applied to the newer goal.
   */
  const act = (event: MayflyUiActionEvent, context: MayflyUiEventContext): MayflyUiActionReply => {
    if (event.kind !== 'activate') return { kind: 'completed' }
    if (unloaded || context.signal.aborted) return { kind: 'cancelled' }
    const [verb, revision] = event.actionId.replace(/^goal-/u, '').split(':')
    const agent = ctx.mayflyCurrentAgent.current()
    try {
      const view = agent === null ? undefined : ctx.goals.get(agent)
      if (agent === null || view === undefined || String(view.revision) !== revision) return { kind: 'failed', message: t('The goal changed; open it again') }
      if (verb === 'resume') ctx.goals.resume(agent, view)
      else if (verb === 'pause') ctx.goals.pause(agent, view)
      else if (verb === 'clear') ctx.goals.clear(agent, view)
      else if (verb === 'edit') {
        // `/goal edit` takes the replacement inline: the objective goes to the prompt for the person to change and send.
        const editor = ctx.get('mayflyPromptEditor')?.current?.editor
        if (editor === undefined) return { kind: 'failed', message: t('The prompt is not available') }
        ctx.mayflyScreen.leaveViews()
        editor.setText(`/goal edit ${view.objective}`)
      } else return { kind: 'failed', message: t('Unknown goal action') }
      return { kind: 'completed' }
    } catch (error) {
      return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
    }
  }
  const pane = ctx.mayflyPanes.register({ id: 'mayfly.view.goal', placement: 'views', priority: VIEW_PRIORITY, onEvent: { action: act } }, null)
  let goal: GoalView | undefined
  let done: (NonNullable<GoalItemState['done']> & { readonly at: number }) | undefined
  /** The goal id the item has shown in progress, so a goal that is already complete when a session loads shows nothing. */
  let tracked: string | undefined
  let now = Date.now()
  let published = ''
  let offTick: (() => void) | undefined
  /** The clock runs while the closing item is up. */
  const syncTick = (): void => {
    if (done === undefined) { offTick?.(); offTick = undefined; return }
    offTick ??= tick?.subscribe((at) => {
      now = at
      if (done !== undefined && at - done.at >= GOAL_DONE_LINGER_MS) { done = undefined; tracked = undefined }
      publish()
    })
  }
  const publish = (): void => {
    if (unloaded) return
    syncTick()
    const state: GoalItemState = { goal, ...done === undefined ? {} : { done: { rounds: done.rounds, total: done.total } } }
    const summary = goalSummary(state, t)
    const panel = goalPanel(state, t)
    const key = JSON.stringify([summary, panel])
    if (key === published) return
    published = key
    pane.set(panel)
    pane.setSummary(summary)
  }
  const derive = (): void => {
    if (unloaded) return
    const agent = ctx.mayflyCurrentAgent.current()
    let next: GoalView | undefined
    try {
      next = agent === null ? undefined : readGoal(ctx, agent)
    } catch (error) {
      ctx.logger.warn(`could not read current goal for the goal view: ${error instanceof Error ? error.message : String(error)}`)
    }
    now = Date.now()
    if (next?.phase === 'complete') {
      if (tracked === next.id && done === undefined) done = { rounds: next.roundsStarted, total: next.maxGoalRounds, at: now }
    } else {
      tracked = next?.id
      done = undefined
    }
    goal = next
    publish()
  }
  const offAgent = ctx.mayflyCurrentAgent.subscribe(() => derive())
  // The projection feed is the durable goal's only source; activation is a
  // process-local edge with no durable projection value.
  const offProjection = ctx.sessionProjections.onChanged((session, key) => {
    if (unloaded || key !== 'goal' || session !== ctx.mayflyCurrentAgent.current()?.session) return
    derive()
  })
  const offLocale = observeTranscriptLocale(ctx, () => { published = ''; derive() })
  const offActivation = ctx.on('goal/activation-changed', ({ sessionId }) => {
    if (String(sessionId) !== String(ctx.mayflyCurrentAgent.current()?.session.id)) return
    derive()
  })
  ctx.on('agent/created', ({ agent }) => {
    if (agent === ctx.mayflyCurrentAgent.current()) derive()
  })
  derive()
  ctx.effect(() => () => {
    unloaded = true
    offAgent()
    offProjection()
    offActivation()
    offLocale()
    offTick?.()
    pane.dispose()
  })
}
