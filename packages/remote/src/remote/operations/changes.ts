/**
 * `/changes` per-turn workspace summary and selected-file diff with the Host
 * deliverables projection tail.
 * @module @ephemeral-ai/mayfly/remote/operations/changes
 */

import { memoizedLocaleTranslator } from '@ephemeral-ai/mayfly/frontend'
import type {
  MayflyTranslate, MayflyUiActionEvent, MayflyUiActionReply, MayflyUiObservationEvent,
} from '@ephemeral-ai/mayfly-ui'
import type { RemoteFeatureSelection } from '../features.ts'
import { openRemoteBrowser, type RemoteBrowserPanel } from '../panels/browser.ts'
import {
  REMOTE_CHANGES_LIST_ID, REMOTE_CHANGES_REFRESH_ID, remoteChangesPanel,
  type RemoteChangesDeliverables, type RemoteChangesState,
} from '../panels/operations/changes.ts'
import { isRemoteFeatureSelection } from '../interactions/selection.ts'
import { RemoteFeatureLifecycle } from '../features/lifecycle.ts'
import { remoteErrorMessage } from '../features/official.ts'
import { mayflyHostRemote } from '../../frontend/host-mount.ts'
import {
  readOnlyPaths, registerRemoteOperationsLocale, remoteLatestDurableSeq, type RemoteOperationsContext,
} from './support.ts'

const DELIVERABLES_KEY = 'mayflyDeliverables'
const DELIVERABLES_PATH_KEYS = ['path', 'display', 'name', 'file'] as const

const zh: Readonly<Record<string, string>> = {
  'Show the workspace files one turn changed': '显示某个回合改动的文件',
  'Workspace changes': '工作区改动',
  'Turn': '回合',
  'Files': '文件',
  'Lines': '行数',
  'Deliverables': '已交付文件',
  'deliverables projection unavailable': 'deliverables 投影不可用',
  'No delivered files recorded yet': '尚无已交付文件记录',
  'No changed files recorded for this turn': '该回合没有记录到文件改动',
  'Select a file to compare its turn-start and turn-end contents': '选择一个文件比较其回合前后内容',
  'No comparison is available for this file': '该文件没有可用的比较',
  'File': '文件',
  'Kind': '类型',
  'binary file; no lines are served': '二进制文件；不提供行内容',
  'oversized file; listed without comparison': '文件过大；仅列出而不比较',
  'Turn start': '回合开始',
  'Turn end': '回合结束',
  'present': '存在',
  'absent': '不存在',
  'Comparison': '比较',
  'timed out; every line is shown as replaced': '比较超时；所有行显示为替换',
  'No content differences': '内容没有差异',
  'Refresh': '刷新',
  'refresh': '刷新',
  'No current session': '当前没有会话',
  'The session has no events yet; open it after a turn': '会话还没有事件；回合结束后再打开',
  'Usage: /changes [<seq>]': '用法：/changes [<seq>]',
}

function readDeliverables(value: unknown): RemoteChangesDeliverables {
  if (value === undefined) return { available: false, paths: [] }
  return { available: true, paths: readOnlyPaths(value, DELIVERABLES_PATH_KEYS) }
}

class RemoteChangesController {
  private readonly t: MayflyTranslate
  private readonly lifecycle: RemoteFeatureLifecycle
  private seq: number | undefined
  private summary: RemoteChangesState['summary']
  private selectedIndex: number | undefined
  private diff: RemoteChangesState['diff']
  private diffError: string | undefined
  private deliverables: RemoteChangesDeliverables = { available: false, paths: [] }
  private error: string | undefined
  private browser: RemoteBrowserPanel | undefined
  private stopDeliverables: (() => void) | undefined
  private lifetime = new AbortController()
  private ticket = 0
  private disposed = false

  constructor(private readonly context: RemoteOperationsContext) {
    const { base } = context
    this.t = memoizedLocaleTranslator(base.ctx, 'remote-operations-changes').translate
    registerRemoteOperationsLocale(base, 'remote-operations-changes', zh)
    this.lifecycle = new RemoteFeatureLifecycle(base, this.attach)
    this.lifecycle.start()
  }

  readonly dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    this.lifecycle.dispose()
    this.lifetime.abort()
    this.browser?.close()
  }

  private readonly attach = (generation: number): void => {
    if (this.disposed) return
    this.lifetime.abort()
    this.lifetime = new AbortController()
    this.browser?.close()
    this.browser = undefined
    this.stopDeliverables?.()
    this.stopDeliverables = undefined
    this.summary = undefined
    this.selectedIndex = undefined
    this.diff = undefined
    this.diffError = undefined
    this.error = undefined
    const current = this.lifecycle.selection(generation)
    if (current !== undefined) this.watchDeliverables(current)
  }

  private watchDeliverables(current: RemoteFeatureSelection): void {
    const face = current.binding.session.projections.faceOf(DELIVERABLES_KEY)
    const update = (): void => {
      this.deliverables = readDeliverables(face.getSnapshot())
      this.publish()
    }
    this.stopDeliverables = face.subscribe(update)
    update()
  }

  private state(): RemoteChangesState {
    return {
      seq: this.seq,
      summary: this.summary,
      selectedIndex: this.selectedIndex,
      diff: this.selectedIndex === undefined ? undefined : this.diff,
      diffError: this.diffError,
      deliverables: this.deliverables,
      error: this.error,
    }
  }

  private publish(): void {
    this.browser?.refresh()
  }

  private async refresh(current: RemoteFeatureSelection): Promise<void> {
    const seq = this.seq
    if (seq === undefined) return
    const ticket = ++this.ticket
    try {
      const result = await mayflyHostRemote(current.client).workspaceChangesSummary({
        sessionId: current.ref.sessionId,
        seq,
      }, this.lifetime.signal)
      if (ticket !== this.ticket || !isRemoteFeatureSelection(this.context.base.hosts.current(), current.client, current.ref)) return
      if (!result.ok) {
        this.summary = undefined
        this.error = result.error.message
      } else {
        this.summary = result.value ?? undefined
        this.error = undefined
        if (this.selectedIndex !== undefined && this.summary !== undefined && this.selectedIndex >= this.summary.files.length) {
          this.selectedIndex = undefined
          this.diff = undefined
        }
      }
    } catch (error: unknown) {
      if (ticket !== this.ticket) return
      this.summary = undefined
      this.error = remoteErrorMessage(error)
    }
    this.publish()
  }

  private async loadDiff(current: RemoteFeatureSelection, index: number): Promise<void> {
    const seq = this.seq
    if (seq === undefined) return
    const ticket = ++this.ticket
    this.selectedIndex = index
    this.diff = undefined
    this.diffError = undefined
    this.publish()
    try {
      const result = await mayflyHostRemote(current.client).workspaceChangesDiff({
        sessionId: current.ref.sessionId,
        seq,
        index,
      }, this.lifetime.signal)
      if (ticket !== this.ticket || !isRemoteFeatureSelection(this.context.base.hosts.current(), current.client, current.ref)) return
      if (!result.ok) this.diffError = result.error.message
      else this.diff = result.value
    } catch (error: unknown) {
      if (ticket !== this.ticket) return
      this.diffError = remoteErrorMessage(error)
    }
    this.publish()
  }

  private open(seq: number | undefined): void {
    const current = this.context.base.hosts.current()
    if (current === undefined) {
      this.context.base.notice.set(this.t('No current session'))
      return
    }
    if (seq === undefined) {
      this.context.base.notice.set(this.t('The session has no events yet; open it after a turn'))
      return
    }
    this.seq = seq
    this.summary = undefined
    this.selectedIndex = undefined
    this.diff = undefined
    this.error = undefined
    this.browser?.close()
    this.browser = openRemoteBrowser(this.context.base, {
      id: 'remote.operations.changes',
      scope: { kind: 'session', sessionId: current.ref.sessionId },
      isCurrent: () => isRemoteFeatureSelection(this.context.base.hosts.current(), current.client, current.ref),
      view: () => remoteChangesPanel(this.state(), this.t),
      observe: event => this.observe(event),
      action: event => this.act(event),
      onClosed: () => { this.browser = undefined },
    })
    void this.refresh(current)
  }

  private observe(_event: MayflyUiObservationEvent): void {
    // List selection arrives on the action face; observations only invalidate the paint.
  }

  private select(index: string | undefined): void {
    const current = this.context.base.hosts.current()
    if (index === undefined || current === undefined) return
    const parsed = Number(index)
    if (!Number.isSafeInteger(parsed) || this.summary === undefined || parsed >= this.summary.files.length) return
    void this.loadDiff(current, parsed)
  }

  private async act(event: MayflyUiActionEvent): Promise<MayflyUiActionReply> {
    if (event.kind === 'selection-accept') {
      if (event.controlId !== REMOTE_CHANGES_LIST_ID && event.controlId !== 'changes-files-narrow') return { kind: 'completed' }
      this.select(event.selectedIds[0])
      return { kind: 'completed' }
    }
    if (event.kind !== 'activate' || event.actionId !== REMOTE_CHANGES_REFRESH_ID) return { kind: 'completed' }
    const current = this.context.base.hosts.current()
    if (current === undefined) return { kind: 'failed', message: this.t('No current session') }
    await this.refresh(current)
    return { kind: 'completed' }
  }

  readonly execute = async (rawInput: string): Promise<void> => {
    const input = rawInput.trim()
    let seq: number | undefined
    if (input !== '') {
      const parsed = Number(input)
      if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(this.t('Usage: /changes [<seq>]'))
      seq = parsed
    }
    const current = this.context.base.hosts.current()
    if (current === undefined) throw new Error(this.t('No current session'))
    if (seq === undefined) seq = remoteLatestDurableSeq(current.binding)
    this.open(seq)
  }
}

/** Mount the `/changes` per-turn workspace diff command and browser. */
export function mountRemoteChangesOperations(context: RemoteOperationsContext): () => void {
  const controller = new RemoteChangesController(context)
  const unregister = context.base.commands.register({
    name: 'changes',
    description: 'Show the workspace files one turn changed',
    input: { hint: '[<seq>]' },
    execute: controller.execute,
  })
  return () => {
    unregister()
    controller.dispose()
  }
}
