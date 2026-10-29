/**
 * `/stats` current Session statistics from live projections plus the Host
 * session catalog snapshot.
 * @module @ephemeral-ai/mayfly/remote/operations/stats
 */

import { memoizedLocaleTranslator } from '@ephemeral-ai/mayfly/frontend'
import type { MayflyTranslate } from '@ephemeral-ai/mayfly-ui'
import type { RemoteFeatureSelection } from '../features.ts'
import { openRemoteBrowser, type RemoteBrowserPanel } from '../panels/browser.ts'
import { remoteStatsPanel, type RemoteStatsState } from '../panels/operations/stats.ts'
import { isRemoteFeatureSelection } from '../interactions/selection.ts'
import { RemoteFeatureLifecycle } from '../features/lifecycle.ts'
import {
  isRemoteRecord, registerRemoteOperationsLocale, remoteReadNumber, remoteReadString,
  type RemoteOperationsContext,
} from './support.ts'

/** Projections the stats panel reads at one cursor. */
const STATS_KEYS = ['sessionStats', 'tokenUsage', 'contextPressure', 'modelSelection'] as const

/** Recent catalog rows the panel lists. */
const RECENT_LIMIT = 8

const zh: Readonly<Record<string, string>> = {
  'Show current session statistics': '显示当前会话统计',
  'Session statistics': '会话统计',
  'Session': '会话',
  'Turns': '轮数',
  'Steps': '步骤数',
  'Model': '模型',
  'Provider': '提供商',
  'Reasoning': '推理强度',
  'Tokens': '令牌',
  'Input': '输入',
  'Cache read': '缓存读取',
  'Cache write': '缓存写入',
  'Output': '输出',
  'Context': '上下文',
  'Used': '已占用',
  'Window': '窗口',
  'Share': '占比',
  'Host sessions': 'Host 会话',
  'Total': '总数',
  'No sessions in the Host catalog': 'Host 目录中没有会话',
  'live': '运行中',
  'unavailable': '不可用',
  'default': '默认',
  'Figures come from live projections; no full history is replayed for this panel.': '数字来自实时投影；本面板不回放完整历史。',
  'No current session': '当前没有会话',
  'Usage: /stats': '用法：/stats',
}

/** The empty state shown before the first projection read lands. */

function readStatsSession(value: unknown): RemoteStatsState['session'] {
  return {
    turns: remoteReadNumber(value, 'turns'),
    steps: remoteReadNumber(value, 'steps'),
    llmMs: remoteReadNumber(value, 'llmMs'),
    toolMs: remoteReadNumber(value, 'toolMs'),
    ttftMs: remoteReadNumber(value, 'ttftMs'),
    decodeMs: remoteReadNumber(value, 'decodeMs'),
    decodeTokens: remoteReadNumber(value, 'decodeTokens'),
  }
}

function readStatsUsage(value: unknown): RemoteStatsState['usage'] {
  return {
    input: remoteReadNumber(value, 'uncachedInputTokens'),
    cacheRead: remoteReadNumber(value, 'cacheReadTokens'),
    cacheWrite: remoteReadNumber(value, 'cacheWriteTokens'),
    output: remoteReadNumber(value, 'outputTokens'),
  }
}

function readStatsContext(value: unknown): RemoteStatsState['context'] {
  const used = remoteReadNumber(value, 'projectedTokens') ?? remoteReadNumber(value, 'pressureTokens')
  return { used, window: remoteReadNumber(value, 'contextWindow') }
}

function readStatsModel(value: unknown): RemoteStatsState['model'] {
  const route = isRemoteRecord(value) ? (isRemoteRecord(value['next']) ? value['next'] : isRemoteRecord(value['lastUsed']) ? value['lastUsed'] : undefined) : undefined
  return {
    provider: remoteReadString(route, 'provider'),
    model: remoteReadString(route, 'model'),
    reasoningEffort: remoteReadString(route, 'reasoningEffort'),
  }
}

class RemoteStatsController {
  private readonly t: MayflyTranslate
  private readonly lifecycle: RemoteFeatureLifecycle
  private state: RemoteStatsState | undefined
  private browser: RemoteBrowserPanel | undefined
  private subscriptions: readonly (() => void)[] = []
  private disposed = false

  constructor(private readonly context: RemoteOperationsContext) {
    const { base } = context
    this.t = memoizedLocaleTranslator(base.ctx, 'remote-operations-stats').translate
    registerRemoteOperationsLocale(base, 'remote-operations-stats', zh)
    this.lifecycle = new RemoteFeatureLifecycle(base, this.attach)
    this.lifecycle.start()
  }

  readonly dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    this.lifecycle.dispose()
    for (const dispose of this.subscriptions) dispose()
    this.subscriptions = []
    this.browser?.close()
  }

  private readonly attach = (generation: number): void => {
    if (this.disposed) return
    for (const dispose of this.subscriptions) dispose()
    this.subscriptions = []
    this.browser?.close()
    this.browser = undefined
    this.state = undefined
    const current = this.lifecycle.selection(generation)
    if (current !== undefined) {
      const faces = STATS_KEYS.map(key => current.binding.session.projections.faceOf(key))
      const catalog = current.client.sessions.list
      const update = (): void => { this.read(current) }
      this.subscriptions = [...faces.map(face => face.subscribe(update)), catalog.subscribe(update)]
      this.read(current)
    }
  }

  private read(current: RemoteFeatureSelection): void {
    const values = Object.fromEntries(STATS_KEYS.map(key => [key, current.binding.session.projections.faceOf(key).getSnapshot()]))
    const catalog = current.client.sessions.list.getSnapshot()
    const recent = catalog.ids
      .map(id => ({ id, summary: catalog.byId[id] }))
      .filter((entry): entry is { id: typeof entry.id, summary: NonNullable<typeof entry.summary> } => entry.summary !== undefined)
      .toSorted((left, right) => (right.summary.updatedAt ?? 0) - (left.summary.updatedAt ?? 0))
      .slice(0, RECENT_LIMIT)
      .map(entry => ({
        id: entry.id,
        title: entry.summary.displayTitle,
        updatedAt: entry.summary.updatedAt,
        running: entry.summary.running,
        current: entry.id === current.ref.sessionId,
      }))
    this.state = {
      sessionId: current.ref.sessionId,
      session: readStatsSession(values['sessionStats']),
      usage: readStatsUsage(values['tokenUsage']),
      context: readStatsContext(values['contextPressure']),
      model: readStatsModel(values['modelSelection']),
      totalSessions: catalog.ids.length,
      recent,
      error: undefined,
    }
    this.browser?.refresh()
  }

  readonly execute = async (rawInput: string): Promise<void> => {
    if (rawInput.trim() !== '') throw new Error(this.t('Usage: /stats'))
    const current = this.context.base.hosts.current()
    if (current === undefined) throw new Error(this.t('No current session'))
    this.browser?.close()
    this.browser = openRemoteBrowser(this.context.base, {
      id: 'remote.operations.stats',
      scope: { kind: 'session', sessionId: current.ref.sessionId },
      isCurrent: () => isRemoteFeatureSelection(this.context.base.hosts.current(), current.client, current.ref),
      view: () => remoteStatsPanel(this.state ?? {
        sessionId: current.ref.sessionId,
        session: { turns: undefined, steps: undefined, llmMs: undefined, toolMs: undefined, ttftMs: undefined, decodeMs: undefined, decodeTokens: undefined },
        usage: { input: undefined, cacheRead: undefined, cacheWrite: undefined, output: undefined },
        context: { used: undefined, window: undefined },
        model: { provider: undefined, model: undefined, reasoningEffort: undefined },
        totalSessions: undefined,
        recent: [],
        error: undefined,
      }, this.t),
      onClosed: () => { this.browser = undefined },
    })
  }
}

/** Mount the `/stats` session statistics command and panel. */
export function mountRemoteStatsOperations(context: RemoteOperationsContext): () => void {
  const controller = new RemoteStatsController(context)
  const unregister = context.base.commands.register({
    name: 'stats',
    description: 'Show current session statistics',
    execute: controller.execute,
  })
  return () => {
    unregister()
    controller.dispose()
  }
}
