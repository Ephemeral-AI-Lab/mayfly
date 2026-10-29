/**
 * Current Mayfly Goal summary, objective panel, and revision-carrying actions.
 * @module @ephemeral-ai/mayfly/remote/panels/goal
 */

import type { HostClient } from '../../client/types.ts'
import { ui, type MayflyPaneSummary, type MayflyTone, type MayflyTranslate, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { remoteItemSummary, remoteViewPanel } from './view-items.ts'

/** Exact revision-checked Goal reference accepted by the generated namespace. */
export type RemoteGoalRef = Parameters<HostClient['remote']['goals']['pause']>[1]

/** Client-safe Goal fields consumed by the Remote view. */
export interface RemoteGoalView extends RemoteGoalRef {
  readonly objective: string
  readonly phase: 'active' | 'paused' | 'blocked' | 'complete'
  readonly blockedReason?: { readonly code: string, readonly message: string }
  readonly maxGoalRounds: number
  readonly roundsStarted: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly activation: 'armed' | 'disarmed'
}

/** Goal view state, including the short-lived completion summary. */
export interface RemoteGoalItemState {
  readonly goal: RemoteGoalView | undefined
  readonly done?: { readonly rounds: number, readonly total: number }
}

/** Actions offered for a non-complete Goal. */
export type RemoteGoalVerb = 'resume' | 'pause' | 'edit' | 'complete' | 'clear'

const MARK = {
  armed: { text: '●', tone: 'accent' },
  disarmed: { text: '○', tone: 'muted' },
  paused: { text: '⏸', tone: 'muted' },
  blocked: { text: '✕', tone: 'danger' },
} as const satisfies Record<string, { readonly text: string, readonly tone: MayflyTone }>

type ShownGoal = RemoteGoalView & { readonly phase: 'active' | 'paused' | 'blocked' }

/** Return the Goal that should retain an interactive panel. */
export function remoteShownGoal(goal: RemoteGoalView | undefined): ShownGoal | undefined {
  return goal === undefined || goal.phase === 'complete' ? undefined : goal as ShownGoal
}

/** Encode the action's expected Goal revision in its id. */
export function remoteGoalActionId(verb: RemoteGoalVerb, revision: number): string {
  return `goal-${verb}:${String(revision)}`
}

/** Build the current Mayfly Goal summary. */
export function remoteGoalSummary(state: RemoteGoalItemState, t: MayflyTranslate): MayflyPaneSummary | null {
  if (state.done !== undefined) {
    return { node: remoteItemSummary({ text: '✓', tone: 'success' }, t('goal'), state.done.rounds, state.done.total) }
  }
  const current = remoteShownGoal(state.goal)
  if (current === undefined) return null
  const key = current.phase === 'active' ? current.activation : current.phase
  return { node: remoteItemSummary(MARK[key], t('goal'), current.roundsStarted, current.maxGoalRounds) }
}

/** Build the current Mayfly Goal objective panel and revision-fenced actions. */
export function remoteGoalPanel(state: RemoteGoalItemState, t: MayflyTranslate): MayflyUiNode | null {
  const current = remoteShownGoal(state.goal)
  if (current === undefined) return null
  const waiting = current.phase !== 'active' || current.activation === 'disarmed'
  const resumable = waiting && current.roundsStarted < current.maxGoalRounds
  const keyed = (verb: RemoteGoalVerb, key: string, word: string) => ({
    id: remoteGoalActionId(verb, current.revision),
    label: word,
    hidden: true,
    key,
    hintLabel: word,
  })
  const actions = ui.actions({
    id: 'goal-actions',
    items: [
      ...resumable ? [keyed('resume', 'r', t('resume'))] : [],
      ...!waiting ? [keyed('pause', 'p', t('pause'))] : [],
      keyed('edit', 'e', t('edit')),
      keyed('complete', 'm', t('complete')),
      {
        ...keyed('clear', 'c', t('clear')),
        confirm: { title: t('Clear the goal?'), detail: t('Its history stays in the session log.'), confirmLabel: t('Clear'), tone: 'danger' },
      },
    ],
  })
  return remoteViewPanel('goal-panel', [
    ui.richText([{ text: `  ${current.objective}` }]),
    ...current.phase === 'blocked' && current.blockedReason !== undefined
      ? [ui.richText([{ text: `  ${t('blocked · {code}', { code: current.blockedReason.code })}: `, tone: 'danger' }, { text: current.blockedReason.message, tone: 'muted' }])]
      : [],
  ], actions)
}
