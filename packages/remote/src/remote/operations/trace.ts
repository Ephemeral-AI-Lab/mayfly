/** The rc.2 `/trace` timeline and copy commands over passive native Host observations. @module */
import { memoizedLocaleTranslator } from '@ephemeral-ai/mayfly/frontend'
import { TRACE_BREAKPOINT, tracePanelModel, formatTraceAll, formatTraceItem, type TraceItem } from '@ephemeral-ai/mayfly/trace'
import type { MayflyTranslate, MayflyUiActionEvent, MayflyUiActionReply } from '@ephemeral-ai/mayfly-ui'
import type { RemoteFeatureSelection } from '../features.ts'
import { mayflyHostRemote } from '../../frontend/host-mount.ts'
import { openRemoteBrowser, type RemoteBrowserPanel } from '../panels/browser.ts'
import { isRemoteFeatureSelection } from '../interactions/selection.ts'
import { RemoteFeatureOperation, remoteErrorMessage, remoteValue } from '../features/official.ts'
import { RemoteFeatureLifecycle } from '../features/lifecycle.ts'
import { hasMayflyHostFeature, unavailableCapability } from '../features/capabilities.ts'
import { registerRemoteOperationsLocale, type RemoteOperationsContext } from './support.ts'

const ROOT = 'mayfly.trace'
type TraceCopyReply =
  | { readonly kind: 'completed', readonly feedback: { readonly severity: 'success', readonly message: string } }
  | { readonly kind: 'failed', readonly message: string }
  | { readonly kind: 'cancelled' }
const zh: Readonly<Record<string, string>> = {
  'Browse and copy the current session execution trace': '浏览并复制当前会话执行轨迹',
  'Trace': '跟踪',
  'Trace detail': '跟踪详情',
  'Surface': '界面',
  'Copy trace item': '复制跟踪项',
  'no trace events yet': '暂无跟踪事件',
  'copied trace item #{seq}': '已复制跟踪项 #{seq}',
  'copied {count} trace events': '已复制 {count} 条跟踪事件',
  'could not copy trace: {error}': '无法复制跟踪：{error}',
  'could not read trace: {error}': '无法读取跟踪：{error}',
  'trace event #{seq} was not found': '未找到跟踪事件 #{seq}',
  'no session is live yet': '当前还没有活动会话',
  ' via terminal escape sequence (unverified)': ' 通过终端转义序列（未经校验）',
  'Copying is unavailable in this frontend': '当前前端不支持复制',
}

class RemoteTraceController {
  private readonly t: MayflyTranslate
  private readonly lifecycle: RemoteFeatureLifecycle
  private browser: RemoteBrowserPanel | undefined
  private lifetime = new AbortController()
  private items: readonly TraceItem[] = []
  private selected: TraceItem | undefined
  private document: string | undefined
  private narrow: 'list' | 'detail' = 'list'
  private ticket = 0
  private detailTicket = 0
  private disposed = false

  constructor(private readonly context: RemoteOperationsContext) {
    this.t = memoizedLocaleTranslator(context.base.ctx, 'remote-operations-trace').translate
    registerRemoteOperationsLocale(context.base, 'remote-operations-trace', zh)
    this.lifecycle = new RemoteFeatureLifecycle(context.base, this.attach)
    this.lifecycle.start()
  }

  readonly dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    this.lifecycle.dispose()
    this.ticket += 1
    this.detailTicket += 1
    this.lifetime.abort()
    this.browser?.close()
  }

  private readonly attach = (): void => {
    this.ticket += 1
    this.detailTicket += 1
    this.lifetime.abort()
    this.lifetime = new AbortController()
    this.browser?.close()
    this.browser = undefined
    this.items = []
    this.selected = undefined
    this.document = undefined
    this.narrow = 'list'
  }

  private operation(current: RemoteFeatureSelection, signal: AbortSignal): RemoteFeatureOperation {
    return new RemoteFeatureOperation(this.context.base, current.client, current, AbortSignal.any([signal, this.lifetime.signal]))
  }

  private columns(): number {
    return this.context.base.ctx.get('mayflyScreen')?.columns ?? Number.POSITIVE_INFINITY
  }

  private publish(): void { this.browser!.refresh() }

  private open(current: RemoteFeatureSelection, signal: AbortSignal): void {
    this.selected = undefined
    this.document = undefined
    this.narrow = 'list'
    const generation = this.lifecycle.currentGeneration()
    const owner = new AbortController()
    this.browser = openRemoteBrowser(this.context.base, {
      id: ROOT,
      scope: { kind: 'session', sessionId: current.ref.sessionId },
      signal: AbortSignal.any([signal, owner.signal]),
      isCurrent: () => this.lifecycle.owns(generation) && isRemoteFeatureSelection(this.context.base.hosts.current(), current.client, current.ref),
      view: () => tracePanelModel(String(current.ref.sessionId), this.items, this.t, {
        selected: this.selected,
        document: this.document,
        narrow: this.narrow,
        escapeLabel: this.narrow === 'detail' && this.columns() < TRACE_BREAKPOINT ? 'back' : 'close',
      }),
      action: (event, context) => this.act(current, event, AbortSignal.any([context.signal, owner.signal])),
      back: () => {
        if (this.narrow !== 'detail' || this.columns() >= TRACE_BREAKPOINT) return false
        this.narrow = 'list'
        this.publish()
        return true
      },
      onClosed: () => { owner.abort(); this.browser = undefined },
    })
  }

  private async copy(current: RemoteFeatureSelection, item: TraceItem | undefined, items: readonly TraceItem[], signal: AbortSignal): Promise<TraceCopyReply> {
    const operation = this.operation(current, signal)
    try {
      const copy = this.context.options.copy
      if (copy === undefined) return { kind: 'failed', message: this.t('Copying is unavailable in this frontend') }
      const detail = item === undefined ? undefined : await remoteValue(mayflyHostRemote(current.client).traceDetail({ sessionId: current.ref.sessionId, seq: item.seq, eventSeqs: item.eventSeqs }, operation.signal))
      if (!operation.valid()) return { kind: 'cancelled' }
      const text = item === undefined ? formatTraceAll(items, String(current.ref.sessionId)) : formatTraceItem(item, undefined, detail!.relation, detail!.rawEvents)
      const method = await copy(text)
      if (!operation.valid()) return { kind: 'cancelled' }
      const message = (item === undefined ? this.t('copied {count} trace events', { count: items.length }) : this.t('copied trace item #{seq}', { seq: item.seq }))
        + (method === 'osc52' ? this.t(' via terminal escape sequence (unverified)') : '')
      return { kind: 'completed', feedback: { severity: 'success', message } }
    } catch (error) {
      return operation.valid() ? { kind: 'failed', message: this.t('could not copy trace: {error}', { error: remoteErrorMessage(error) }) } : { kind: 'cancelled' }
    } finally { operation.dispose() }
  }

  private async act(current: RemoteFeatureSelection, event: MayflyUiActionEvent, signal: AbortSignal): Promise<MayflyUiActionReply> {
    if (event.kind === 'activate' && event.actionId === 'copy-all') return await this.copy(current, undefined, this.items, signal)
    if (event.kind === 'activate' && event.actionId === 'copy') return await this.copy(current, this.selected, this.items, signal)
    if (event.kind !== 'selection-accept' || event.controlId !== 'trace-events') return { kind: 'completed' }
    const item = this.items.find(item => String(item.seq) === event.selectedIds[0])
    if (item === undefined) return { kind: 'completed' }
    const ticket = ++this.detailTicket
    const operation = this.operation(current, signal)
    try {
      const detail = await remoteValue(mayflyHostRemote(current.client).traceDetail({ sessionId: current.ref.sessionId, seq: item.seq, eventSeqs: item.eventSeqs }, operation.signal))
      if (!operation.valid() || ticket !== this.detailTicket) return { kind: 'cancelled' }
      this.selected = item
      this.document = JSON.stringify(detail.rawEvents, null, 2)
      if (this.columns() < TRACE_BREAKPOINT) this.narrow = 'detail'
      this.publish()
      return { kind: 'completed' }
    } catch (error) {
      return operation.valid() && ticket === this.detailTicket ? { kind: 'failed', message: this.t('could not read trace: {error}', { error: remoteErrorMessage(error) }) } : { kind: 'cancelled' }
    } finally { operation.dispose() }
  }

  readonly execute = async (rawInput: string, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted()
    const current = this.context.base.hosts.current()
    if (current === undefined) throw new Error(this.t('no session is live yet'))
    const input = rawInput.trim()
    if (input === '' && this.context.base.ctx.mayflyOverlays.focus(ROOT)) return
    const ticket = ++this.ticket
    const operation = this.operation(current, signal)
    try {
      let items: readonly TraceItem[]
      try {
        if (!await hasMayflyHostFeature(current.client, 'trace', operation.signal)) throw new Error(unavailableCapability('trace'))
        if (!operation.valid() || ticket !== this.ticket) return
        items = await remoteValue(mayflyHostRemote(current.client).traceCatalog({ sessionId: current.ref.sessionId }, operation.signal))
      } catch (error) {
        throw new Error(this.t('could not read trace: {error}', { error: remoteErrorMessage(error) }))
      }
      if (!operation.valid() || ticket !== this.ticket) return
      if (input !== '') {
        const match = /^copy\s+(\d+)$/u.exec(input)
        if (input !== 'copy all' && match === null) throw new Error('usage: /trace [copy <seq>|copy all]')
        const item = match === null ? undefined : items.find(item => item.seq === Number(match[1]))
        if (match !== null && item === undefined) throw new Error(this.t('trace event #{seq} was not found', { seq: match[1]! }))
        const reply = await this.copy(current, item, items, operation.signal)
        if (reply.kind === 'failed') throw new Error(reply.message)
        if (reply.kind === 'completed' && operation.valid() && ticket === this.ticket) this.context.base.notice.set(reply.feedback.message, 'info')
        return
      }
      this.items = items
      this.open(current, signal)
    } catch (error) {
      if (!operation.valid() || ticket !== this.ticket) return
      throw error
    } finally { operation.dispose() }
  }
}

/** Mount the reference trace browser and `/trace copy <seq>|copy all` commands. */
export function mountRemoteTraceOperations(context: RemoteOperationsContext): () => void {
  const controller = new RemoteTraceController(context)
  const unregister = context.base.commands.register({
    name: 'trace',
    description: 'Browse and copy the current session execution trace',
    input: { hint: '[copy <seq>|copy all]' },
    execute: controller.execute,
  })
  return () => { unregister(); controller.dispose() }
}
