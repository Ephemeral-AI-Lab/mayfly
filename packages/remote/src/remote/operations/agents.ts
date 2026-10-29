/**
 * `/agents` descendant tree over the session catalog and official subagent
 * addresses, with drain-to-stop, cold read-only views, and addressed prompts.
 * @module @ephemeral-ai/mayfly/remote/operations/agents
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { memoizedLocaleTranslator } from '@ephemeral-ai/mayfly/frontend'
import { ui, type MayflyTranslate, type MayflyUiActionEvent, type MayflyUiActionReply, type MayflyUiObservationEvent } from '@ephemeral-ai/mayfly-ui'
import type { SessionRef } from '../../client/types.ts'
import type { RemoteFeatureSelection } from '../features.ts'
import { openRemoteBrowser, type RemoteBrowserPanel } from '../panels/browser.ts'
import {
  REMOTE_AGENTS_LIST_ID, REMOTE_AGENTS_OPEN_ID, REMOTE_AGENTS_PROMPT_ID, REMOTE_AGENTS_REFRESH_ID,
  REMOTE_AGENTS_STOP_ID, remoteAgentsPanel, type RemoteAgentMode, type RemoteAgentRow,
} from '../panels/operations/agents.ts'
import { requestOverlay, type RemoteRequestOverlay } from '../interactions/request-overlay.ts'
import { isRemoteFeatureSelection } from '../interactions/selection.ts'
import { RemoteFeatureLifecycle } from '../features/lifecycle.ts'
import { remoteErrorMessage } from '../features/official.ts'
import { mayflyHostRemote } from '../../frontend/host-mount.ts'
import { registerRemoteOperationsLocale, type RemoteOperationsContext } from './support.ts'

const COLD_ROLE = 'remote-agents-cold'

interface PromptAnswer {
  readonly text: string
  readonly delivery: 'queue' | 'steer'
}

const zh: Readonly<Record<string, string>> = {
  'Show the current session descendant subagent tree': '显示当前会话的后代子代理树',
  'Subagents': '子代理',
  'No subagent descendants': '没有子代理后代',
  'Select a subagent to see its actions': '选择一个子代理查看可用操作',
  'Subagent': '子代理',
  'Label': '标签',
  'Mode': '模式',
  'Running': '运行状态',
  'Session': '会话',
  'Parent': '父会话',
  'live': '运行中',
  'idle': '空闲',
  'stopping': '停止中',
  'stop': '停止',
  'open': '打开',
  'prompt': '追问',
  'Refresh': '刷新',
  'refresh': '刷新',
  'Stop this subagent?': '停止这个子代理？',
  'The child is drained through its exact parent and then counts as stopped.': '将通过其直接父会话排空子代理，随后视为已停止。',
  'Stop': '停止',
  'No current session': '当前没有会话',
  'The subagent is no longer available': '该子代理已不可用',
  'Drain requested; the child counts as stopped once it settles': '已请求排空；子代理结算后视为已停止',
  'Only a continuable live direct child can be drained': '只有可延续且运行中的直接子代理才能排空',
  'Cold view opened': '冷视图已打开',
  'Message': '消息',
  'Delivery': '投递方式',
  'queue: next turn': 'queue：下一轮',
  'steer: current step': 'steer：当前步骤',
  'Send': '发送',
  'Prompt the subagent': '向子代理发送消息',
  'The subagent must be a continuable direct child': '该子代理必须是可延续的直接子代理',
  'Message queued for the subagent': '消息已排队给子代理',
  'Message steered into the subagent step': '消息已转向到子代理当前步骤',
  'Message must not be empty': '消息不能为空',
  'Usage: /agents [<filter>]|close': '用法：/agents [<过滤>]|close',
}

class RemoteAgentsController {
  private readonly t: MayflyTranslate
  private readonly lifecycle: RemoteFeatureLifecycle
  private rows: readonly RemoteAgentRow[] = []
  private selectedId: SessionId | undefined
  private error: string | undefined
  private browser: RemoteBrowserPanel | undefined
  private editor: RemoteRequestOverlay<PromptAnswer | undefined> | undefined
  private lifetime = new AbortController()
  private disposed = false

  constructor(private readonly context: RemoteOperationsContext) {
    const { base } = context
    this.t = memoizedLocaleTranslator(base.ctx, 'remote-operations-agents').translate
    registerRemoteOperationsLocale(base, 'remote-operations-agents', zh)
    this.lifecycle = new RemoteFeatureLifecycle(base, this.attach)
    this.lifecycle.start()
  }

  readonly dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    this.lifecycle.dispose()
    this.lifetime.abort()
    this.editor?.cancel()
    this.browser?.close()
  }

  private readonly attach = (generation: number): void => {
    if (this.disposed) return
    this.lifetime.abort()
    this.lifetime = new AbortController()
    this.browser?.close()
    this.editor?.cancel()
    this.browser = undefined
    this.editor = undefined
    this.selectedId = undefined
    this.rows = []
    this.error = undefined
    if (this.lifecycle.selection(generation) === undefined) this.publish()
  }

  private snapshot(selection: RemoteFeatureSelection): readonly RemoteAgentRow[] {
    const catalog = selection.client.sessions.list.getSnapshot()
    const rows: RemoteAgentRow[] = []
    const seen = new Set<SessionId>([selection.ref.sessionId])
    let frontier: readonly SessionId[] = [selection.ref.sessionId]
    let depth = 0
    while (frontier.length > 0) {
      const next: SessionId[] = []
      for (const parent of frontier) {
        for (const id of catalog.ids) {
          if (seen.has(id)) continue
          const summary = catalog.byId[id]
          const address = selection.client.sessions.subagentAddress(id)
          const byList = summary?.parentId === parent
          const byAddress = address !== undefined && address.parentSessionId === parent && id !== parent
          if (!byList && !byAddress) continue
          seen.add(id)
          next.push(id)
          rows.push({
            id,
            parent,
            depth,
            label: summary?.displayTitle ?? id,
            mode: (address?.mode ?? 'unknown') as RemoteAgentMode,
            running: summary?.running ?? false,
            stopping: false,
          })
        }
      }
      frontier = next
      depth += 1
    }
    return rows
  }

  private refresh(): void {
    const current = this.context.base.hosts.current()
    if (current === undefined) {
      this.rows = []
      this.error = this.t('No current session')
    } else {
      const stopping = new Set(this.rows.filter(row => row.stopping).map(row => row.id))
      this.rows = this.snapshot(current).map(row => ({ ...row, stopping: stopping.has(row.id) || row.stopping }))
      this.error = undefined
      if (this.selectedId !== undefined && !this.rows.some(row => row.id === this.selectedId)) this.selectedId = undefined
    }
    this.publish()
  }

  private publish(): void {
    this.browser?.refresh()
  }

  private open(filter: string): void {
    const current = this.context.base.hosts.current()
    if (current === undefined) {
      this.context.base.notice.set(this.t('No current session'))
      return
    }
    this.refresh()
    if (filter !== '') {
      const needle = filter.toLowerCase()
      this.rows = this.rows.filter(row => row.label.toLowerCase().includes(needle) || row.id.toLowerCase().includes(needle))
    }
    this.browser?.close()
    this.browser = openRemoteBrowser(this.context.base, {
      id: 'remote.operations.agents',
      scope: { kind: 'session', sessionId: current.ref.sessionId },
      isCurrent: () => isRemoteFeatureSelection(this.context.base.hosts.current(), current.client, current.ref),
      view: () => remoteAgentsPanel({ rows: this.rows, selectedId: this.selectedId, error: this.error }, this.t),
      observe: event => this.observe(event),
      action: event => this.act(event),
      onClosed: () => { this.browser = undefined },
    })
  }

  private observe(_event: MayflyUiObservationEvent): void {
    // List selection arrives on the action face; observations only invalidate the paint.
  }

  private select(id: string | undefined): boolean {
    this.selectedId = id === undefined ? undefined : this.rows.find(row => row.id === id)?.id
    this.publish()
    return true
  }

  private selected(): RemoteAgentRow | undefined {
    return this.selectedId === undefined ? undefined : this.rows.find(row => row.id === this.selectedId)
  }

  private async act(event: MayflyUiActionEvent): Promise<MayflyUiActionReply> {
    if (event.kind === 'selection-accept') {
      if (event.controlId !== REMOTE_AGENTS_LIST_ID && event.controlId !== 'agents-list-narrow') return { kind: 'completed' }
      this.select(event.selectedIds[0])
      return { kind: 'completed' }
    }
    if (event.kind !== 'activate') return { kind: 'completed' }
    if (event.actionId === REMOTE_AGENTS_REFRESH_ID) {
      this.refresh()
      return { kind: 'completed' }
    }
    const current = this.context.base.hosts.current()
    const row = this.selected()
    if (current === undefined || row === undefined) return { kind: 'failed', message: this.t('The subagent is no longer available') }
    if (event.actionId === REMOTE_AGENTS_STOP_ID) return await this.stop(current, row)
    if (event.actionId === REMOTE_AGENTS_OPEN_ID) return await this.openColdView(current, row)
    if (event.actionId === REMOTE_AGENTS_PROMPT_ID) {
      this.prompt(current, row)
      return { kind: 'completed' }
    }
    return { kind: 'completed' }
  }

  private async stop(current: RemoteFeatureSelection, row: RemoteAgentRow): Promise<MayflyUiActionReply> {
    const address = current.client.sessions.subagentAddress(row.id)
    if (address === undefined || address.parentSessionId !== row.parent || address.mode !== 'continuable' || !row.running) {
      return { kind: 'failed', message: this.t('Only a continuable live direct child can be drained') }
    }
    try {
      const result = await mayflyHostRemote(current.client).subagentDrain({
        parentSessionId: row.parent,
        childSessionId: row.id,
      }, this.lifetime.signal)
      if (!isRemoteFeatureSelection(this.context.base.hosts.current(), current.client, current.ref)) return { kind: 'cancelled' }
      if (!result.ok) return { kind: 'failed', message: result.error.message }
    } catch (error: unknown) {
      return { kind: 'failed', message: remoteErrorMessage(error) }
    }
    this.rows = this.rows.map(candidate => candidate.id === row.id ? { ...candidate, stopping: true } : candidate)
    this.publish()
    this.context.base.notice.set(this.t('Drain requested; the child counts as stopped once it settles'))
    return { kind: 'completed' }
  }

  private async openColdView(current: RemoteFeatureSelection, row: RemoteAgentRow): Promise<MayflyUiActionReply> {
    const parent: SessionRef = { host: current.ref.host, sessionId: row.parent }
    const child: SessionRef = { host: current.ref.host, sessionId: row.id }
    let lease: ReturnType<typeof this.context.options.btw.retainColdSubagentView>
    try {
      lease = this.context.options.btw.retainColdSubagentView(parent, child, COLD_ROLE)
    } catch (error: unknown) {
      return { kind: 'failed', message: remoteErrorMessage(error) }
    }
    try {
      await this.context.presentSlot.adopt(child, lease)
    } catch (error: unknown) {
      return { kind: 'failed', message: remoteErrorMessage(error) }
    }
    if (!isRemoteFeatureSelection(this.context.base.hosts.current(), current.client, current.ref)) return { kind: 'cancelled' }
    this.context.base.notice.set(this.t('Cold view opened'))
    return { kind: 'completed' }
  }

  private prompt(current: RemoteFeatureSelection, row: RemoteAgentRow): void {
    const address = current.client.sessions.subagentAddress(row.id)
    if (address === undefined || address.parentSessionId !== row.parent || address.mode !== 'continuable') {
      this.context.base.notice.set(this.t('The subagent must be a continuable direct child'))
      return
    }
    const generation = this.lifecycle.currentGeneration()
    this.editor?.cancel()
    this.editor = requestOverlay<PromptAnswer | undefined>(this.context.base.ctx, {
      id: 'remote.operations.agents.prompt',
      title: this.t('Prompt the subagent'),
      scope: { kind: 'session', sessionId: current.ref.sessionId },
      isCurrent: () => this.lifecycle.owns(generation)
        && isRemoteFeatureSelection(this.context.base.hosts.current(), current.client, current.ref)
        && this.selected()?.id === row.id,
      subscribeLocale: this.context.base.subscribeLocale,
      dismissal: 'confirm-dirty',
      view: () => ui.stack.column([
        ui.form({
          id: 'agents-prompt',
          enterSubmits: 'send',
          fields: [
            { kind: 'textarea', id: 'message', label: this.t('Message'), value: '' },
            {
              kind: 'select', id: 'delivery', label: this.t('Delivery'), value: 'queue',
              options: [
                { id: 'queue', label: this.t('queue: next turn') },
                { id: 'steer', label: this.t('steer: current step') },
              ],
            },
          ],
        }),
        ui.actions({ id: 'agents-prompt-actions', items: [{ id: 'send', label: this.t('Send'), semantic: 'save', read: [{ pagePath: [], formId: 'agents-prompt' }] }] }),
      ]),
      answer: event => {
        if (event.kind !== 'activate' || event.actionId !== 'send') return undefined
        const fields = event.inputs?.forms[0]?.fields ?? []
        const text = fields.find(field => field.id === 'message')?.value
        const delivery = fields.find(field => field.id === 'delivery')?.value
        if (typeof text !== 'string' || text.trim() === '') return undefined
        return { text: text.trim(), delivery: delivery === 'steer' ? 'steer' : 'queue' }
      },
      cancelled: () => undefined,
    })
    void this.editor.result.then(async answer => {
      if (answer === undefined) return
      if (!isRemoteFeatureSelection(this.context.base.hosts.current(), current.client, current.ref)) return
      try {
        await this.context.options.btw.promptSubagent(
          { host: current.ref.host, sessionId: row.parent },
          { host: current.ref.host, sessionId: row.id },
          { content: [{ type: 'text', text: answer.text }], delivery: answer.delivery, signal: this.lifetime.signal },
        )
        this.context.base.notice.set(answer.delivery === 'steer'
          ? this.t('Message steered into the subagent step')
          : this.t('Message queued for the subagent'))
      } catch (error: unknown) {
        this.context.base.notice.set(remoteErrorMessage(error))
      }
    }).catch(() => undefined)
  }

  readonly execute = async (rawInput: string): Promise<void> => {
    const input = rawInput.trim()
    if (input === 'close') {
      this.browser?.close()
      return
    }
    this.open(input)
  }
}

/** Mount the `/agents` descendant tree command and its browser. */
export function mountRemoteAgentsOperations(context: RemoteOperationsContext): () => void {
  const controller = new RemoteAgentsController(context)
  const unregister = context.base.commands.register({
    name: 'agents',
    description: 'Show the current session descendant subagent tree',
    input: { hint: '[<filter>]|close' },
    execute: controller.execute,
  })
  return () => {
    unregister()
    controller.dispose()
  }
}
