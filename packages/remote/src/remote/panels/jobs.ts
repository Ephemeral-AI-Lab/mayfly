/**
 * Current Mayfly Job summaries, roster, detail, and output presentations.
 * @module @ephemeral-ai/mayfly/remote/panels/jobs
 */

import { panel, ui, type MayflyInlineSpan, type MayflyListItem, type MayflyPaneSummary, type MayflyTone, type MayflyTranslate, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { JobView } from '../features/official.ts'
import { remoteCountSummary, remoteItemSummary, remoteViewList } from './view-items.ts'

/** Job list control id shared by the status view and full browser. */
export const REMOTE_JOBS_LIST_ID = 'jobs-list'
/** Job stop action id shared by the status view and detail browser. */
export const REMOTE_JOB_STOP_ID = 'jobs-stop'
/** Job output action id used by the detail browser. */
export const REMOTE_JOB_READ_ID = 'jobs-read'

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

const STATUS_TONE: Readonly<Record<JobView['status'], MayflyTone>> = {
  running: 'primary', stopping: 'warning', completed: 'success', killed: 'muted', failed: 'danger',
}

/** Build one Job detail page with explicit output and stop actions. */
export function remoteJobDetailsNode(job: JobView, t: MayflyTranslate): MayflyUiNode {
  return panel({
    title: t('Job {id}', { id: String(job.id) }),
    escapeLabel: 'back',
    body: ui.stack.column([
      ui.fields([
        { label: t('Name'), value: [{ text: job.label }] },
        { label: t('Status'), value: [{ text: t(job.status), tone: STATUS_TONE[job.status]! }] },
        ...job.detail === undefined ? [] : [{ label: t('Detail'), value: [{ text: job.detail }] }],
      ]),
      ui.actions({ id: 'job-actions', items: [
        { id: REMOTE_JOB_READ_ID, label: t('Read output'), hintLabel: t('output'), key: 'o', hidden: true },
        {
          id: REMOTE_JOB_STOP_ID,
          label: t('Stop job'),
          hintLabel: t('stop'),
          key: 'x',
          hidden: true,
          intent: 'danger',
          disabled: job.status !== 'running',
          ...job.status === 'running' ? {} : { disabledReason: t(job.status) },
          confirm: t('Stop {job}?', { job: job.label }),
        },
      ] }),
    ]),
  })
}

/** Bounded output document and loss marker for one followed Job. */
export interface RemoteJobOutputView {
  readonly text: string
  readonly dropped: boolean
  readonly streaming: boolean
  readonly error?: string | undefined
}

/** Build one output reader with offset-loss and terminal-observation states. */
export function remoteJobOutputNode(job: JobView, feed: RemoteJobOutputView, t: MayflyTranslate): MayflyUiNode {
  return panel({
    title: t('Job {id}', { id: String(job.id) }),
    escapeLabel: 'back',
    body: ui.stack.column([
      ui.fields([{ label: t('Status at read'), value: [{ text: t(job.status), tone: STATUS_TONE[job.status]! }] }]),
      ...feed.dropped ? [ui.text(t('(earlier output was dropped by retention)'), { tone: 'muted' })] : [],
      ...feed.error === undefined ? [] : [ui.text(feed.error, { tone: 'danger', overflow: 'wrap' })],
      ui.child(ui.scroll(feed.text === ''
        ? ui.text(t(isRemoteJobLive(job) && feed.streaming ? '(no output yet)' : '(no output)'), { tone: 'muted' })
        : ui.code(feed.text), { id: 'job-output-document', scrollbar: true, follow: 'end' }), { basis: 0, grow: 1, minSize: 1 }),
    ]),
  })
}
