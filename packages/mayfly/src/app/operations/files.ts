/** Frozen Files browser over Host delivery metadata and native per-turn comparisons. @module */
import { FilesBrowser, filesBrowserItems, filesBrowserRow, type FilesBrowserFacts, type FilesDeliveredFile, type FilesRow } from '../../interaction/files-browser-model.ts'
import { memoizedLocaleTranslator } from '../../frontend/locale.ts'
import type { MayflyTranslate, MayflyUiActionEvent, MayflyUiActionReply, MayflyUiEventContext } from '@ephemeral-ai/mayfly-ui'
import { mayflyHostRemote } from '../../hosts/host-mount.ts'
import type { RemoteFeatureSelection } from '../features.ts'
import { RemoteFeatureController, RemoteFeatureOperation, remoteErrorMessage, remoteValue } from '../features/official.ts'
import { openRemoteBrowser, type RemoteBrowserPanel } from '../panels/browser.ts'
import { registerRemoteOperationsLocale, type RemoteOperationsContext } from './support.ts'

const zh: Readonly<Record<string, string>> = {
  'Browse files delivered by the agent': '浏览 Agent 交付的文件',
  'Browse workspace changes for a recorded sequence': '浏览指定序列的工作区改动',
  'Usage: /changes [seq] (a non-negative integer)': '用法：/changes [seq]（非负整数）',
  'No current session': '当前没有会话',
  'Loading file…': '正在加载文件…',
  'Loading comparison…': '正在加载比较…',
  'Name': '名称', 'Description': '描述', 'Path': '路径', 'Type': '类型', 'Size': '大小',
  'Status': '状态', 'Turn': '回合', 'Change': '改动', 'unknown': '未知', 'bytes': '字节',
  'File unavailable': '文件不可用', 'No files': '没有文件',
  'Select a file to see its details': '选择文件以查看详情',
}

/** One open browser retains only readonly wire facts and caller-owned read cancellation. */
class RemoteFilesBrowser {
  private facts: FilesBrowserFacts = { files: [], detailMode: false, canOpen: false }
  private readonly browser: RemoteBrowserPanel
  private loadAbort: AbortController | undefined
  private loadGeneration = 0
  private latestTicket = 0
  private lastChangesSeq: number | undefined

  constructor(
    private readonly context: RemoteOperationsContext,
    private readonly current: RemoteFeatureSelection,
    private readonly operation: RemoteFeatureOperation,
    t: MayflyTranslate,
    private readonly changes?: { readonly seq?: number | undefined },
  ) {
    const face = current.binding.session.projections.faceOf('mayflyDeliverables')
    const update = (): void => {
      if (!operation.valid()) return
      this.facts = { ...this.facts, files: face.getSnapshot() as readonly FilesDeliveredFile[] | undefined ?? [] }
      this.refreshRows()
    }
    if (changes === undefined) operation.onDispose(face.subscribe(update))
    if (changes?.seq === undefined) operation.onDispose(current.binding.eventSource.subscribe(() => {
      if (!operation.valid()) return
      const seq = current.binding.eventSource.getSnapshot().entries.findLast(entry => entry.type === 'event' && entry.event.type === 'workspace/changes')
      const next = seq?.type === 'event' ? seq.event.seq : undefined
      if (next === undefined || next === this.lastChangesSeq) return
      this.lastChangesSeq = next
      void this.refreshChanges()
    }))
    operation.onDispose(() => { this.loadAbort?.abort(); this.browser?.close() })
    this.facts = { ...this.facts, files: changes === undefined ? face.getSnapshot() as readonly FilesDeliveredFile[] | undefined ?? [] : [] }
    this.browser = openRemoteBrowser(context.base, {
      id: changes === undefined ? 'remote.operations.files' : 'remote.operations.changes',
      scope: { kind: 'session', sessionId: current.ref.sessionId },
      signal: operation.signal,
      isCurrent: () => operation.valid(),
      view: () => FilesBrowser(this.facts, t),
      action: (event, owner) => this.action(event, owner),
      back: () => {
        if (!this.facts.detailMode) return false
        this.facts = { ...this.facts, detailMode: false }
        this.browser.refresh()
        return true
      },
      onClosed: () => { operation.dispose() },
    })
    if (!operation.valid()) return
    this.refreshRows()
    void this.refreshChanges()
    if (changes === undefined) void this.readOpenCapability()
  }

  /** Refocusing preserves this invocation's selected row, preview and pending reads. */
  refocus(): boolean {
    if (!this.operation.valid()) return false
    return this.context.base.ctx.mayflyOverlays.focus(this.changes === undefined ? 'remote.operations.files' : 'remote.operations.changes')
  }

  private refreshRows(): void {
    if (filesBrowserRow(this.facts, this.facts.focusedId) === undefined) {
      this.focus(filesBrowserItems(this.facts)[0]?.id)
    }
    this.browser.refresh()
  }

  private async readOpenCapability(): Promise<void> {
    try {
      const canOpen = await remoteValue(this.current.client.remote.session.canOpenWorkspacePath())
      if (!this.operation.valid()) return
      this.facts = { ...this.facts, canOpen }
      this.browser.refresh()
    } catch {
      // Native capability discovery is advisory; metadata, preview, and copy stay usable.
    }
  }

  private async refreshChanges(): Promise<void> {
    const ticket = ++this.latestTicket
    try {
      const seq = this.changes?.seq
      const host = mayflyHostRemote(this.current.client)
      const summary = seq === undefined ? undefined : await remoteValue(host.workspaceChangesSummary({ sessionId: this.current.ref.sessionId, seq }, this.operation.signal))
      const latest = seq === undefined
        ? await remoteValue(host.latestWorkspaceChanges({ sessionId: this.current.ref.sessionId }, this.operation.signal))
        : summary === null ? null : { seq, summary: summary! }
      if (!this.operation.valid() || ticket !== this.latestTicket) return
      this.facts = { ...this.facts, latest: latest ?? undefined }
      this.refreshRows()
    } catch (error) {
      if (this.operation.valid() && ticket === this.latestTicket) this.context.base.notice.set(remoteErrorMessage(error), 'error')
    }
  }

  private focus(id: string | undefined): void {
    if (id === this.facts.focusedId && this.facts.detail !== undefined) return
    this.loadAbort?.abort()
    this.loadGeneration += 1
    this.facts = { ...this.facts, focusedId: id, detail: undefined }
    const row = filesBrowserRow(this.facts, id)
    if (row === undefined) return
    this.facts = { ...this.facts, detail: { kind: row.kind, loading: true } }
    const controller = new AbortController()
    this.loadAbort = controller
    const signal = AbortSignal.any([this.operation.signal, controller.signal])
    void this.load(row, this.loadGeneration, signal)
  }

  private async load(row: FilesRow, generation: number, signal: AbortSignal): Promise<void> {
    try {
      if (row.kind === 'delivered') {
        const value = await remoteValue(mayflyHostRemote(this.current.client).deliveredFile({ sessionId: this.current.ref.sessionId, deliveryId: row.file.id }, signal))
        if (!this.operation.valid() || signal.aborted || generation !== this.loadGeneration) return
        this.facts = { ...this.facts, detail: { kind: 'delivered', ...value, previewable: value.fileType === 'file' } }
      } else {
        const diff = await remoteValue(mayflyHostRemote(this.current.client).workspaceChangesDiff({ sessionId: this.current.ref.sessionId, seq: row.latest.seq, index: row.index }, signal))
        if (!this.operation.valid() || signal.aborted || generation !== this.loadGeneration) return
        this.facts = { ...this.facts, detail: { kind: 'changed', ...diff === null ? {} : { diff } } }
      }
    } catch (error) {
      if (!this.operation.valid() || signal.aborted || generation !== this.loadGeneration) return
      this.facts = { ...this.facts, detail: { kind: row.kind, error: remoteErrorMessage(error) } }
    }
    this.browser.refresh()
  }

  private async action(event: MayflyUiActionEvent, owner: MayflyUiEventContext): Promise<MayflyUiActionReply> {
    if (!this.operation.valid() || owner.signal.aborted) return { kind: 'cancelled' }
    if (event.kind === 'selection-accept') {
      if (event.controlId !== 'files' && event.controlId !== 'files-narrow') return { kind: 'completed' }
      const id = event.selectedIds[0]
      if (id === undefined) return { kind: 'cancelled' }
      this.focus(id)
      if (event.controlId === 'files-narrow') this.facts = { ...this.facts, detailMode: true }
      this.browser.refresh()
      return { kind: 'completed' }
    }
    if (event.kind !== 'activate') return { kind: 'completed' }
    if (event.actionId !== 'copy' && event.actionId !== 'open' && event.actionId !== 'preview') return { kind: 'completed' }
    const state = this.facts.detail?.kind === 'delivered' ? this.facts.detail : undefined
    const row = filesBrowserRow(this.facts, this.facts.focusedId)
    if (state?.path === undefined || row?.kind !== 'delivered') return { kind: 'failed', message: 'File unavailable' }
    const generation = this.loadGeneration
    const signal = AbortSignal.any([owner.signal, this.operation.signal])
    const valid = (): boolean => !signal.aborted && this.operation.valid() && generation === this.loadGeneration
    try {
      if (event.actionId === 'copy') {
        if (this.context.options.copy === undefined) return { kind: 'failed', message: 'Clipboard unavailable' }
        await this.context.options.copy(state.path)
        return valid() ? { kind: 'completed', feedback: { severity: 'success', message: 'Path copied' } } : { kind: 'cancelled' }
      }
      if (state.fileType !== 'file') return { kind: 'failed', message: 'File unavailable' }
      if (event.actionId === 'open') {
        if (!this.facts.canOpen) return { kind: 'failed', message: 'Open unavailable' }
        await remoteValue(this.current.client.remote.session.openWorkspacePath({ path: state.path }, signal))
        return valid() ? { kind: 'completed', feedback: { severity: 'info', message: 'Open request handed to the host application' } } : { kind: 'cancelled' }
      }
      if (state.preview !== undefined) {
        const { preview: _preview, ...rest } = state
        this.facts = { ...this.facts, detail: rest }
      } else {
        const value = await remoteValue(mayflyHostRemote(this.current.client).deliveredFile({ sessionId: this.current.ref.sessionId, deliveryId: row.file.id, preview: true }, signal))
        if (!valid()) return { kind: 'cancelled' }
        this.facts = { ...this.facts, detail: { kind: 'delivered', ...value, previewable: value.fileType === 'file' } }
      }
      this.browser.refresh()
      return { kind: 'completed' }
    } catch (error) {
      return valid() ? { kind: 'failed', message: remoteErrorMessage(error) } : { kind: 'cancelled' }
    }
  }
}

class RemoteFilesController extends RemoteFeatureController<RemoteOperationsContext['base']> {
  private readonly t: MayflyTranslate
  private operation: RemoteFeatureOperation | undefined
  private browser: RemoteFilesBrowser | undefined
  private seq: number | undefined

  constructor(private readonly filesContext: RemoteOperationsContext, private readonly changes = false) {
    super(filesContext.base)
    this.t = memoizedLocaleTranslator(filesContext.base.ctx, 'remote-operations-files').translate
    registerRemoteOperationsLocale(filesContext.base, 'remote-operations-files', zh)
  }

  readonly execute = (rawInput: string, signal: AbortSignal): void => {
    if (signal.aborted) return
    const argument = rawInput.trim()
    const seq = this.changes && argument !== '' ? Number(argument) : undefined
    if (seq !== undefined && (!/^\d+$/u.test(argument) || !Number.isSafeInteger(seq))) {
      this.filesContext.base.notice.set(this.t('Usage: /changes [seq] (a non-negative integer)'), 'error')
      return
    }
    const current = this.filesContext.base.hosts.current()
    if (current === undefined) { this.filesContext.base.notice.set(this.t('No current session'), 'error'); return }
    if (seq === this.seq && this.browser?.refocus() === true) return
    this.operation?.dispose()
    const operation = this.sessionOperation(current, signal)
    if (operation === undefined) return
    this.operation = operation
    this.seq = seq
    this.browser = new RemoteFilesBrowser(this.filesContext, current, operation, this.t, this.changes ? { seq } : undefined)
  }
}

/** Mount the Files browser, with native Host reads and Frontend clipboard ownership. */
export function mountRemoteFilesOperations(context: RemoteOperationsContext): () => void {
  const controller = new RemoteFilesController(context)
  const changes = new RemoteFilesController(context, true)
  const unregister = [
    context.base.commands.register({ name: 'files', description: 'Browse files delivered by the agent', execute: controller.execute }),
    context.base.commands.register({ name: 'changes', description: 'Browse workspace changes for a recorded sequence', input: { hint: '[seq]' }, execute: changes.execute }),
  ]
  return () => { for (const stop of unregister) stop(); controller.dispose(); changes.dispose() }
}
