/** Native job inspection, explicit output reads, and one shared UI panel for list, detail, and reader.
 * @module @ephemeral-ai/mayfly/interaction/jobs
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import { JobId, type JobRegisteredData, type JobOutputRead, type JobSettledData, type JobView } from '@deepseek-ai/dsh-jobs'
import type { Session } from '@deepseek-ai/dsh-session'
import { panel, ui, type MayflyContentChunk, type MayflyListItem, type MayflyOverlayHandle, type MayflyTone, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyTranslate } from '../frontend/locale.ts'
import { openAgentOverlay } from './agent-overlay.ts'
import { interactionTranslator, mountInteractionLocale, observeInteractionLocale } from './locale.ts'

export const name = 'mayfly-jobs'
export const inject = ['commands', 'jobs', 'mayflyCurrentAgent', 'mayflyOverlays']
const jobSource = (job: JobView) => [{ resourceId: `job/${job.id}`, revision: JSON.stringify([job.status, job.finishedAt ?? null]) }]
const STATUS_TONE: Readonly<Record<JobView['status'], MayflyTone>> = { running: 'primary', stopping: 'warning', completed: 'success', killed: 'muted', failed: 'danger' }

/** The page one `/jobs` panel shows; all three share the single `mayfly.jobs` registration. */
type JobsPage = { readonly kind: 'list' } | { readonly kind: 'detail', readonly id: JobId } | { readonly kind: 'output', readonly id: JobId }

export function isLiveJob(job: JobView): boolean { return job.status === 'running' || job.status === 'stopping' }

/**
 * The settled jobs one owning session's durable `job/registered` and
 * `job/settled` records describe. The live registry is the authority while a
 * record is resident; a later registry lifetime, or a record the registry no
 * longer lists, still shows its durable registration and settlement. A
 * registered record with no settlement stays incomplete and is not invented
 * here. The branded `JobId` is retained as the registration recorded it.
 * @param session - the exact owning session's log.
 * @returns settled job projections in registration order.
 */
export function jobHistory(session: Session): readonly JobView[] {
  const records = new Map<string, { readonly registered: JobRegisteredData, settled?: JobSettledData }>()
  for (const event of session.snapshotEvents()) {
    if (event.type === 'job/registered') {
      records.set(String(event.data.jobId), { registered: event.data })
    } else if (event.type === 'job/settled') {
      const previous = records.get(String(event.data.jobId))
      records.set(String(event.data.jobId), { registered: previous?.registered ?? event.data, settled: event.data })
    }
  }
  const jobs: JobView[] = []
  for (const { registered, settled } of records.values()) {
    if (settled === undefined) continue
    jobs.push({
      id: registered.jobId,
      kind: registered.kind,
      label: registered.label,
      owner: registered.owner,
      status: settled.status,
      startedAt: registered.startedAt,
      finishedAt: settled.finishedAt,
      ...(settled.detail === undefined ? {} : { detail: settled.detail }),
      output: { total: 0, earliest: 0 },
    })
  }
  return jobs
}

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

/**
 * The appended tail of one job's retained output. `chunks` are held wire pieces — publishes share their identities,
 * so admission validates each ring piece once. `dropped` marks a lossy read (retention trimmed bytes below the
 * cursor); on it the held pieces are dropped with the read, so the document stays the ring's retained window.
 */
interface JobOutputFeed {
  /** The ring offset the next `readAt` resumes from. */
  cursor: number
  dropped: boolean
  readonly chunks: MayflyContentChunk[]
}

/**
 * Pieces one feed keeps before older ones join, far under the admission cap (`MAYFLY_UI_MAX_CHUNKS`): a job that
 * prints a line at a time for hours would otherwise outgrow it and every later publish would be rejected.
 */
export const JOB_OUTPUT_FEED_CHUNKS = 256

/**
 * Join neighbours until the feed fits {@link JOB_OUTPUT_FEED_CHUNKS}. Only the older half joins, so the pieces a
 * following tail paints keep their identity, and the smallest pair joins first, so sizes stay balanced and a join
 * copies little rather than rewriting one ever-growing head.
 */
function settleOutput(chunks: MayflyContentChunk[]): void {
  while (chunks.length > JOB_OUTPUT_FEED_CHUNKS) {
    const older = chunks.length - JOB_OUTPUT_FEED_CHUNKS / 2
    let pair = 0
    for (let index = 1; index + 1 < older; index += 1) {
      if (chunks[index]!.text.length + chunks[index + 1]!.text.length < chunks[pair]!.text.length + chunks[pair + 1]!.text.length) pair = index
    }
    chunks.splice(pair, 2, ui.chunk(chunks[pair]!.text + chunks[pair + 1]!.text))
  }
}

/** Append everything `read` holds under the feed's cursor; a lossy read drops the held pieces with the missed bytes. */
function appendOutput(feed: JobOutputFeed, read: JobOutputRead): boolean {
  if (read.lossy) {
    feed.chunks.length = 0
    feed.dropped = true
  }
  for (const chunk of read.chunks) if (chunk.at >= feed.cursor) feed.chunks.push(ui.chunk(chunk.text))
  settleOutput(feed.chunks)
  feed.cursor = read.next
  return read.chunks.length > 0 || read.lossy
}

export function jobOutputNode(job: JobView, feed: { readonly dropped: boolean, readonly chunks: readonly MayflyContentChunk[] }, t: MayflyTranslate, escapeLabel: 'close' | 'back' = 'back'): MayflyUiNode {
  return panel({ title: t('Job {id}', { id: String(job.id) }), escapeLabel, body: ui.stack.column([
    ui.fields([{ label: t('Status at read'), value: [{ text: t(job.status), tone: STATUS_TONE[job.status] }] }]),
    ...feed.dropped ? [ui.text(t('(earlier output was dropped by retention)'), { tone: 'muted' })] : [],
    ui.child(ui.scroll(feed.chunks.length === 0 ? ui.text(t(isLiveJob(job) ? '(no output yet)' : '(no output)'), { tone: 'muted' }) : ui.code([...feed.chunks]), { id: 'job-output-document', scrollbar: true, follow: 'end' }), { basis: 0, grow: 1, minSize: 1 }),
  ]) })
}

/** The list page of the single jobs panel. */
function jobListPanel(rows: readonly JobView[], available: boolean, t: MayflyTranslate): MayflyUiNode {
  return panel({ title: t('Jobs'), escapeLabel: 'close', body: ui.stack.column([
    ...available ? [] : [ui.text(t('Job registry unavailable'), { tone: 'danger' })],
    ui.list({ id: 'jobs', role: 'browse', filterable: true, filterMode: 'slash', selectedIds: [], items: jobItems(rows, Date.now(), t), empty: ui.empty({ title: t('no background jobs') }) }),
    ui.actions({ id: 'jobs-actions', items: [{ id: 'refresh', label: t('Refresh'), hintLabel: t('refresh'), semantic: 'refresh', hidden: true }] }),
  ]) })
}

/** A read result is retained in its child Fiber, never reread by rendering or scrolling. */
async function showOutput(ctx: Context, agent: Agent, job: JobView, read: JobOutputRead, signal: AbortSignal, t: MayflyTranslate): Promise<MayflyOverlayHandle | undefined> {
  const feed: JobOutputFeed = { cursor: read.next, dropped: read.lossy, chunks: read.chunks.map(chunk => ui.chunk(chunk.text)) }
  settleOutput(feed.chunks)
  ctx.mayflyOverlays.close('mayfly.jobs.output')
  let handle: MayflyOverlayHandle | undefined
  handle = await openAgentOverlay(ctx, agent, { id: 'mayfly.jobs.output', presentation: 'editor', capturing: true }, jobOutputNode(job, feed, t, 'close'), owner => {
    const off = ctx.jobs.events.subscribe({ owner: agent.id }, event => {
      if (event.type !== 'output' || event.id !== job.id || handle?.closed !== false) return
      if (appendOutput(feed, ctx.jobs.readAt(job.id, feed.cursor, agent.id))) handle?.set(jobOutputNode(job, feed, t, 'close'))
    })
    owner.effect(() => off)
    owner.effect(() => observeInteractionLocale(owner, () => {
      if (handle?.closed !== false) return
      // Locale updates republish only over this surface's own document; a foreign registration wins.
      const node = owner.mayflyOverlays.list().find(entry => entry.id === 'mayfly.jobs.output')?.node
      if (node === undefined || node.kind !== 'surface' || node.child.kind !== 'stack'
        || !node.child.children.some(child => child.node.kind === 'scroll' && child.node.id === 'job-output-document')) return
      handle.set(jobOutputNode(job, feed, t, 'close'))
    }))
    return event => event.kind === 'submit' ? { kind: 'cancelled' } : { kind: 'completed' }
  }, { signal, reopen: 'replace' })
  // Whatever appended between the first read and the open (or before the subscription went in) is caught up here.
  if (handle?.closed === false && appendOutput(feed, ctx.jobs.readAt(job.id, feed.cursor, agent.id))) handle.set(jobOutputNode(job, feed, t, 'close'))
  return handle
}

/**
 * Open one job's retained output in the reader overlay: the target of `Enter` in the Jobs view and of Read output in
 * `/jobs`. The job is read and rechecked under the exact Agent; the overlay replaces a live reader of the same id.
 * @param ctx - plugin context that owns the overlay; needs `jobs`, `mayflyCurrentAgent`, and `mayflyOverlays`.
 * @param agent - the exact Agent that owns the job.
 * @param id - the job to read.
 * @param signal - ends the read and closes the overlay.
 * @param t - translator for the overlay's words.
 * @param onClose - called once when the reader is gone (closed by the user, or never opened), unless `signal` ended first.
 */
export async function openJobOutput(ctx: Context, agent: Agent, id: JobId, signal: AbortSignal, t: MayflyTranslate, onClose?: () => void): Promise<void> {
  const job = ctx.jobs.get(id, agent.id)
  const output = ctx.jobs.readAt(id, 0, agent.id)
  if (signal.aborted || ctx.mayflyCurrentAgent.current() !== agent) return
  const handle = await showOutput(ctx, agent, job, output, signal, t)
  if (onClose === undefined) return
  if (handle === undefined || handle.closed) { if (!signal.aborted) onClose(); return }
  const off = ctx.mayflyOverlays.subscribe((delta) => {
      if (delta.kind !== 'remove' || delta.id !== 'mayfly.jobs.output' || !handle.closed) return
    off()
    if (!signal.aborted) onClose()
  })
  signal.addEventListener('abort', off, { once: true })
}

export function apply(ctx: Context): void {
  mountInteractionLocale(ctx)
  const jobs = ctx.jobs
  const t = interactionTranslator(ctx)
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort())
  ctx.commands.register({ name: 'jobs', description: t('Browse background jobs'), handler: async invocation => {
    const agent = invocation.agent
    const signal = AbortSignal.any([lifetime.signal, invocation.signal])
    const current = () => !signal.aborted && ctx.mayflyCurrentAgent.current() === agent
    if (!current()) return { kind: 'success' }
    if (ctx.mayflyOverlays.focus('mayfly.jobs')) return { kind: 'success' }
    let root: MayflyOverlayHandle | undefined
    let page: JobsPage = { kind: 'list' }
    let feed: JobOutputFeed | undefined
    let timer: ReturnType<typeof setInterval> | undefined
    const stopTimer = () => { if (timer !== undefined) { clearInterval(timer); timer = undefined } }
    const readList = () => jobs.list(agent.id)

    const publish = (rows: readonly JobView[], available = true) => {
      if (root?.closed !== false || !current()) return
      if (page.kind === 'list') { root.set(jobListPanel(rows, available, t)); return }
      const pageId = page.id
      const job = rows.find(item => item.id === pageId)
      if (job === undefined) { page = { kind: 'list' }; feed = undefined; root.set(jobListPanel(rows, available, t)); return }
      if (page.kind === 'output') {
        if (feed !== undefined) {
          try { appendOutput(feed, jobs.readAt(job.id, feed.cursor, agent.id)) } catch { /* a failed catch-up leaves the held document */ }
        }
        root.set(jobOutputNode(job, feed ?? { cursor: 0, dropped: false, chunks: [] }, t), { source: jobSource(job) })
        return
      }
      root.set(jobDetailsNode(job, t), { source: jobSource(job) })
    }

    const refresh = () => {
      if (root?.closed !== false || !current()) { stopTimer(); return }
      let rows: readonly JobView[]
      try { rows = readList() } catch { root.set(jobListPanel([], false, t)); stopTimer(); return }
      const openId = page.kind === 'list' ? undefined : page.id
      if (openId !== undefined && !rows.some(job => job.id === openId)) { page = { kind: 'list' }; feed = undefined }
      publish(rows)
      if (rows.some(isLiveJob)) { if (timer === undefined) { timer = setInterval(refresh, 1000); timer.unref() } }
      else stopTimer()
    }

    let initial: MayflyUiNode
    try { initial = jobListPanel(readList(), true, t) } catch { initial = jobListPanel([], false, t) }
    root = await openAgentOverlay(ctx, agent, { id: 'mayfly.jobs', presentation: 'editor', capturing: true }, initial, owner => {
      const off = jobs.events.subscribe({ owner: agent.id }, () => refresh())
      owner.effect(() => () => { off(); stopTimer() })
      owner.effect(() => observeInteractionLocale(owner, refresh))
      return async (event, context) => {
        if (context.signal.aborted || !current()) return { kind: 'cancelled', dismiss: true }
        if (event.kind === 'dismiss') {
          if (page.kind === 'output') { page = { kind: 'detail', id: page.id }; feed = undefined; refresh(); return { kind: 'completed', dismiss: false } }
          if (page.kind === 'detail') { page = { kind: 'list' }; feed = undefined; refresh(); return { kind: 'completed', dismiss: false } }
          return { kind: 'completed' }
        }
        if (event.kind === 'activate' && event.actionId === 'refresh') { refresh(); return { kind: 'completed' } }
        if (event.kind === 'activate' && page.kind === 'detail' && event.actionId === 'read') {
          try {
            const output = jobs.readAt(page.id, 0, agent.id)
            if (context.signal.aborted || !current()) return { kind: 'cancelled' }
            feed = { cursor: output.next, dropped: output.lossy, chunks: output.chunks.map(chunk => ui.chunk(chunk.text)) }
            settleOutput(feed.chunks)
            page = { kind: 'output', id: page.id }
            refresh()
            return { kind: 'completed' }
          } catch (error) { return { kind: 'failed', message: error instanceof Error ? error.message : String(error) } }
        }
        if (event.kind === 'activate' && page.kind === 'detail' && event.actionId === 'stop') {
          try {
            if (jobs.get(page.id, agent.id).status !== 'running') return { kind: 'completed' }
            jobs.kill(page.id, agent.id, 'stopped from the Mayfly /jobs view')
          } catch (error) { return { kind: 'failed', message: error instanceof Error ? error.message : String(error) } }
          refresh()
          return { kind: 'completed' }
        }
        if (event.kind !== 'selection-accept' || event.controlId !== 'jobs') return { kind: 'completed' }
        const id = JobId(event.selectedIds[0] ?? '')
        try { jobs.get(id, agent.id) } catch { return { kind: 'failed', message: t('The job is no longer available') } }
        page = { kind: 'detail', id }
        feed = undefined
        refresh()
        return { kind: 'completed' }
      }
    }, { signal, reopen: 'focus' })
    refresh()
    return { kind: 'success' }
  } })
}
