/**
 * Official Schedule list/catalog reads and change events with selection fencing.
 * @module @ephemeral-ai/mayfly/remote/features/schedule
 */

import type { MayflyTranslate } from '@ephemeral-ai/mayfly-ui'
import { interactionTranslator, mountInteractionLocale } from '../../interaction/locale.ts'
import type { MayflyStatusRegistration } from '@ephemeral-ai/mayfly-ui'
import type { HostClient } from '../../client/types.ts'
import type { RemoteFeatureContext } from '../features.ts'
import { openRemoteBrowser, type RemoteBrowserPanel } from '../panels/browser.ts'
import {
  remoteScheduleNode,
  type RemoteScheduleRecord,
} from '../panels/schedule.ts'
import { isRemoteFeatureSelection } from '../interactions/selection.ts'
import { RemoteFeatureLifecycle } from './lifecycle.ts'

class RemoteScheduleController {
  private readonly options: RemoteFeatureContext
  private readonly t: MayflyTranslate
  private readonly lifecycle: RemoteFeatureLifecycle
  private readonly status: MayflyStatusRegistration
  private readonly hostListeners = new Map<HostClient, () => void>()
  private readonly offTopology: () => void
  private records: readonly RemoteScheduleRecord[] | undefined
  private ticket = 0
  private browser: RemoteBrowserPanel | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private disposed = false

  constructor(options: RemoteFeatureContext) {
    this.options = options
    mountInteractionLocale(options.ctx)
    this.t = interactionTranslator(options.ctx)
    this.lifecycle = new RemoteFeatureLifecycle(options, this.attach)
    this.status = options.ctx.mayflyStatus.register({ id: 'mayfly.schedule', priority: 2, overflow: 'hide' }, null)
    this.offTopology = options.hosts.subscribe(this.reconcileHosts)
    this.reconcileHosts()
    this.lifecycle.start()
  }

  readonly dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    this.ticket += 1
    this.lifecycle.dispose()
    this.offTopology()
    for (const dispose of this.hostListeners.values()) dispose()
    this.hostListeners.clear()
    this.browser?.close()
    this.stopTimer()
    this.status.dispose()
  }

  private readonly reconcileHosts = (): void => {
    if (this.disposed) return
    const attached = new Set(this.options.hosts.list())
    for (const [client, dispose] of this.hostListeners) {
      if (attached.has(client)) continue
      dispose()
      this.hostListeners.delete(client)
    }
    for (const client of attached) {
      if (this.hostListeners.has(client)) continue
      this.hostListeners.set(client, client.remote.$on('schedule/changed', () => {
        const current = this.options.hosts.current()
        if (current?.client === client) void this.refresh(this.lifecycle.currentGeneration())
      }))
    }
  }

  private readonly attach = (generation: number): void => {
    this.ticket += 1
    this.records = undefined
    this.browser?.close()
    this.browser = undefined
    this.stopTimer()
    if (this.lifecycle.selection(generation) !== undefined) void this.refresh(generation)
    this.publish()
  }

  private async refresh(generation: number, signal?: AbortSignal): Promise<void> {
    const current = this.lifecycle.selection(generation)
    if (signal?.aborted || current === undefined) return
    const ticket = ++this.ticket
    try {
      const list = await current.client.remote.schedule.catalog()
      if (signal?.aborted || !this.lifecycle.owns(generation) || ticket !== this.ticket) return
      this.records = list.ok ? list.value.filter(record => record.status === 'active' && record.involvedSessionIds.includes(current.ref.sessionId)) : undefined
    } catch {
      if (signal?.aborted || !this.lifecycle.owns(generation) || ticket !== this.ticket) return
      this.records = undefined
      }
    this.publish()
  }

  private publish(): void {
    this.status.set(this.records?.length ? { kind: 'text', content: this.t('Reminders {count}', { count: this.records.length }) } : null)
    this.browser?.refresh()
  }

  private view(): ReturnType<typeof remoteScheduleNode> {
    return remoteScheduleNode(this.records, Date.now(), this.t, this.options.ctx.mayflyLocale.snapshot.locale)
  }

  private stopTimer(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  private open(parent: AbortSignal): void {
    const current = this.options.hosts.current()
    if (current === undefined) {
      this.options.notice.set(this.t('Schedule unavailable'), 'error')
      return
    }
    if (this.browser?.closed === false) { this.options.ctx.mayflyOverlays.focus('remote.schedule'); return }
    const lifetime = new AbortController()
    const signal = AbortSignal.any([lifetime.signal, parent])
    this.stopTimer()
    this.timer = setInterval(() => this.browser?.refresh(), 1_000)
    this.timer.unref()
    this.browser = openRemoteBrowser(this.options, {
      id: 'remote.schedule',
      scope: { kind: 'session', sessionId: current.ref.sessionId }, signal,
      isCurrent: () => !signal.aborted && isRemoteFeatureSelection(this.options.hosts.current(), current.client, current.ref),
      view: () => this.view(),
      action: async (event, context) => {
        const actionSignal = AbortSignal.any([signal, context.signal])
        if (actionSignal.aborted) return { kind: 'cancelled' }
        if (event.kind === 'activate' && event.actionId === 'refresh') await this.refresh(this.lifecycle.currentGeneration(), actionSignal)
        return { kind: actionSignal.aborted ? 'cancelled' : 'completed' }
      },
      onClosed: () => {
        lifetime.abort()
        this.browser = undefined
        this.stopTimer()
      },
    })
    void this.refresh(this.lifecycle.currentGeneration(), signal)
  }

  readonly execute = async (_rawInput: string, parent: AbortSignal): Promise<void> => {
    if (this.disposed || parent.aborted) return
    this.open(parent)
  }
}

/** Mount official Schedule reads, events, status, and selected/Host-wide reminder panels. */
export function mountScheduleFeature(options: RemoteFeatureContext): () => void {
  const controller = new RemoteScheduleController(options)
  const unregister = options.commands.register({
    name: 'schedule',
    description: 'Inspect session reminders',
    execute: controller.execute,
  })
  return () => {
    unregister()
    controller.dispose()
  }
}
