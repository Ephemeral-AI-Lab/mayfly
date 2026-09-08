/** Native job inspection, explicit output reads, and shared UI navigation.
 * @module @ephemeral-ai/mayfly/interaction/jobs
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import { JobId, type JobRead, type JobSnapshot } from '@deepseek-ai/dsh-jobs'
import { isDeepStrictEqual } from 'node:util'
import { ui, type MayflyListItem, type MayflyOverlayHandle, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyTranslate } from '../frontend/index.ts'
import { openAgentOverlay } from './agent-overlay.ts'
import { interactionTranslator, mountInteractionLocale, observeInteractionLocale } from './locale.ts'
import { documentPages } from './document-pages.ts'

export const name = 'mayfly-jobs'
export const inject = ['commands', 'jobs', 'mayflyCurrentAgent', 'mayflyOverlays']
const PAGE_FORM = { pagePath: [], formId: 'output-page' } as const
const jobSource = (job: JobSnapshot) => [{ resourceId: `job/${job.id}`, revision: JSON.stringify([job.status, job.reported, job.finishedAt ?? null]) }]

export function isLiveJob(job: JobSnapshot): boolean { return job.status === 'running' || job.status === 'stopping' }

export function sortJobs(jobs: readonly JobSnapshot[]): readonly JobSnapshot[] {
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

export function jobItems(jobs: readonly JobSnapshot[], now: number, t: MayflyTranslate): readonly MayflyListItem[] {
  return sortJobs(jobs).map(job => ({ id: String(job.id), label: job.label, badge: t(job.status), detail: `${job.id} · ${formatJobDuration(job.startedAt, job.finishedAt ?? now)}${job.detail === undefined ? '' : ` · ${job.detail}`}` }))
}

export function jobDetailsNode(job: JobSnapshot, t: MayflyTranslate): MayflyUiNode {
  return ui.surface({ title: t('Job {id}', { id: String(job.id) }), chrome: 'overlay', padding: 1, child: ui.stack.column([
    ui.fields([
      { label: t('Name'), value: [{ text: job.label }] },
      { label: t('Status'), value: [{ text: t(job.status) }] },
      ...job.detail === undefined ? [] : [{ label: t('Detail'), value: [{ text: job.detail }] }],
    ]),
    ...isLiveJob(job) ? [ui.text(t("Reading a live job consumes the model's output cursor; the model will not see this output again."), { tone: 'warning' })] : [],
    ui.actions({ id: 'job-actions', items: [
      { id: 'read', label: t('Read output') },
      { id: 'stop', label: t('Stop job'), intent: 'danger', disabled: job.status !== 'running', confirm: t('Stop {job}?', { job: job.label }) },
      { id: 'close', label: t('Close'), dismiss: true },
    ] }),
  ]) })
}

export function jobOutputNode(read: JobRead, pages: readonly string[], page: number, t: MayflyTranslate): MayflyUiNode {
  const text = pages[page - 1]!
  return ui.surface({ title: t('Job {id}', { id: String(read.snapshot.id) }), chrome: 'overlay', padding: 1, child: ui.stack.column([
    ui.fields([{ label: t('Status at read'), value: [{ text: t(read.snapshot.status) }] }]),
    ui.child(ui.scroll(text === '' ? ui.text(t(isLiveJob(read.snapshot) ? '(no new output yet)' : '(no output)'), { tone: 'muted' }) : ui.code(text), { id: `job-output-document/${String(page)}`, scrollbar: true }), { basis: 0, grow: 1, minSize: 1 }),
    ...pages.length === 1 ? [] : [
      ui.form({ id: PAGE_FORM.formId, fields: [{ kind: 'number', id: 'page', label: t('Page'), value: page, min: 1, max: pages.length, step: 1, required: true }] }),
      ui.actions({ id: 'page-actions', items: [
        { id: 'first', label: t('First'), submit: [PAGE_FORM], disabled: page === 1 },
        { id: 'previous', label: t('Previous'), submit: [PAGE_FORM], disabled: page === 1 },
        { id: 'go', label: t('Go to page'), submit: [PAGE_FORM] },
        { id: 'next', label: t('Next page'), submit: [PAGE_FORM], disabled: page === pages.length },
        { id: 'last', label: t('Last'), submit: [PAGE_FORM], disabled: page === pages.length },
      ] }),
    ],
    ui.actions({ id: 'output-actions', items: [{ id: 'close', label: t('Close'), dismiss: true }] }),
  ]) })
}

/** A read result is retained in its child Fiber, never reread by rendering or paging. */
async function showOutput(ctx: Context, agent: Agent, read: JobRead, signal: AbortSignal, t: MayflyTranslate): Promise<void> {
  const pages = documentPages(read.text)
  ctx.mayflyOverlays.close('mayfly.jobs.output')
  let handle: MayflyOverlayHandle | undefined
  handle = await openAgentOverlay(ctx, agent, { id: 'mayfly.jobs.output', presentation: 'editor', capturing: true }, jobOutputNode(read, pages, 1, t), owner => {
    owner.effect(() => observeInteractionLocale(owner, () => {
      if (handle?.closed !== false) return
      // Locale updates reuse the published baseline; the shared form retains any draft.
      const node = owner.mayflyOverlays.list().find(entry => entry.id === 'mayfly.jobs.output')!.node
      if (node.kind !== 'surface' || node.child.kind !== 'stack') return
      const form = node.child.children.map(child => child.node).find(node => node.kind === 'form')
      const page = form?.fields.find(field => field.id === 'page')?.value ?? 1
      handle.set(jobOutputNode(read, pages, Number(page), t))
    }))
    return event => {
      if (event.kind !== 'submit') return { kind: 'completed' }
      const page = event.submission.forms[0]?.fields.find(field => field.id === 'page')?.value
      if (typeof page !== 'number' || !Number.isInteger(page)) return { kind: 'failed', message: t('Invalid page') }
      const action = event.submission.actionId
      const target = action === 'first' ? 1 : action === 'last' ? pages.length : action === 'previous' ? page - 1 : action === 'next' ? page + 1 : page
      return { kind: 'accepted', node: jobOutputNode(read, pages, Math.max(1, Math.min(pages.length, target)), t), source: [] }
    }
  }, signal)
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
    const readList = () => jobs.list(agent)
    const view = (rows: readonly JobSnapshot[], available = true) => ui.surface({ title: t('Jobs'), chrome: 'overlay', padding: 1, child: ui.stack.column([
      ...available ? [] : [ui.text(t('Job registry unavailable'), { tone: 'danger' })],
      ui.list({ id: 'jobs', role: 'browse', filterable: true, selectedIds: [], items: jobItems(rows, Date.now(), t), empty: ui.empty({ title: t('no background jobs') }) }),
      ui.actions({ id: 'jobs-actions', items: [{ id: 'refresh', label: t('Refresh') }, { id: 'close', label: t('Close'), dismiss: true }] }),
    ]) })
    const refresh = () => {
      if (root?.closed !== false || !current()) { stopTimer(); return }
      let rows: readonly JobSnapshot[]
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
      const off = jobs.onJobsChanged(changed => { if (changed === undefined || changed === agent) refresh() })
      owner.effect(() => () => { off(); stopTimer() })
      owner.effect(() => observeInteractionLocale(owner, refresh))
      return async (event, context) => {
        if (event.kind === 'activate' && event.actionId === 'refresh') { refresh(); return { kind: 'completed' } }
        if (event.kind !== 'selection-accept' || event.controlId !== 'jobs' || context.signal.aborted) return { kind: 'completed' }
        const id = JobId(event.selectedIds[0] ?? '')
        const job = jobs.get(id, agent)
        ctx.mayflyOverlays.close('mayfly.jobs.detail')
        const node = jobDetailsNode(job, t)
        const handle = await openAgentOverlay(owner, agent, { id: 'mayfly.jobs.detail', presentation: 'editor', capturing: true, source: jobSource(job) }, node, scope => async (event, context) => {
          if (event.kind !== 'activate' || context.signal.aborted) return { kind: 'completed' }
          if (event.actionId === 'read') {
            const output = jobs.read(id, agent)
            if (context.signal.aborted || !current()) return { kind: 'cancelled' }
            await showOutput(scope, agent, output, signal, t)
            return { kind: 'completed' }
          }
          if (event.actionId === 'stop') {
            if (jobs.get(id, agent).status !== 'running') return { kind: 'completed' }
            jobs.kill(id, agent, 'stopped from the Mayfly /jobs view')
            refresh()
            return { kind: 'completed' }
          }
          return { kind: 'completed' }
        }, signal)
        if (handle !== undefined) detail = { id, handle, node }
        refresh()
        return { kind: 'completed' }
      }
    }, signal)
    refresh()
    return { kind: 'success' }
  } })
}
