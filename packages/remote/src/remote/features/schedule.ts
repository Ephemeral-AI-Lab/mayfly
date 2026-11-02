/**
 * Official Schedule list/catalog reads and change events with selection fencing.
 * @module @ephemeral-ai/mayfly/remote/features/schedule
 */

import { memoizedLocaleTranslator, type MayflyTranslate } from '@ephemeral-ai/mayfly/frontend'
import type { MayflyStatusRegistration } from '@ephemeral-ai/mayfly-ui'
import type { HostClient } from '../../client/types.ts'
import type { RemoteFeatureContext } from '../features.ts'
import { openRemoteBrowser, type RemoteBrowserPanel } from '../panels/browser.ts'
import {
  remoteScheduleNode,
  type RemoteScheduleCatalogEntry,
  type RemoteScheduleRecord,
} from '../panels/schedule.ts'
import { isRemoteFeatureSelection } from '../interactions/selection.ts'
import { RemoteFeatureLifecycle } from './lifecycle.ts'

const zh = {
  'Inspect session reminders': '查看会话提醒',
  'Inspect all Host reminders': '查看所有 Host 提醒',
  'Reminders': '提醒',
  'Host reminders': 'Host 提醒',
  'Reminders {count}': '提醒 {count}',
  'Reminders unavailable': '提醒不可用',
  'Schedule': 'Schedule',
  'Schedule unavailable': 'Schedule 不可用',
  'Enable the Schedule service on the Host, then refresh.': '请在 Host 启用 Schedule 服务，然后刷新。',
  'Reminders follow their original session, even when no Agent is running. Create or cancel reminders through the conversation.': '提醒跟随原会话，即使没有 Agent 运行。请通过对话创建或取消提醒。',
  'No active reminders': '没有活动提醒',
  'Refresh': '刷新',
  'refresh': '刷新',
  'Daily': '每天',
  'Weekly': '每周',
  'Cron': 'Cron',
  'Once': '一次',
  'Every {value} {unit}': '每 {value} 个{unit}',
  'day': '天',
  'days': '天',
  'hour': '小时',
  'hours': '小时',
  'minute': '分钟',
  'minutes': '分钟',
  'second': '秒',
  'seconds': '秒',
  'Due now': '现在到期',
  'in {value} {unit}': '{value} {unit}后',
  '{value} {unit} overdue': '已逾期 {value} {unit}',
  'Overdue': '已逾期',
  'Scheduled': '已计划',
  'Inactive': '未激活',
  'active': '活动',
  'inactive': '未激活',
  'Session': '会话',
} as const

class RemoteScheduleController {
  private readonly options: RemoteFeatureContext
  private readonly t: MayflyTranslate
  private readonly lifecycle: RemoteFeatureLifecycle
  private readonly status: MayflyStatusRegistration
  private readonly hostListeners = new Map<HostClient, () => void>()
  private readonly offTopology: () => void
  private records: readonly RemoteScheduleRecord[] | undefined
  private catalog: readonly RemoteScheduleCatalogEntry[] | undefined
  private listError: string | undefined
  private catalogError: string | undefined
  private ticket = 0
  private browser: RemoteBrowserPanel | undefined
  private mode: 'session' | 'catalog' = 'session'
  private timer: ReturnType<typeof setInterval> | undefined
  private disposed = false

  constructor(options: RemoteFeatureContext) {
    this.options = options
    this.t = memoizedLocaleTranslator(options.ctx, 'remote-schedule').translate
    this.lifecycle = new RemoteFeatureLifecycle(options, this.attach)
    this.status = options.ctx.mayflyStatus.register({ id: 'mayfly.schedule', priority: 2, overflow: 'hide' }, null)
    this.offTopology = options.hosts.subscribe(this.reconcileHosts)
    options.ctx.effect(() => options.ctx.mayflyLocale.register('remote-schedule', {
      en: Object.freeze(Object.fromEntries(Object.keys(zh).map(key => [key, key]))),
      zh,
    }))
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
    this.catalog = undefined
    this.listError = undefined
    this.catalogError = undefined
    this.browser?.close()
    this.browser = undefined
    this.stopTimer()
    if (this.lifecycle.selection(generation) !== undefined) void this.refresh(generation)
    this.publish()
  }

  private async refresh(generation: number): Promise<void> {
    const current = this.lifecycle.selection(generation)
    if (current === undefined) return
    const ticket = ++this.ticket
    try {
      const [list, catalog] = await Promise.all([
        current.client.remote.schedule.list({ sessionId: current.ref.sessionId }),
        current.client.remote.schedule.catalog(),
      ])
      if (!this.lifecycle.owns(generation) || ticket !== this.ticket) return
      if (list.ok) {
        this.records = list.value
        this.listError = undefined
      } else {
        this.records = undefined
        this.listError = list.error.message
      }
      if (catalog.ok) {
        this.catalog = catalog.value
        this.catalogError = undefined
      } else {
        this.catalog = undefined
        this.catalogError = catalog.error.message
      }
    } catch (error) {
      if (!this.lifecycle.owns(generation) || ticket !== this.ticket) return
      const message = error instanceof Error ? error.message : String(error)
      this.records = undefined
      this.catalog = undefined
      this.listError = message
      this.catalogError = message
    }
    this.publish()
  }

  private publish(): void {
    this.status.set(this.records === undefined
      ? this.listError === undefined ? null : { kind: 'text', content: this.t('Reminders unavailable'), tone: 'warning' }
      : this.records.length === 0 ? null : { kind: 'text', content: this.t('Reminders {count}', { count: this.records.length }), tone: 'muted' })
    this.browser?.refresh()
  }

  private view(): ReturnType<typeof remoteScheduleNode> {
    const catalog = this.mode === 'catalog'
    return remoteScheduleNode(catalog ? this.catalog : this.records, Date.now(), this.t, this.options.ctx.mayflyLocale.snapshot.locale, {
      title: catalog ? 'Host reminders' : 'Reminders',
      catalog,
      ...catalog && this.catalogError !== undefined ? { error: this.catalogError } : !catalog && this.listError !== undefined ? { error: this.listError } : {},
    })
  }

  private stopTimer(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  private open(mode: 'session' | 'catalog'): void {
    const current = this.options.hosts.current()
    if (current === undefined) {
      this.options.notice.set(this.t('Schedule unavailable'))
      return
    }
    this.mode = mode
    this.browser?.close()
    this.browser = openRemoteBrowser(this.options, {
      id: 'remote.schedule',
      scope: { kind: 'session', sessionId: current.ref.sessionId },
      isCurrent: () => isRemoteFeatureSelection(this.options.hosts.current(), current.client, current.ref),
      view: () => this.view(),
      action: event => {
        if (event.kind === 'activate' && event.actionId === 'refresh') void this.refresh(this.lifecycle.currentGeneration())
        return { kind: 'completed' }
      },
      onClosed: () => {
        this.browser = undefined
        this.stopTimer()
      },
    })
    this.stopTimer()
    this.timer = setInterval(() => this.browser?.refresh(), 1_000)
    this.timer.unref()
    void this.refresh(this.lifecycle.currentGeneration())
  }

  readonly execute = async (rawInput: string): Promise<void> => {
    const input = rawInput.trim()
    if (input !== '' && input !== 'all') throw new Error('Usage: /schedule [all]')
    this.open(input === 'all' ? 'catalog' : 'session')
  }
}

/** Mount official Schedule reads, events, status, and selected/Host-wide reminder panels. */
export function mountScheduleFeature(options: RemoteFeatureContext): () => void {
  const controller = new RemoteScheduleController(options)
  const unregister = options.commands.register({
    name: 'schedule',
    description: 'Inspect session reminders',
    input: { hint: '[all]' },
    execute: controller.execute,
  })
  return () => {
    unregister()
    controller.dispose()
  }
}
