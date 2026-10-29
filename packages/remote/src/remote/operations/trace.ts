/**
 * `/trace` recent session event browser over the same backwards event pages,
 * with secret-free JSON detail and clipboard copy.
 * @module @ephemeral-ai/mayfly/remote/operations/trace
 */

import { memoizedLocaleTranslator } from '@ephemeral-ai/mayfly/frontend'
import type { SessionWireEvent } from '@deepseek-ai/dsh-api-session-controller/types'
import type { MayflyTranslate, MayflyUiActionEvent, MayflyUiActionReply, MayflyUiObservationEvent } from '@ephemeral-ai/mayfly-ui'
import { openRemoteBrowser, type RemoteBrowserPanel } from '../panels/browser.ts'
import {
  REMOTE_TRACE_COPY_ID, REMOTE_TRACE_LIST_ID, REMOTE_TRACE_REFRESH_ID, remoteTracePanel,
  type RemoteTraceRow,
} from '../panels/operations/trace.ts'
import { isRemoteFeatureSelection } from '../interactions/selection.ts'
import { remoteErrorMessage } from '../features/official.ts'
import {
  collectRemoteSessionEvents, isRemoteRecord, redactRemoteSecrets, registerRemoteOperationsLocale,
  type RemoteOperationsContext,
} from './support.ts'

/** Number of newest events one trace read keeps. */
const TRACE_ROW_LIMIT = 50

/** Page size of one trace read. */
const TRACE_PAGE_MESSAGES = 500

const zh: Readonly<Record<string, string>> = {
  'Inspect recent session events with JSON detail': '检查最近的会话事件及其 JSON 详情',
  'Session trace': '会话事件追踪',
  'No session events': '没有会话事件',
  'Select an event to inspect its JSON': '选择一个事件查看其 JSON',
  'copy': '复制',
  'Refresh': '刷新',
  'refresh': '刷新',
  'No current session': '当前没有会话',
  'Copied the event JSON': '已复制事件 JSON',
  'Copying is unavailable in this frontend': '当前前端不支持复制',
  'The event is no longer available': '该事件已不可用',
  'Could not copy: {message}': '复制失败：{message}',
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/u).find(candidate => candidate.trim() !== '') ?? ''
  return line.trim().slice(0, 80)
}

function contentPreview(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!isRemoteRecord(block)) continue
    if (block['type'] === 'text' && typeof block['text'] === 'string') parts.push(block['text'])
    else if (block['type'] === 'image') parts.push('[image]')
  }
  return firstLine(parts.join(' '))
}

function messageContent(data: unknown): unknown {
  return isRemoteRecord(data) && isRemoteRecord(data['message']) ? data['message']['content'] : undefined
}

/** One event's one-line summary, derived only from its wire data. */
export function remoteTraceSummary(event: SessionWireEvent): string {
  const data = event.data
  switch (event.type) {
    case 'user/message':
      return contentPreview(isRemoteRecord(data) ? data['content'] : undefined)
    case 'assistant/message':
      return contentPreview(messageContent(data))
    case 'tool/call':
      return isRemoteRecord(data) && typeof data['name'] === 'string' ? data['name'] : ''
    case 'tool/result':
      return contentPreview(messageContent(data))
    case 'turn/end': {
      const reason = isRemoteRecord(data) ? data['reason'] : undefined
      return isRemoteRecord(reason) && typeof reason['kind'] === 'string' ? reason['kind'] : ''
    }
    default:
      return ''
  }
}

class RemoteTraceController {
  private readonly t: MayflyTranslate
  private rows: readonly RemoteTraceRow[] = []
  private selectedId: string | undefined
  private detail: string | undefined
  private error: string | undefined
  private browser: RemoteBrowserPanel | undefined
  private lifetime = new AbortController()
  private disposed = false

  constructor(private readonly context: RemoteOperationsContext) {
    const { base } = context
    this.t = memoizedLocaleTranslator(base.ctx, 'remote-operations-trace').translate
    registerRemoteOperationsLocale(base, 'remote-operations-trace', zh)
  }

  readonly dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    this.lifetime.abort()
    this.browser?.close()
  }

  private detailOf(event: SessionWireEvent | undefined): string | undefined {
    if (event === undefined) return undefined
    return JSON.stringify(redactRemoteSecrets({ type: event.type, seq: event.seq, time: event.time, data: event.data }), null, 2)
  }

  private publish(): void {
    this.browser?.refresh()
  }

  private async load(signal: AbortSignal): Promise<void> {
    const current = this.context.base.hosts.current()
    if (current === undefined) {
      this.error = this.t('No current session')
      this.rows = []
      this.publish()
      return
    }
    try {
      const events = await collectRemoteSessionEvents(current.client, {
        address: { kind: 'session', sessionId: current.ref.sessionId },
        maxMessages: TRACE_PAGE_MESSAGES,
        minEvents: TRACE_ROW_LIMIT,
        signal,
      })
      if (!isRemoteFeatureSelection(this.context.base.hosts.current(), current.client, current.ref)) return
      this.rows = events.slice(-TRACE_ROW_LIMIT).map(event => ({ event, summary: remoteTraceSummary(event) }))
      this.error = undefined
      if (this.selectedId !== undefined && !this.rows.some(item => String(item.event.seq) === this.selectedId)) {
        this.selectedId = undefined
        this.detail = undefined
      }
    } catch (error: unknown) {
      if (signal.aborted) return
      this.rows = []
      this.error = remoteErrorMessage(error)
    }
    this.publish()
  }

  private open(): void {
    const current = this.context.base.hosts.current()
    if (current === undefined) {
      this.context.base.notice.set(this.t('No current session'))
      return
    }
    this.browser?.close()
    this.browser = openRemoteBrowser(this.context.base, {
      id: 'remote.operations.trace',
      scope: { kind: 'session', sessionId: current.ref.sessionId },
      isCurrent: () => isRemoteFeatureSelection(this.context.base.hosts.current(), current.client, current.ref),
      view: () => remoteTracePanel({
        rows: this.rows,
        selectedId: this.selectedId,
        detail: this.detail,
        canCopy: this.context.options.copy !== undefined,
        error: this.error,
      }, this.t),
      observe: event => this.observe(event),
      action: (event, context) => this.act(event, context.signal),
      onClosed: () => { this.browser = undefined },
    })
    void this.load(this.lifetime.signal)
  }

  private observe(_event: MayflyUiObservationEvent): void {
    // List selection arrives on the action face; observations only invalidate the paint.
  }

  private select(id: string | undefined): void {
    this.selectedId = id
    this.detail = this.detailOf(this.rows.find(item => String(item.event.seq) === id)?.event)
    this.publish()
  }

  private async act(event: MayflyUiActionEvent, signal: AbortSignal): Promise<MayflyUiActionReply> {
    if (event.kind === 'selection-accept') {
      if (event.controlId !== REMOTE_TRACE_LIST_ID && event.controlId !== 'trace-events-narrow') return { kind: 'completed' }
      this.select(event.selectedIds[0])
      return { kind: 'completed' }
    }
    if (event.kind !== 'activate') return { kind: 'completed' }
    if (event.actionId === REMOTE_TRACE_REFRESH_ID) {
      await this.load(signal)
      return { kind: 'completed' }
    }
    if (event.actionId !== REMOTE_TRACE_COPY_ID) return { kind: 'completed' }
    const copy = this.context.options.copy
    if (copy === undefined) return { kind: 'failed', message: this.t('Copying is unavailable in this frontend') }
    const detail = this.detail
    if (detail === undefined) return { kind: 'failed', message: this.t('The event is no longer available') }
    try {
      await copy(detail)
      this.context.base.notice.set(this.t('Copied the event JSON'))
      return { kind: 'completed' }
    } catch (error: unknown) {
      return { kind: 'failed', message: this.t('Could not copy: {message}', { message: remoteErrorMessage(error) }) }
    }
  }

  readonly execute = async (rawInput: string, signal: AbortSignal): Promise<void> => {
    const filter = rawInput.trim().toLowerCase()
    if (filter !== '') {
      const current = this.context.base.hosts.current()
      if (current === undefined) throw new Error(this.t('No current session'))
      const events = await collectRemoteSessionEvents(current.client, {
        address: { kind: 'session', sessionId: current.ref.sessionId },
        maxMessages: TRACE_PAGE_MESSAGES,
        minEvents: TRACE_ROW_LIMIT,
        signal,
      })
      this.rows = events
        .slice(-TRACE_ROW_LIMIT)
        .map(event => ({ event, summary: remoteTraceSummary(event) }))
        .filter(item => `${item.event.type} ${item.summary} ${String(item.event.seq)}`.toLowerCase().includes(filter))
      this.selectedId = undefined
      this.detail = undefined
    }
    this.open()
  }
}

/** Mount the `/trace` recent-event browser command. */
export function mountRemoteTraceOperations(context: RemoteOperationsContext): () => void {
  const controller = new RemoteTraceController(context)
  const unregister = context.base.commands.register({
    name: 'trace',
    description: 'Inspect recent session events with JSON detail',
    input: { hint: '[<filter>]' },
    execute: controller.execute,
  })
  return () => {
    unregister()
    controller.dispose()
  }
}
