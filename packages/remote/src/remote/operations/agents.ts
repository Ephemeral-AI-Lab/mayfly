/** Native descendant browsing and exact-parent stops using the shared rc.2 tree. @module */
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { agentsPanelModel, type MayflySubagentTreeEntry } from '@ephemeral-ai/mayfly/command-panels'
import { memoizedLocaleTranslator } from '@ephemeral-ai/mayfly/frontend'
import type { MayflyTranslate, MayflyUiActionEvent, MayflyUiActionReply, MayflyUiEventContext } from '@ephemeral-ai/mayfly-ui'
import type { MayflySubagentTreeEntry as HostTreeEntry } from '../../frontend/host-contract.ts'
import { mayflyHostRemote } from '../../frontend/host-mount.ts'
import type { RemoteFeatureSelection } from '../features.ts'
import { RemoteFeatureController, type RemoteFeatureOperation, remoteErrorMessage, remoteValue } from '../features/official.ts'
import { openRemoteBrowser, type RemoteBrowserPanel } from '../panels/browser.ts'
import { registerRemoteOperationsLocale, type RemoteOperationsContext } from './support.ts'

const COLD_ROLE = 'remote-agents-cold'
const BLOCKED = {
  'not-continuable': 'Only continuable subagents can be stopped',
  'not-live': 'Not live; there is nothing to stop',
  'live-descendants': 'Stop its live descendants first',
  'parent-not-live': 'Its direct parent is not live',
} as const
const zh: Readonly<Record<string, string>> = {
  'Subagents': '子代理', 'Stop selected': '停止所选', 'stop': '停止',
  'Stop selected subagent?': '停止所选子代理？',
  'Its live Agent shuts down; the stored conversation stays browsable.': '其运行中的 Agent 将关闭；已存储的对话仍可浏览。',
  'Stop': '停止', 'Only continuable subagents can be stopped': '只能停止可延续的子代理',
  'Not live; there is nothing to stop': '未运行；没有需要停止的 Agent',
  'Stop its live descendants first': '请先停止其运行中的后代',
  'Its direct parent is not live': '其直接父代理未运行',
  'no session is live yet': '尚无运行中的会话',
  'no subagents in this session': '此会话没有子代理',
  'External subagents have no local conversation': '外部子代理没有本地对话',
  'Select a subagent first': '请先选择一个子代理',
}

class RemoteAgentsController extends RemoteFeatureController<RemoteOperationsContext['base']> {
  private readonly t: MayflyTranslate
  private browserOperation: RemoteFeatureOperation | undefined
  private stopped = false

  constructor(private readonly agentsContext: RemoteOperationsContext) {
    super({ ...agentsContext.base, hosts: { ...agentsContext.base.hosts, current: agentsContext.options.primary ?? agentsContext.base.hosts.current } })
    this.t = memoizedLocaleTranslator(agentsContext.base.ctx, 'remote-operations-agents').translate
    registerRemoteOperationsLocale(agentsContext.base, 'remote-operations-agents', zh)
  }

  override dispose(): void { this.stopped = true; super.dispose() }

  private async tree(current: RemoteFeatureSelection, operation: RemoteFeatureOperation): Promise<readonly HostTreeEntry[]> {
    const entries = await remoteValue(mayflyHostRemote(current.client).subagentTree({ sessionId: current.ref.sessionId }, operation.signal))
    return entries.filter(entry => entry.kind !== 'child' || entry.label !== 'btw')
  }

  private async open(current: RemoteFeatureSelection, caller: AbortSignal): Promise<void> {
    this.browserOperation?.dispose()
    const operation = this.sessionOperation(current, caller)
    if (operation === undefined) return
    this.browserOperation = operation
    let browser: RemoteBrowserPanel | undefined
    let timer: ReturnType<typeof setInterval> | undefined
    let reading = false
    let entries: readonly HostTreeEntry[] = []
    const updateTimer = (): void => {
      const live = entries.some(entry => entry.kind === 'child' && entry.activity === 'running')
      if (live && timer === undefined) {
        timer = setInterval(() => { void refresh() }, 1_000)
        timer.unref()
      } else if (!live && timer !== undefined) { clearInterval(timer); timer = undefined }
    }
    const refresh = async (): Promise<void> => {
      if (reading || !operation.valid()) return
      reading = true
      try {
        const next = await this.tree(current, operation)
        if (!operation.valid()) return
        entries = next
        browser?.refresh()
        updateTimer()
      } catch { /* The last readable native tree survives a failed background refresh. */ }
      finally { reading = false }
    }
    operation.onDispose(() => { if (timer !== undefined) clearInterval(timer); if (browser?.closed === false) browser.close() })
    try {
      entries = await this.tree(current, operation)
      if (!operation.valid()) return
      if (entries.length === 0) { this.agentsContext.base.notice.set(this.t('no subagents in this session')); operation.dispose(); return }
      const action = async (event: MayflyUiActionEvent, owner: MayflyUiEventContext): Promise<MayflyUiActionReply> => {
        if (!operation.valid() || owner.signal.aborted) return { kind: 'cancelled' }
        if (event.kind === 'selection-accept') {
          if (event.controlId !== 'subagents') return { kind: 'completed' }
          const entry = entries.find(entry => entry.id === event.selectedIds[0])
          if (entry?.kind !== 'child') return { kind: 'completed' }
          if (entry.mode === 'external') return { kind: 'failed', message: this.t('External subagents have no local conversation') }
          // Closing the tree retires its reads. The selected conversation owns
          // its own acquisition under the original command caller.
          const opening = this.sessionOperation(current, caller)!
          browser!.close()
          return await this.openChild(current, entry, opening)
        }
        if (event.kind !== 'activate' || event.actionId !== 'stop') return { kind: 'completed' }
        const id = event.inputs?.selections?.find(selection => selection.controlId === 'subagents')?.selectedIds[0]
        if (id === undefined) return { kind: 'failed', message: this.t('Select a subagent first') }
        const stopping = this.sessionOperation(current, AbortSignal.any([operation.signal, owner.signal]))!
        try {
          const result = await this.stop(current, id, stopping)
          if (result.kind === 'completed') await refresh()
          return result
        } finally { stopping.dispose() }
      }
      browser = openRemoteBrowser(this.agentsContext.base, {
        id: 'mayfly.agents', scope: { kind: 'session', sessionId: current.ref.sessionId },
        signal: operation.signal, isCurrent: () => operation.valid(),
        view: () => agentsPanelModel(entries.map((entry): MayflySubagentTreeEntry => ({ ...entry,
          stopBlocked: entry.stopBlocked === undefined ? undefined : this.t(BLOCKED[entry.stopBlocked]),
        })), Date.now(), this.t), action,
        onClosed: () => { operation.dispose() },
      })
      if (!operation.valid()) return
      const changed = (): void => { void refresh() }
      operation.onDispose(current.client.sessions.list.subscribe(changed))
      updateTimer()
    } catch (error) {
      if (operation.valid()) this.agentsContext.base.notice.set(remoteErrorMessage(error), 'error')
      operation.dispose()
    }
  }

  private async stop(current: RemoteFeatureSelection, id: string, operation: RemoteFeatureOperation): Promise<MayflyUiActionReply> {
    try {
      const result = await remoteValue(mayflyHostRemote(current.client).subagentStop({ sessionId: current.ref.sessionId, childSessionId: SessionId(id) }, operation.signal))
      if (!operation.valid()) return { kind: 'cancelled' }
      this.agentsContext.presentSlot.close({ host: current.ref.host, sessionId: SessionId(id) })
      return { kind: 'completed', feedback: { severity: 'success', message: result.text } }
    } catch (error) {
      return operation.valid() ? { kind: 'failed', message: remoteErrorMessage(error) } : { kind: 'cancelled' }
    }
  }

  private async openChild(current: RemoteFeatureSelection, entry: Extract<HostTreeEntry, { readonly kind: 'child' }>, operation: RemoteFeatureOperation): Promise<MayflyUiActionReply> {
    let presented = false
    try {
      const child = { host: current.ref.host, sessionId: entry.id }
      const lease = this.agentsContext.options.btw.retainColdSubagentView({ host: current.ref.host, sessionId: entry.parentId }, child, COLD_ROLE)
      await this.agentsContext.presentSlot.adopt(child, lease, () => {
        presented = true
        const address = current.client.sessions.subagentAddress(entry.id)
        const cwd = current.client.sessions.list.getSnapshot().byId[entry.id]?.cwd
        return { kind: 'subagent', access: entry.mode === 'continuable' ? 'resumable' : 'readonly', label: entry.label ?? entry.id,
          ...address === undefined ? {} : { address }, ...cwd === undefined ? {} : { cwd } }
      }, { signal: operation.signal, isCurrent: () => operation.valid() })
      return presented ? { kind: 'completed' } : { kind: 'cancelled' }
    } catch (error) {
      return operation.valid() ? { kind: 'failed', message: remoteErrorMessage(error) } : { kind: 'cancelled' }
    } finally { operation.dispose() }
  }

  readonly execute = async (rawInput: string, caller: AbortSignal): Promise<void> => {
    if (caller.aborted || this.stopped) return
    const input = rawInput.trim()
    const match = /^stop\s+(\S+)$/u.exec(input)
    if (input !== '' && match === null) throw new Error('usage: /agents [stop <id>]')
    const current = this.context.hosts.current()
    if (current === undefined) { this.agentsContext.base.notice.set(this.t('no session is live yet'), 'error'); return }
    if (match === null) {
      this.agentsContext.options.showPrimary?.()
      await this.open(current, caller)
      return
    }
    const operation = this.sessionOperation(current, caller)
    if (operation === undefined) return
    try {
      const reply = await this.stop(current, match[1]!, operation)
      if (reply.kind === 'failed') this.agentsContext.base.notice.set(reply.message, 'error')
      else if (reply.kind === 'completed') this.agentsContext.base.notice.set(reply.feedback!.message, 'success')
    } finally { operation.dispose() }
  }
}

/** Mount the native descendant tree command; unload retires local work only. */
export function mountRemoteAgentsOperations(context: RemoteOperationsContext): () => void {
  const controller = new RemoteAgentsController(context)
  const unregister = context.base.commands.register({
    name: 'agents', description: 'Browse this session\'s subagents, view one, or stop a continuable child',
    input: { hint: '[stop <id>]' }, execute: controller.execute,
  })
  return () => { unregister(); controller.dispose() }
}
