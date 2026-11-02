/** Readonly rc.2 Job list, detail and output presentation for native and Remote owners.
 * @module @ephemeral-ai/mayfly/interaction/jobs-model
 */
import type { JobView } from '@deepseek-ai/dsh-jobs'
import { panel, ui, type MayflyContentChunk, type MayflyListItem, type MayflyTone, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyTranslate } from '../frontend/locale.ts'
const STATUS_TONE: Readonly<Record<JobView['status'], MayflyTone>> = { running: 'primary', stopping: 'warning', completed: 'success', killed: 'muted', failed: 'danger' }

export function isLiveJob(job: JobView): boolean { return job.status === 'running' || job.status === 'stopping' }

export function sortJobs(jobs: readonly JobView[]): readonly JobView[] {
  return [...jobs.filter(isLiveJob).toSorted((a, b) => a.startedAt - b.startedAt), ...jobs.filter(job => !isLiveJob(job)).toSorted((a, b) => (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt))]
}

export function formatJobDuration(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60), rest = minutes % 60
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
}

export function jobItems(jobs: readonly JobView[], now: number, t: MayflyTranslate): readonly MayflyListItem[] {
  return sortJobs(jobs).map(job => ({
    id: String(job.id), label: job.label,
    cells: [
      { spans: [{ text: t(job.status), tone: STATUS_TONE[job.status] }], min: 10, shed: 2 },
      { spans: [{ text: String(job.id) }], min: 8, shed: 3 },
      { spans: [{ text: formatJobDuration(job.startedAt, job.finishedAt ?? now) }], align: 'right', min: 6 },
    ],
    ...job.detail === undefined ? {} : { detail: job.detail },
    searchText: [job.label, job.id, job.detail, t(job.status)].filter(value => value !== undefined).join(' '),
  }))
}

/** The job detail page: status fields and the hidden keys that read output or stop a live job. */
export function jobDetailsNode(job: JobView, t: MayflyTranslate): MayflyUiNode {
  return panel({ title: t('Job {id}', { id: String(job.id) }), escapeLabel: 'back', body: ui.stack.column([
    ui.fields([
      { label: t('Name'), value: [{ text: job.label }] },
      { label: t('Status'), value: [{ text: t(job.status), tone: STATUS_TONE[job.status] }] },
      ...job.detail === undefined ? [] : [{ label: t('Detail'), value: [{ text: job.detail }] }],
    ]),
    ui.actions({ id: 'job-actions', items: [
      { id: 'read', label: t('Read output'), hintLabel: t('output'), key: 'o', hidden: true },
      { id: 'stop', label: t('Stop job'), hintLabel: t('stop'), key: 'x', hidden: true, intent: 'danger', disabled: job.status !== 'running', ...job.status === 'running' ? {} : { disabledReason: t(job.status) }, confirm: t('Stop {job}?', { job: job.label }) },
    ] }),
  ]) })
}

export function jobOutputNode(job: JobView, feed: { readonly dropped: boolean, readonly chunks: readonly MayflyContentChunk[] }, t: MayflyTranslate, escapeLabel: 'close' | 'back' = 'back'): MayflyUiNode {
  return panel({ title: t('Job {id}', { id: String(job.id) }), escapeLabel, body: ui.stack.column([
    ui.fields([{ label: t('Status at read'), value: [{ text: t(job.status), tone: STATUS_TONE[job.status] }] }]),
    ...feed.dropped ? [ui.text(t('(earlier output was dropped by retention)'), { tone: 'muted' })] : [],
    ui.child(ui.scroll(feed.chunks.length === 0 ? ui.text(t(isLiveJob(job) ? '(no output yet)' : '(no output)'), { tone: 'muted' }) : ui.code([...feed.chunks]), { id: 'job-output-document', scrollbar: true, follow: 'end' }), { basis: 0, grow: 1, minSize: 1 }),
  ]) })
}

/** The list page of the single jobs panel. */
export function jobListPanel(rows: readonly JobView[], available: boolean, t: MayflyTranslate): MayflyUiNode {
  return panel({ title: t('Jobs'), escapeLabel: 'close', body: ui.stack.column([
    ...available ? [] : [ui.text(t('Job registry unavailable'), { tone: 'danger' })],
    ui.list({ id: 'jobs', role: 'browse', filterable: true, filterMode: 'slash', selectedIds: [], items: jobItems(rows, Date.now(), t), empty: ui.empty({ title: t('no background jobs') }) }),
    ui.actions({ id: 'jobs-actions', items: [{ id: 'refresh', label: t('Refresh'), hintLabel: t('refresh'), semantic: 'refresh', hidden: true }] }),
  ]) })
}

