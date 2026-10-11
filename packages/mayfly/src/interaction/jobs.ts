/** Native job inspection, explicit output reads, and shared UI navigation.
 * @module @ephemeral-ai/mayfly/interaction/jobs
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import { JobId, type JobOutputRead, type JobView } from '@deepseek-ai/dsh-jobs'
import { isDeepStrictEqual } from 'node:util'
import { ui, type MayflyContentChunk, type MayflyListItem, type MayflyOverlayHandle, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyTranslate } from '../frontend/index.ts'
import { openAgentOverlay } from './agent-overlay.ts'
import { interactionTranslator, mountInteractionLocale, observeInteractionLocale } from './locale.ts'

export const name = 'mayfly-jobs'
export const inject = ['commands', 'jobs', 'mayflyCurrentAgent', 'mayflyOverlays']
const jobSource = (job: JobView) => [{ resourceId: `job/${job.id}`, revision: JSON.stringify([job.status, job.finishedAt ?? null]) }]

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
  return sortJobs(jobs).map(job => ({ id: String(job.id), label: job.label, badge: t(job.status), detail: `${job.id} · ${formatJobDuration(job.startedAt, job.finishedAt ?? now)}${job.detail === undefined ? '' : ` · ${job.detail}`}` }))
}

export function jobDetailsNode(job: JobView, t: MayflyTranslate): MayflyUiNode {
  return ui.surface({ title: t('Job {id}', { id: String(job.id) }), chrome: 'overlay', padding: 1, child: ui.stack.column([
    ui.fields([
      { label: t('Name'), value: [{ text: job.label }] },
      { label: t('Status'), value: [{ text: t(job.status) }] },
      ...job.detail === undefined ? [] : [{ label: t('Detail'), value: [{ text: job.detail }] }],
    ]),
    ui.actions({ id: 'job-actions', items: [
      { id: 'read', label: t('Read output') },
      { id: 'stop', label: t('Stop job'), intent: 'danger', disabled: job.status !== 'running', confirm: t('Stop {job}?', { job: job.label }) },
      { id: 'close', label: t('Close'), dismiss: true },
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

/** Append everything `read` holds under the feed's cursor; a lossy read drops the held pieces with the missed bytes. */
function appendOutput(feed: JobOutputFeed, read: JobOutputRead): boolean {
  if (read.lossy) {
    feed.chunks.length = 0
    feed.dropped = true
  }
  for (const chunk of read.chunks) if (chunk.at >= feed.cursor) feed.chunks.push(ui.chunk(chunk.text))
  feed.cursor = read.next
  return read.chunks.length > 0 || read.lossy
}

export function jobOutputNode(job: JobView, feed: { readonly dropped: boolean, readonly chunks: readonly MayflyContentChunk[] }, t: MayflyTranslate): MayflyUiNode {
  return ui.surface({ title: t('Job {id}', { id: String(job.id) }), chrome: 'overlay', padding: 1, child: ui.stack.column([
    ui.fields([{ label: t('Status at read'), value: [{ text: t(job.status) }] }]),
    ...feed.dropped ? [ui.text(t('(earlier output was dropped by retention)'), { tone: 'muted' })] : [],
    ui.child(ui.scroll(feed.chunks.length === 0 ? ui.text(t(isLiveJob(job) ? '(no output yet)' : '(no output)'), { tone: 'muted' }) : ui.code([...feed.chunks]), { id: 'job-output-document', scrollbar: true, follow: 'end' }), { basis: 0, grow: 1, minSize: 1 }),
    ui.actions({ id: 'output-actions', items: [{ id: 'close', label: t('Close'), dismiss: true }] }),
  ]) })
}

/** A read result is retained in its child Fiber, never reread by rendering or scrolling. */
async function showOutput(ctx: Context, agent: Agent, job: JobView, read: JobOutputRead, signal: AbortSignal, t: MayflyTranslate): Promise<void> {
  const feed: JobOutputFeed = { cursor: read.next, dropped: read.lossy, chunks: read.chunks.map(chunk => ui.chunk(chunk.text)) }
  ctx.mayflyOverlays.close('mayfly.jobs.output')
  let handle: MayflyOverlayHandle | undefined
  handle = await openAgentOverlay(ctx, agent, { id: 'mayfly.jobs.output', presentation: 'editor', capturing: true }, jobOutputNode(job, feed, t), owner => {
    const off = ctx.jobs.events.subscribe({ owner: agent.id }, event => {
      if (event.type !== 'output' || event.id !== job.id || handle?.closed !== false) return
      if (appendOutput(feed, ctx.jobs.readAt(job.id, feed.cursor, agent.id))) handle?.set(jobOutputNode(job, feed, t))
    })
    owner.effect(() => off)
    owner.effect(() => observeInteractionLocale(owner, () => {
      if (handle?.closed !== false) return
      // Locale updates republish only over this surface's own document; a foreign registration wins.
      const node = owner.mayflyOverlays.list().find(entry => entry.id === 'mayfly.jobs.output')?.node
      if (node === undefined || node.kind !== 'surface' || node.child.kind !== 'stack'
        || !node.child.children.some(child => child.node.kind === 'scroll' && child.node.id === 'job-output-document')) return
      handle.set(jobOutputNode(job, feed, t))
    }))
    return event => event.kind === 'submit' ? { kind: 'cancelled' } : { kind: 'completed' }
  }, { signal, reopen: 'replace' })
  // Whatever appended between the first read and the open (or before the subscription went in) is caught up here.
  if (handle?.closed === false && appendOutput(feed, ctx.jobs.readAt(job.id, feed.cursor, agent.id))) handle.set(jobOutputNode(job, feed, t))
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
    let detail: { readonly id: JobId, readonly handle: MayflyOverlayHandle, node: MayflyUiNode } | undefined
    let timer: ReturnType<typeof setInterval> | undefined
    const stopTimer = () => { if (timer !== undefined) { clearInterval(timer); timer = undefined } }
    const readList = () => jobs.list(agent.id)
    const view = (rows: readonly JobView[], available = true) => ui.surface({ title: t('Jobs'), chrome: 'overlay', padding: 1, child: ui.stack.column([
      ...available ? [] : [ui.text(t('Job registry unavailable'), { tone: 'danger' })],
      ui.list({ id: 'jobs', role: 'browse', filterable: true, selectedIds: [], items: jobItems(rows, Date.now(), t), empty: ui.empty({ title: t('no background jobs') }) }),
      ui.actions({ id: 'jobs-actions', items: [{ id: 'refresh', label: t('Refresh') }, { id: 'close', label: t('Close'), dismiss: true }] }),
    ]) })
    const refresh = () => {
      if (root?.closed !== false || !current()) { stopTimer(); return }
      let rows: readonly JobView[]
      try { rows = readList() } catch { root.set(view([], false)); stopTimer(); return }
      root.set(view(rows))
      if (rows.some(isLiveJob)) { if (timer === undefined) { timer = setInterval(refresh, 1000); timer.unref() } }
      else stopTimer()
      if (detail?.handle.closed === false) {
        const job = rows.find(job => job.id === detail!.id)
        if (job === undefined) { detail.handle.close(); detail = undefined }
        else { const node = jobDetailsNode(job, t); if (!isDeepStrictEqual(node, detail.node)) { detail.node = node; detail.handle.set(node, { source: jobSource(job) }) } }
      }
    }
    let initial: MayflyUiNode
    try { initial = view(readList()) } catch { initial = view([], false) }
    root = await openAgentOverlay(ctx, agent, { id: 'mayfly.jobs', presentation: 'editor', capturing: true }, initial, owner => {
      const off = jobs.events.subscribe({ owner: agent.id }, () => refresh())
      owner.effect(() => () => { off(); stopTimer() })
      owner.effect(() => observeInteractionLocale(owner, refresh))
      return async (event, context) => {
        if (event.kind === 'activate' && event.actionId === 'refresh') { refresh(); return { kind: 'completed' } }
        if (event.kind !== 'selection-accept' || event.controlId !== 'jobs' || context.signal.aborted) return { kind: 'completed' }
        const id = JobId(event.selectedIds[0] ?? '')
        const job = jobs.get(id, agent.id)
        ctx.mayflyOverlays.close('mayfly.jobs.detail')
        const node = jobDetailsNode(job, t)
        const handle = await openAgentOverlay(owner, agent, { id: 'mayfly.jobs.detail', presentation: 'editor', capturing: true, source: jobSource(job) }, node, scope => async (event, context) => {
          if (event.kind !== 'activate' || context.signal.aborted) return { kind: 'completed' }
          if (event.actionId === 'read') {
            const output = jobs.readAt(id, 0, agent.id)
            if (context.signal.aborted || !current()) return { kind: 'cancelled' }
            await showOutput(scope, agent, job, output, signal, t)
            return { kind: 'completed' }
          }
          if (event.actionId === 'stop') {
            if (jobs.get(id, agent.id).status !== 'running') return { kind: 'completed' }
            jobs.kill(id, agent.id, 'stopped from the Mayfly /jobs view')
            refresh()
            return { kind: 'completed' }
          }
          return { kind: 'completed' }
        }, { signal, reopen: 'replace' })
        if (handle !== undefined) detail = { id, handle, node }
        refresh()
        return { kind: 'completed' }
      }
    }, { signal, reopen: 'focus' })
    refresh()
    return { kind: 'success' }
  } })
}
