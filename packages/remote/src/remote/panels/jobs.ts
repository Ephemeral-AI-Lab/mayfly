/**
 * Current Mayfly Job summaries, roster, detail, and output presentations.
 * @module @ephemeral-ai/mayfly/remote/panels/jobs
 */

import { ui, type MayflyInlineSpan, type MayflyListItem, type MayflyPaneSummary, type MayflyTranslate, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { JobView } from '../features/official.ts'
import { remoteCountSummary, remoteItemSummary, remoteViewList } from './view-items.ts'

/** Job list control id shared by the status view and full browser. */
export const REMOTE_JOBS_LIST_ID = 'jobs-list'
/** Job stop action id shared by the status view and detail browser. */
export const REMOTE_JOB_STOP_ID = 'jobs-stop'

/** Whether a Job still has a non-terminal lifecycle state. */
export function isRemoteJobLive(job: JobView): boolean {
  return job.status === 'running' || job.status === 'stopping'
}

/** Sort live Jobs oldest first, then settled Jobs newest first. */
export function sortRemoteJobs(jobs: readonly JobView[]): readonly JobView[] {
  return [
    ...jobs.filter(isRemoteJobLive).toSorted((left, right) => left.startedAt - right.startedAt),
    ...jobs.filter(job => !isRemoteJobLive(job)).toSorted((left, right) => (right.finishedAt ?? right.startedAt) - (left.finishedAt ?? left.startedAt)),
  ]
}

/** Format one Job duration using the current compact Mayfly units. */
export function formatRemoteJobDuration(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1_000))
  if (seconds < 60) return `${String(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${String(minutes)}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${String(hours)}h` : `${String(hours)}h ${String(rest)}m`
}

/** Roster state consumed by the summary and selectable view. */
export interface RemoteJobsState {
  readonly jobs: readonly JobView[]
  readonly now: number
  readonly done?: { readonly total: number, readonly failed: boolean }
  readonly stoppedByUser?: ReadonlySet<string>
  readonly error?: string | undefined
}

/** Build the current Mayfly Jobs summary or an actionable roster failure. */
export function remoteJobsSummary(state: RemoteJobsState, t: MayflyTranslate): MayflyPaneSummary | null {
  const live = state.jobs.filter(isRemoteJobLive)
  if (live.length > 0) return { node: remoteCountSummary({ text: '●', tone: 'accent' }, t('jobs'), live.length) }
  if (state.done !== undefined) {
    const mark: MayflyInlineSpan = state.done.failed ? { text: '✕', tone: 'danger' } : { text: '✓', tone: 'success' }
    return { node: remoteItemSummary(mark, t('jobs'), state.done.total, state.done.total) }
  }
  if (state.error !== undefined) return { node: { kind: 'text', content: t('jobs unavailable'), tone: 'warning' } }
  return null
}

function markOf(job: JobView, stopped: boolean): MayflyInlineSpan {
  if (job.status === 'running') return { text: '●', tone: 'accent' }
  if (job.status === 'stopping') return { text: '●', tone: 'muted' }
  if (job.status === 'killed' || stopped) return { text: '⊘', tone: 'muted' }
  return job.status === 'failed' ? { text: '✕', tone: 'danger' } : { text: '✓', tone: 'success' }
}

function item(job: JobView, state: RemoteJobsState, t: MayflyTranslate): MayflyListItem {
  const stopped = job.status === 'killed' || state.stoppedByUser?.has(String(job.id)) === true
  const elapsed = formatRemoteJobDuration(job.startedAt, job.finishedAt ?? state.now)
  const trailing = isRemoteJobLive(job) ? job.progress : stopped ? undefined : job.detail
  const status = job.status === 'stopping' ? t('stopping') : stopped ? t('stopped') : ''
  const muted = (text: string | undefined): readonly MayflyInlineSpan[] => text === undefined || text === '' ? [] : [{ text, tone: 'muted' }]
  return {
    id: String(job.id),
    label: job.label,
    labelSpans: [markOf(job, stopped), { text: ' ' }],
    cells: [
      { spans: [{ text: job.label, tone: isRemoteJobLive(job) ? 'default' : 'muted' }], max: 40 },
      { spans: muted(trailing), max: 30, shed: 2 },
      { spans: muted(status) },
    ],
    right: muted(elapsed),
    unavailableActions: job.status === 'running' ? {} : { [REMOTE_JOB_STOP_ID]: job.status === 'stopping' ? t('Already stopping') : t('Already finished') },
  }
}

/** Build the current selectable Jobs view with revision-independent row ids. */
export function remoteJobsPanel(state: RemoteJobsState, t: MayflyTranslate): MayflyUiNode | null {
  const jobs = sortRemoteJobs(state.jobs)
  if (jobs.length === 0) return state.error === undefined ? null : ui.text(state.error, { tone: 'danger', overflow: 'wrap' })
  const actions = ui.actions({
    id: 'jobs-actions',
    items: [{
      id: REMOTE_JOB_STOP_ID,
      label: t('stop'),
      hidden: true,
      semantic: 'delete',
      hintLabel: t('stop'),
      selections: [{ pagePath: [], controlId: REMOTE_JOBS_LIST_ID }],
      confirm: { title: t('Stop this job?'), detail: t('The job is asked to end; its output stays readable.'), confirmLabel: t('Stop'), tone: 'danger' },
    }],
  })
  return remoteViewList(REMOTE_JOBS_LIST_ID, jobs.map(job => item(job, state, t)), actions)
}
