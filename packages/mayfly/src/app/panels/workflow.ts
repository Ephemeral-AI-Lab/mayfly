/**
 * The Workflow view over the Host's complete run snapshot: what the status item counts, and a panel with one line per run
 * above its members. A settled run stays for a short hold, by its own end time, so a resumed session shows old runs nowhere.
 * @module @ephemeral-ai/mayfly/app/panels/workflow
 */

import { ui, type MayflyInlineSpan, type MayflyListItem, type MayflyPaneSummary, type MayflyTranslate, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyWorkflowRun, MayflyWorkflowSnapshot } from '../../hosts/host-contract.ts'
import { compactElapsedMs } from '../../transcript/agent-presentation.ts'
import { remoteItemSummary, remoteViewList } from './view-items.ts'

/** The list control of the panel. */
export const WORKFLOW_VIEW_LIST_ID = 'workflow-view'
/** The stop action of the panel. */
export const WORKFLOW_VIEW_STOP_ID = 'workflow-view-stop'

/** How long a settled run stays in the view. */
const SETTLE_HOLD_MS = 5_000
/** The most runs the panel heads, so concurrent runs cannot crowd out their members. */
const MAX_RUNS = 3

type Outcome = NonNullable<MayflyWorkflowRun['agents'][number]['outcome']>
const SEVERITY: readonly Outcome[] = ['failed', 'cancelled', 'completed']
const MARKS: Readonly<Record<Outcome | 'running', MayflyInlineSpan>> = {
  running: { text: '●', tone: 'accent' },
  completed: { text: '✓', tone: 'success' },
  failed: { text: '✕', tone: 'danger' },
  cancelled: { text: '⊘', tone: 'muted' },
}

/** Whether a run still works. A Session that ended under a run leaves it interrupted, which is over. */
export function isWorkflowRunLive(run: MayflyWorkflowRun): boolean {
  return run.stopReason === undefined && run.interrupted !== true
}

/** How a settled run ended, in the words of its members. */
function outcomeOf(run: MayflyWorkflowRun): Outcome {
  if (run.stopReason === 'completed') return 'completed'
  return run.stopReason === 'error' ? 'failed' : 'cancelled'
}

/**
 * The runs the view shows: live ones first, then those still in their hold.
 * @param snapshot - the Host's snapshot.
 * @param now - the time.
 * @returns at most three runs.
 */
export function shownWorkflowRuns(snapshot: MayflyWorkflowSnapshot | undefined, now: number): readonly MayflyWorkflowRun[] {
  const runs = snapshot?.runs ?? []
  const held = runs.filter(run => !isWorkflowRunLive(run) && now - (run.endedAt ?? run.startedAt) < SETTLE_HOLD_MS)
  return [...runs.filter(isWorkflowRunLive), ...held].slice(0, MAX_RUNS)
}

const isSettled = (run: MayflyWorkflowRun, agent: MayflyWorkflowRun['agents'][number]): boolean => agent.outcome !== undefined || !isWorkflowRunLive(run)

/**
 * The item in the status row: `● workflow 3/6`, settled over started.
 * @param runs - the shown runs.
 * @param t - the translator.
 * @returns the summary, absent with no runs.
 */
export function workflowSummary(runs: readonly MayflyWorkflowRun[], t: MayflyTranslate): MayflyPaneSummary | null {
  if (runs.length === 0) return null
  const agents = runs.flatMap(run => run.agents.map(agent => isSettled(run, agent)))
  const outcome = SEVERITY.find(candidate => runs.some(run => outcomeOf(run) === candidate))!
  const mark = runs.some(isWorkflowRunLive) ? MARKS.running : MARKS[outcome]
  return { node: remoteItemSummary(mark, t('workflow'), agents.filter(Boolean).length, agents.length) }
}

function phaseSegment(run: MayflyWorkflowRun, t: MayflyTranslate): string | undefined {
  const phases = run.phases
  if (phases === undefined || phases.length === 0 || run.currentPhase === undefined) return undefined
  const index = phases.findIndex(phase => phase.title === run.currentPhase)
  const current = index >= 0 ? index + 1 : Math.max(1, run.phasesSeen.filter(title => phases.some(phase => phase.title === title)).length)
  return t('phase {current}/{total}', { current, total: phases.length })
}

/** One run's line: `audit-deps · verify · phase 2/3 · 12s`, or `audit-deps · completed · 7 agents · 19s`. */
function runLine(run: MayflyWorkflowRun, now: number, t: MayflyTranslate): MayflyUiNode {
  const live = isWorkflowRunLive(run)
  const elapsed = compactElapsedMs(Math.max(0, (live ? now : run.endedAt ?? run.startedAt) - run.startedAt))
  const count = run.agentsStarted ?? run.agents.length
  const parts = live
    ? [run.currentPhase, phaseSegment(run, t), elapsed]
    : [t(outcomeOf(run)), t(count === 1 ? '{count} agent' : '{count} agents', { count }), elapsed]
  const text = parts.filter((part): part is string => part !== undefined).map(part => ` · ${part}`).join('')
  return ui.richText([{ text: '  ' }, { text: run.name, styles: ['strong'] }, { text, tone: 'muted' }])
}

function memberRow(run: MayflyWorkflowRun, agent: MayflyWorkflowRun['agents'][number], blocked: string | undefined): MayflyListItem {
  const state = agent.outcome ?? (isWorkflowRunLive(run) ? 'running' : 'cancelled')
  return {
    id: String(agent.childId),
    label: agent.label,
    labelSpans: [MARKS[state], { text: ' ' }],
    cells: [
      { spans: [{ text: agent.label }], max: 40 },
      { spans: agent.phase === undefined ? [] : [{ text: agent.phase, tone: 'muted' }], shed: 1 },
    ],
    unavailableActions: blocked === undefined ? {} : { [WORKFLOW_VIEW_STOP_ID]: blocked },
  }
}

/**
 * The panel: a line per run, then every member, those still working first and then the latest to finish.
 * @param runs - the shown runs.
 * @param blocked - why the stop action would refuse a run, translated.
 * @param now - the time.
 * @param t - the translator.
 * @returns the panel, absent with no runs.
 */
export function workflowPanel(runs: readonly MayflyWorkflowRun[], blocked: (run: MayflyWorkflowRun) => string | undefined, now: number, t: MayflyTranslate): MayflyUiNode | null {
  if (runs.length === 0) return null
  const members = runs.flatMap(run => run.agents.map(agent => ({ run, agent })))
  const working = members.filter(member => !isSettled(member.run, member.agent))
  const settled = members.filter(member => isSettled(member.run, member.agent)).toReversed()
  return remoteViewList(WORKFLOW_VIEW_LIST_ID, [...working, ...settled].map(({ run, agent }) => memberRow(run, agent, blocked(run))), ui.actions({
    id: 'workflow-view-actions',
    items: [{
      id: WORKFLOW_VIEW_STOP_ID,
      label: t('stop'),
      hidden: true,
      semantic: 'delete',
      hintLabel: t('stop'),
      selections: [{ pagePath: [], controlId: WORKFLOW_VIEW_LIST_ID }],
      confirm: { title: t('Stop this workflow?'), detail: t('Its job is asked to end; the agents it started stay browsable.'), confirmLabel: t('Stop'), tone: 'danger' },
    }],
  }), runs.map(run => runLine(run, now, t)))
}
