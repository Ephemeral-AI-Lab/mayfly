/** Readonly reference Goal status summary and revision-carrying actions. @module */
import { ui, type MayflyInlineSpan, type MayflyPaneSummary, type MayflyTone, type MayflyActionItem, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyTranslate } from '../frontend/locale.ts'
import { itemSummary, viewPanel } from './view-items.ts'

/** Native readonly Goal facts needed by either frontend's status renderer. */
export interface GoalPresentation {
  readonly id: string
  readonly revision: number
  readonly objective: string
  readonly phase: 'active' | 'paused' | 'blocked' | 'complete'
  readonly blockedReason?: { readonly code: string, readonly message: string }
  readonly roundsStarted: number
  readonly maxGoalRounds: number
  readonly activation: 'armed' | 'disarmed'
}

/** How long the finished goal summary remains visible. */
export const GOAL_DONE_LINGER_MS = 5000

/** The mark and tone of each state the item shows. */
const MARK = {
  armed: { text: '●', tone: 'accent' },
  disarmed: { text: '○', tone: 'muted' },
  paused: { text: '⏸', tone: 'muted' },
  blocked: { text: '✕', tone: 'danger' },
} as const satisfies Record<string, { readonly text: string, readonly tone: MayflyTone }>

type Shown = GoalPresentation & { readonly phase: 'active' | 'paused' | 'blocked' }

/** A goal the item shows: one that is neither absent nor complete. */
function shown(goal: GoalPresentation | undefined): Shown | undefined {
  return goal === undefined || goal.phase === 'complete' ? undefined : goal as Shown
}

function markOf(goal: Shown): MayflyInlineSpan {
  const mark = MARK[goal.phase === 'active' ? goal.activation === 'armed' ? 'armed' : 'disarmed' : goal.phase]
  return { text: mark.text, tone: mark.tone }
}

/** What the item renders from. */
export interface GoalItemState {
  /** The current goal, if any. */
  readonly goal: GoalPresentation | undefined
  /** The goal that just completed: its rounds over their cap; it leaves the row after {@link GOAL_DONE_LINGER_MS}. */
  readonly done?: { readonly rounds: number, readonly total: number }
}

/**
 * The item in the row: its mark, `goal`, and the rounds over their cap: `● goal 2/8`. Just completed it is `✓ goal 2/8`.
 * The objective and the state in words are the panel's.
 * @param state - the goal.
 * @param t - translator for the label.
 * @returns the summary, or `null` for no goal.
 */
export function goalSummary(state: GoalItemState, t: MayflyTranslate): MayflyPaneSummary | null {
  if (state.done !== undefined) {
    const { rounds, total } = state.done
    return { node: itemSummary({ text: '✓', tone: 'success' }, t('goal'), rounds, total) }
  }
  const current = shown(state.goal)
  if (current === undefined) return null
  return { node: itemSummary(markOf(current), t('goal'), current.roundsStarted, current.maxGoalRounds) }
}

/** The id of an action, fenced to the goal revision the panel was built for. */
const actionId = (verb: GoalVerb, revision: number): string => `goal-${verb}:${String(revision)}`

/** Reference status action verbs, with revision checks owned by each frontend. */
export type GoalVerb = 'resume' | 'pause' | 'edit' | 'clear'

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
 * no heading, count, or time, and the goal's keys (`r`, `p`, `e`, `c`) beside the scroll. There is no
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

