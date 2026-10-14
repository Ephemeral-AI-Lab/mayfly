/**
 * The Goal item of status row 2: a views pane whose summary (`● goal 2/8 1m 59s`: the mark, the rounds over their cap, and
 * the time) sits in the row and whose panel (the whole objective, a blocked goal's code and reason, and the keys of the
 * `/goal` subcommands: `r` resume, `p` pause, `e` edit, `c` clear) opens under the row while the view is entered. The mark is the phase (`●` active and armed, `○` active but disarmed,
 * `⏸` paused, `✕` blocked, `✓` complete); a goal that finishes keeps its item for a few seconds and then leaves.
 * Activation is process-local, so the item follows `goal/activation-changed` as well as the durable goal. The
 * registration is the Fiber's.
 *
 * @module @ephemeral-ai/mayfly/transcript/status-goal
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import { ui, type MayflyInlineSpan, type MayflyPaneSummary, type MayflyTone, type MayflyActionItem, type MayflyUiActionEvent, type MayflyUiActionReply, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyTranslate } from '../frontend/locale.ts'
import type { SessionFactsService } from './session-facts.ts'
import type { TickSource } from './tick.ts'
import { observeTranscriptLocale, transcriptTranslator } from './locale.ts'
import { itemSummary, viewPanel } from './view-items.ts'

/** Stable Cordis plugin name. */
export const name = 'mayfly-status-goal'

/** Native and Mayfly services required by the view. */
export const inject = ['mayflyPanes', 'mayflyCurrentAgent', 'mayflyScreen', 'mayflySessionFacts', 'mayflyTick', 'goals']

/** The goal view's place in the status row: after the model, the chips, the directory, git, and jobs; before todo. */
const VIEW_PRIORITY = 12

/** How long the finished goal's item stays before it leaves. */
export const GOAL_DONE_LINGER_MS = 5000

/** The mark and tone of each state the item shows. */
const MARK = {
  armed: { text: '●', tone: 'accent' },
  disarmed: { text: '○', tone: 'muted' },
  paused: { text: '⏸', tone: 'muted' },
  blocked: { text: '✕', tone: 'danger' },
} as const satisfies Record<string, { readonly text: string, readonly tone: MayflyTone }>

type Shown = GoalView & { readonly phase: 'active' | 'paused' | 'blocked' }

/** A goal the item shows: one that is neither absent nor complete. */
function shown(goal: GoalView | undefined): Shown | undefined {
  return goal === undefined || goal.phase === 'complete' ? undefined : goal as Shown
}

function markOf(goal: Shown): MayflyInlineSpan {
  const mark = MARK[goal.phase === 'active' ? goal.activation === 'armed' ? 'armed' : 'disarmed' : goal.phase]
  return { text: mark.text, tone: mark.tone }
}

/** What the item renders from. */
export interface GoalItemState {
  /** The current goal, if any. */
  readonly goal: GoalView | undefined
  /** The goal that just completed: its rounds and how long it took; it leaves the row after {@link GOAL_DONE_LINGER_MS}. */
  readonly done?: { readonly rounds: number, readonly total: number, readonly elapsedMs: number }
  /** The time the elapsed figure is measured against. */
  readonly now: number
}

/**
 * The row-2 summary: its mark, `goal`, the rounds over their cap, and the time: `● goal 2/8 1m 59s`. An armed goal's time
 * runs; any other state shows the time it had at its last change. Just completed it is `✓ goal 2/8 1m 59s`. The
 * objective and the state in words are the panel's.
 * @param state - the goal.
 * @param t - translator for the label.
 * @returns the summary, or `null` for no goal.
 */
export function goalSummary(state: GoalItemState, t: MayflyTranslate): MayflyPaneSummary | null {
  if (state.done !== undefined) {
    const { rounds, total, elapsedMs } = state.done
    return { node: itemSummary({ text: '✓', tone: 'success' }, t('goal'), rounds, total, elapsedMs) }
  }
  const current = shown(state.goal)
  if (current === undefined) return null
  const elapsed = (current.phase === 'active' && current.activation === 'armed' ? state.now : current.updatedAt) - current.createdAt
  return { node: itemSummary(markOf(current), t('goal'), current.roundsStarted, current.maxGoalRounds, elapsed) }
}

/** The id of an action, fenced to the goal revision the panel was built for. */
const actionId = (verb: GoalVerb, revision: number): string => `goal-${verb}:${String(revision)}`

type GoalVerb = 'resume' | 'pause' | 'edit' | 'clear'

/**
 * The `/goal` subcommands as single letters, none drawn as a button: `r` resume (a goal that waits: paused, blocked, or
 * active but disarmed, while rounds remain), `p` pause (an armed one), `e` edit (the objective, in the prompt), and `c`
 * clear (behind the shared Yes/No). The hint row names the ones that apply.
 * @param goal - the goal the panel shows.
 * @param t - translator for the words.
 * @returns the hidden `actions` node that carries the keys.
 */
function goalKeys(goal: Shown, t: MayflyTranslate): MayflyUiNode {
  const waiting = goal.phase !== 'active' || goal.activation === 'disarmed'
  const resumable = waiting && goal.roundsStarted < goal.maxGoalRounds
  const keyed = (verb: GoalVerb, key: string, word: string): MayflyActionItem => ({ id: actionId(verb, goal.revision), label: word, hidden: true, key, hintLabel: word })
  return ui.actions({
    id: 'goal-actions',
    items: [
      ...resumable ? [keyed('resume', 'r', t('resume'))] : [],
      ...!waiting ? [keyed('pause', 'p', t('pause'))] : [],
      keyed('edit', 'e', t('edit')),
      { ...keyed('clear', 'c', t('clear')), confirm: { title: t('Clear the goal?'), detail: t('Its history stays in the session log.'), confirmLabel: t('Clear'), tone: 'danger' } },
    ],
  })
}

/**
 * The panel: the whole objective and a blocked goal's code and reason, in the fixed-length scroll every item shares, with
 * no heading, count, or time (the cell says them), and the goal's keys (`r`, `p`, `e`, `c`) beside the scroll. There is no
 * panel once the goal has completed.
 * @param state - the goal.
 * @param t - translator for the words.
 * @returns the panel node, or `null` for no goal or a finished one.
 */
export function goalPanel(state: GoalItemState, t: MayflyTranslate): MayflyUiNode | null {
  const current = shown(state.goal)
  if (current === undefined) return null
  return viewPanel('goal-panel', [
    ui.richText([{ text: `  ${current.objective}` }]),
    ...current.phase === 'blocked' && current.blockedReason !== undefined
      ? [ui.richText([{ text: `  ${t('blocked · {code}', { code: current.blockedReason.code })}: `, tone: 'danger' }, { text: current.blockedReason.message, tone: 'muted' }])]
      : [],
  ], goalKeys(current, t))
}

/** Register the Goal item under the calling Fiber. */
export function apply(ctx: Context): void {
  const t = transcriptTranslator(ctx, 'transcript')
  const tick = ctx.get('mayflyTick') as TickSource | undefined
  /**
   * A button of the panel: the `/goal` subcommand of the same name on the exact current Agent and goal. An action built for
   * an older revision (the goal changed under the open panel) is refused, never applied to the newer goal.
   */
  const act = (event: MayflyUiActionEvent): MayflyUiActionReply => {
    if (event.kind !== 'activate') return { kind: 'completed' }
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
  /** The clock runs while an armed goal's elapsed time moves or the closing item is up. */
  const syncTick = (): void => {
    const needed = done !== undefined || (goal?.phase === 'active' && goal.activation === 'armed')
    if (!needed) { offTick?.(); offTick = undefined; return }
    offTick ??= tick?.subscribe((at) => {
      now = at
      if (done !== undefined && at - done.at >= GOAL_DONE_LINGER_MS) { done = undefined; tracked = undefined }
      publish()
    })
  }
  const publish = (): void => {
    syncTick()
    const state: GoalItemState = { goal, now, ...done === undefined ? {} : { done: { rounds: done.rounds, total: done.total, elapsedMs: done.elapsedMs } } }
    const summary = goalSummary(state, t)
    const panel = goalPanel(state, t)
    const key = JSON.stringify([summary, panel])
    if (key === published) return
    published = key
    pane.set(panel)
    pane.setSummary(summary)
  }
  const derive = (): void => {
    const agent = ctx.mayflyCurrentAgent.current()
    let next: GoalView | undefined
    try {
      next = agent === null ? undefined : ctx.goals.get(agent)
    } catch (error) {
      ctx.logger.warn(`could not read current goal for the goal view: ${error instanceof Error ? error.message : String(error)}`)
    }
    now = Date.now()
    if (next?.phase === 'complete') {
      if (tracked === next.id && done === undefined) done = { rounds: next.roundsStarted, total: next.maxGoalRounds, elapsedMs: next.updatedAt - next.createdAt, at: now }
    } else {
      tracked = next?.id
      done = undefined
    }
    goal = next
    publish()
  }
  const facts = ctx.get('mayflySessionFacts') as SessionFactsService
  const offGoal = facts.subscribeGoal(() => derive())
  const offAgent = ctx.mayflyCurrentAgent.subscribe(() => derive())
  const offLocale = observeTranscriptLocale(ctx, () => { published = ''; derive() })
  ctx.on('goal/changed', ({ agent }) => {
    if (agent === ctx.mayflyCurrentAgent.current()) derive()
  })
  // Activation is process-local and not in the projection: the driver or a cancel disarms without a durable change.
  ctx.on('goal/activation-changed', () => { derive() })
  ctx.on('agent/created', ({ agent }) => {
    if (agent === ctx.mayflyCurrentAgent.current()) derive()
  })
  derive()
  ctx.effect(() => () => {
    offGoal()
    offAgent()
    offLocale()
    offTick?.()
    pane.dispose()
  })
}
