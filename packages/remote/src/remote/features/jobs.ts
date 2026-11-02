/**
 * Official Job roster, durable Session history, follow readers, and rechecked human kill.
 * @module @ephemeral-ai/mayfly/remote/features/jobs
 */

import { ui, type MayflyPaneRegistration, type MayflyTranslate, type MayflyUiActionEvent, type MayflyUiActionReply } from '@ephemeral-ai/mayfly-ui'
import { memoizedLocaleTranslator } from '@ephemeral-ai/mayfly/frontend'
import { jobListPanel, jobDetailsNode, jobOutputNode, interactionTranslator, mountInteractionLocale } from '@ephemeral-ai/mayfly/command-panels'
import { RemoteJobSource } from '../../frontend/jobs.ts'
import type { RemoteFeatureContext, RemoteFeatureSelection } from '../features.ts'
import { openRemoteBrowser, type RemoteBrowserPanel } from '../panels/browser.ts'
import {
  isRemoteJobLive,
  remoteJobsPanel,
  remoteJobsSummary,
  REMOTE_JOB_STOP_ID,
  REMOTE_JOBS_LIST_ID,
} from '../panels/jobs.ts'
import { isRemoteFeatureSelection } from '../interactions/selection.ts'
import { RemoteFeatureLifecycle } from './lifecycle.ts'
import { RemoteJobFollowReader } from './jobs-follow.ts'
import type { JobView } from './official.ts'

const DONE_LINGER_MS = 5_000

class RemoteJobsController {
  private readonly options: RemoteFeatureContext
  private readonly t: MayflyTranslate
  private readonly browserT: MayflyTranslate
  private readonly lifecycle: RemoteFeatureLifecycle
  private readonly source: RemoteJobSource
  private readonly offSource: () => void
  private readonly pane: MayflyPaneRegistration
  private history: readonly JobView[] = []
  private readonly stoppedByUser = new Set<string>()
  private readonly batch = new Set<string>()
  private batchLive = false
  private done: { readonly total: number, failed: boolean, at: number } | undefined
  private stopEvents: (() => void) | undefined
  private browser: RemoteBrowserPanel | undefined
  private page: { readonly kind: 'list' } | { readonly kind: 'detail' | 'output', readonly id: JobView['id'] } = { kind: 'list' }
  private browserReader: RemoteJobFollowReader | undefined
  private reader: RemoteJobFollowReader | undefined
  private readerPanel: RemoteBrowserPanel | undefined
  private operationLifetime = new AbortController()
  private readonly timer: ReturnType<typeof setInterval>
  private disposed = false

  constructor(options: RemoteFeatureContext) {
    this.options = options
    this.t = memoizedLocaleTranslator(options.ctx, 'remote-jobs').translate
    mountInteractionLocale(options.ctx)
    this.browserT = interactionTranslator(options.ctx)
    this.lifecycle = new RemoteFeatureLifecycle(options, this.attach)
    this.source = new RemoteJobSource()
    this.offSource = this.source.subscribe(this.publish)
    this.pane = options.ctx.mayflyPanes.register({
      id: 'mayfly.view.jobs',
      placement: 'views',
      priority: 12,
      onEvent: { action: (event, context) => this.act(event, context.signal) },
    }, null)
    this.lifecycle.start()
    this.timer = setInterval(this.publish, 1_000)
    this.timer.unref()
  }

  readonly dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    this.lifecycle.dispose()
    this.operationLifetime.abort()
    this.offSource()
    this.stopEvents?.()
    this.stopEvents = undefined
    this.browser?.close()
    this.closeReader()
    clearInterval(this.timer)
    this.pane.dispose()
    void this.source.dispose().catch((error: unknown) => {
      this.options.notice.set(error instanceof Error ? error.message : String(error))
    })
  }

  private readonly attach = (generation: number): void => {
    this.operationLifetime.abort()
    this.operationLifetime = new AbortController()
    this.stopEvents?.()
    this.stopEvents = undefined
    this.history = []
    this.stoppedByUser.clear()
    this.batch.clear()
    this.batchLive = false
    this.done = undefined
    const current = this.lifecycle.selection(generation)
    const browserReader = this.browserReader
    if (current !== undefined && browserReader !== undefined && this.sameReader(current, browserReader)) browserReader.start()
    else this.closeBrowserReader()
    const previousReader = this.reader
    if (current !== undefined && previousReader !== undefined && this.sameReader(current, previousReader)) previousReader.start()
    else this.closeReader()
    if (current === undefined) {
      this.browser?.close()
      void this.source.attach(null)
    } else {
      const history = current.binding.session.projections.faceOf('mayflyJobs')
      const update = (): void => {
        if (!this.lifecycle.owns(generation)) return
        // Native identity brands serialize as strings in the readonly Host DTO.
        this.history = (history.getSnapshot() ?? []) as readonly JobView[]
        this.publish()
      }
      this.stopEvents = history.subscribe(update)
      update()
      void this.source.attach(current.client, current.ref).catch((error: unknown) => {
        if (this.lifecycle.owns(generation)) this.options.notice.set(error instanceof Error ? error.message : String(error))
      })
    }
    this.publish()
  }

  private sameReader(current: RemoteFeatureSelection, reader: RemoteJobFollowReader): boolean {
    return reader.matches(current.client, current.ref)
  }

  private jobs(): readonly JobView[] {
    const merged = new Map(this.history.map(job => [String(job.id), job]))
    for (const job of this.source.snapshot().jobs) merged.set(String(job.id), job)
    return [...merged.values()]
  }

  private readonly publish = (): void => {
    if (this.disposed) return
    const jobs = this.jobs()
    const live = jobs.filter(isRemoteJobLive)
    if (live.length > 0) {
      if (!this.batchLive) {
        this.batch.clear()
        this.done = undefined
        this.batchLive = true
      }
      for (const job of live) this.batch.add(String(job.id))
    } else if (this.batchLive) {
      this.batchLive = false
      const ran = jobs.filter(job => this.batch.has(String(job.id)))
      this.batch.clear()
      if (ran.length > 0) this.done = { total: ran.length, failed: ran.some(job => job.status === 'failed'), at: Date.now() }
    }
    if (this.done !== undefined && Date.now() - this.done.at >= DONE_LINGER_MS) this.done = undefined
    const error = this.source.snapshot().error
    const state = {
      jobs,
      now: Date.now(),
      stoppedByUser: this.stoppedByUser,
      ...this.done === undefined ? {} : { done: { total: this.done.total, failed: this.done.failed } },
      ...error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) },
    }
    this.pane.set(remoteJobsPanel(state, this.t))
    this.pane.setSummary(remoteJobsSummary(state, this.t))
    this.browser?.refresh()
    this.readerPanel?.refresh()
  }

  private async act(event: MayflyUiActionEvent, signal: AbortSignal): Promise<MayflyUiActionReply> {
    if (signal.aborted) return { kind: 'cancelled' }
    if (event.kind === 'activate' && event.actionId === 'jobs-refresh') {
      await this.refreshRoster()
      return { kind: signal.aborted ? 'cancelled' : 'completed' }
    }
    const stopping = event.kind === 'activate' && event.actionId === REMOTE_JOB_STOP_ID
    if (event.kind !== 'selection-accept' && !stopping) return { kind: 'completed' }
    const chosen = event.kind === 'selection-accept' ? event.selectedIds[0]
      : event.inputs?.selections?.find(selection => selection.controlId === REMOTE_JOBS_LIST_ID)?.selectedIds[0]

    const job = this.jobs().find(candidate => String(candidate.id) === String(chosen))
    if (job === undefined) return { kind: 'failed', message: this.t('Select a job first') }
    if (stopping) {
      const error = await this.recheckAndKill(job, signal)
      if (signal.aborted) return { kind: 'cancelled' }
      return error === undefined ? { kind: 'completed', feedback: { severity: 'success', message: this.t('Stopping {job}', { job: job.label }) } } : { kind: 'failed', message: error }
    }
    this.openReader(job)
    return { kind: 'completed' }
  }

  private async refreshRoster(): Promise<void> {
    const current = this.options.hosts.current()
    if (current === undefined) return
    await this.source.attach(current.client, current.ref)
  }

  private async recheckAndKill(job: JobView, parent: AbortSignal): Promise<string | undefined> {
    const current = this.options.hosts.current()
    if (current === undefined) return this.t('The agent changed; open it again')
    const signal = AbortSignal.any([this.operationLifetime.signal, parent])
    let roster: readonly JobView[] | undefined
    const stream = current.client.remote.job.list({ sessionId: current.ref.sessionId }, signal)
    try {
      for await (const frame of stream) {
        roster = frame.jobs
        break
      }
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    } finally {
      await stream.dispose()
    }
    if (signal.aborted || !isRemoteFeatureSelection(this.options.hosts.current(), current.client, current.ref)) return this.t('The agent changed; open it again')
    const latest = roster?.find(candidate => candidate.id === job.id)
    if (latest === undefined) return this.t('The job is no longer available')
    if (latest.status !== 'running') return latest.status === 'stopping' ? this.t('Already stopping') : this.t('Already finished')
    const result = await this.source.kill(current.ref, latest.id)
    if (signal.aborted || !isRemoteFeatureSelection(this.options.hosts.current(), current.client, current.ref)) return this.t('The agent changed; open it again')
    if (!result.ok) return result.error.message
    if (result.value.outcome === 'already-finished') return this.t('Already finished')
    this.stoppedByUser.add(String(latest.id))
    this.publish()
    return undefined
  }

  private browserView(): ReturnType<typeof jobListPanel> {
    const rows = this.jobs()
    const page = this.page
    const job = page.kind === 'list' ? undefined : rows.find(row => row.id === page.id)
      ?? (page.kind === 'output' && !this.source.snapshot().ready && this.source.snapshot().error === undefined ? this.browserReader!.snapshot().job : undefined)
    if (job === undefined) {
      this.page = { kind: 'list' }
      this.closeBrowserReader()
      return jobListPanel(rows, this.source.snapshot().error === undefined, this.browserT)
    }
    if (page.kind === 'output') {
      const feed = this.browserReader!.snapshot()
      return jobOutputNode(job, { dropped: feed.dropped, chunks: feed.text === '' ? [] : [ui.chunk(feed.text)] }, this.browserT)
    }
    return jobDetailsNode(job, this.browserT)
  }

  private async browserAction(event: MayflyUiActionEvent, signal: AbortSignal): Promise<MayflyUiActionReply> {
    if (signal.aborted) return { kind: 'cancelled' }
    if (event.kind === 'activate' && event.actionId === 'refresh') {
      await this.refreshRoster()
      return { kind: signal.aborted ? 'cancelled' : 'completed' }
    }
    if (event.kind === 'activate' && this.page.kind === 'detail') {
      const page = this.page
      const job = this.jobs().find(row => row.id === page.id)
      if (job === undefined) return { kind: 'failed', message: this.browserT('The job is no longer available') }
      if (event.actionId === 'read') {
        this.closeBrowserReader()
        const current = this.options.hosts.current()
        if (current === undefined) return { kind: 'cancelled' }
        const reader = new RemoteJobFollowReader(current.client, current.ref, job, () => this.browser?.refresh())
        this.browserReader = reader
        this.page = { kind: 'output', id: job.id }
        reader.start()
        this.browser?.refresh()
        return { kind: 'completed' }
      }
      if (event.actionId === 'stop') {
        const error = await this.recheckAndKill(job, signal)
        if (signal.aborted) return { kind: 'cancelled' }
        return error === undefined || error === this.t('Already stopping') || error === this.t('Already finished')
          ? { kind: 'completed' } : { kind: 'failed', message: error }
      }
    }
    if (event.kind !== 'selection-accept' || event.controlId !== 'jobs') return { kind: 'completed' }
    const job = this.jobs().find(row => String(row.id) === event.selectedIds[0])
    if (job === undefined) return { kind: 'failed', message: this.browserT('The job is no longer available') }
    this.closeBrowserReader()
    this.page = { kind: 'detail', id: job.id }
    this.browser?.refresh()
    return { kind: 'completed' }
  }

  private closeBrowserReader(): void {
    const reader = this.browserReader
    this.browserReader = undefined
    if (reader !== undefined) void reader.dispose()
  }

  private open(parent: AbortSignal): void {
    const current = this.options.hosts.current()
    if (current === undefined) return
    if (this.browser?.closed === false) { this.options.ctx.mayflyOverlays.focus('remote.jobs'); return }
    this.page = { kind: 'list' }
    const lifetime = new AbortController()
    const signal = AbortSignal.any([lifetime.signal, parent])
    this.browser = openRemoteBrowser(this.options, {
      id: 'remote.jobs',
      scope: { kind: 'session', sessionId: current.ref.sessionId }, signal,
      isCurrent: () => !signal.aborted && isRemoteFeatureSelection(this.options.hosts.current(), current.client, current.ref),
      view: () => this.browserView(),
      action: (event, context) => this.browserAction(event, AbortSignal.any([signal, context.signal])),
      back: () => {
        if (this.page.kind === 'output') { this.page = { kind: 'detail', id: this.page.id }; this.closeBrowserReader() }
        else if (this.page.kind === 'detail') this.page = { kind: 'list' }
        else return false
        this.browser?.refresh()
        return true
      },
      onClosed: () => { lifetime.abort(); this.browser = undefined; this.closeBrowserReader() },
    })
  }

  private openReader(job: JobView): void {
    const current = this.options.hosts.current()
    if (current === undefined) return
    this.closeReader()
    const reader = new RemoteJobFollowReader(current.client, current.ref, job, () => {
      this.readerPanel?.refresh()
    })
    this.reader = reader
    this.readerPanel = openRemoteBrowser(this.options, {
      id: 'remote.jobs.output',
      scope: { kind: 'session', sessionId: current.ref.sessionId },
      isCurrent: () => this.reader === reader && isRemoteFeatureSelection(this.options.hosts.current(), current.client, current.ref),
      view: () => {
        const snapshot = reader.snapshot()
        return jobOutputNode(snapshot.job, { dropped: snapshot.dropped, chunks: snapshot.text === '' ? [] : [ui.chunk(snapshot.text)] }, this.browserT, 'close')
      },
      onClosed: () => {
        this.readerPanel = undefined
        if (this.reader === reader) this.reader = undefined
        void reader.dispose()
      },
    })
    reader.start()
  }

  private closeReader(): void {
    const reader = this.reader
    this.reader = undefined
    this.readerPanel?.close()
    this.readerPanel = undefined
    if (reader !== undefined) void reader.dispose()
  }

  readonly execute = async (_rawInput: string, parent: AbortSignal): Promise<void> => {
    if (this.disposed || parent.aborted) return
    this.open(parent)
  }
}

/** Mount native roster/history projections, output readers, and explicit Job controls. */
export function mountJobsFeature(options: RemoteFeatureContext): () => void {
  const controller = new RemoteJobsController(options)
  const unregister = options.commands.register({
    name: 'jobs',
    description: 'Browse background jobs',
    execute: controller.execute,
  })
  return () => {
    unregister()
    controller.dispose()
  }
}
