/**
 * `/files` browser over the Host `mayflyDeliverables` projection: the files the
 * agent delivered in this session, with no filesystem read of its own.
 * @module @ephemeral-ai/mayfly/remote/operations/files
 */

import { memoizedLocaleTranslator } from '@ephemeral-ai/mayfly/frontend'
import type {
  MayflyTranslate, MayflyUiActionEvent, MayflyUiActionReply, MayflyUiObservationEvent,
} from '@ephemeral-ai/mayfly-ui'
import type { RemoteFeatureSelection } from '../features.ts'
import { openRemoteBrowser, type RemoteBrowserPanel } from '../panels/browser.ts'
import {
  REMOTE_FILES_REFRESH_ID, remoteFilesNode, type RemoteFilesRow, type RemoteFilesState,
} from '../panels/operations/files.ts'
import { isRemoteFeatureSelection } from '../interactions/selection.ts'
import { RemoteFeatureLifecycle } from '../features/lifecycle.ts'
import { isRemoteRecord, registerRemoteOperationsLocale, type RemoteOperationsContext } from './support.ts'

/** The Host projection carrying recorded `deliverables/presented` files. */
const DELIVERABLES_KEY = 'mayflyDeliverables'

const zh: Readonly<Record<string, string>> = {
  'Browse files delivered by the agent': '浏览 Agent 交付的文件',
  'Delivered files': '已交付文件',
  'No files were delivered in this session yet': '本会话还没有交付任何文件',
  'This session does not expose the deliverables projection': '本会话未提供 deliverables 投影',
  'Only files the agent recorded as delivered are listed; no path is read from disk.':
    '这里只列出 Agent 记录为已交付的文件；不会从磁盘读取任何路径。',
  'Refresh': '刷新',
  'refresh': '刷新',
  'No current session': '当前没有会话',
  'Usage: /files': '用法：/files',
}

/** Read one projection row's string field, or undefined for an absent or non-string value. */
function rowString(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Read the projection's delivered files, skipping rows a Host cannot render. */
function deliverableRows(value: unknown): readonly RemoteFilesRow[] {
  if (!Array.isArray(value)) return []
  const rows: RemoteFilesRow[] = []
  for (const [index, candidate] of value.entries()) {
    if (!isRemoteRecord(candidate)) continue
    const path = rowString(candidate, 'path')
    if (path === undefined || path.trim() === '') continue
    rows.push({
      id: rowString(candidate, 'id') ?? String(index),
      path,
      description: rowString(candidate, 'description'),
    })
  }
  return rows
}

/** Read the projection snapshot into panel state; an unpublished key is not an empty session. */
function readDeliverables(value: unknown): RemoteFilesState {
  if (value === undefined) return { available: false, rows: [] }
  return { available: true, rows: deliverableRows(value) }
}

class RemoteFilesController {
  private readonly t: MayflyTranslate
  private readonly lifecycle: RemoteFeatureLifecycle
  private state: RemoteFilesState = { available: false, rows: [] }
  private browser: RemoteBrowserPanel | undefined
  private stopProjection: (() => void) | undefined
  private disposed = false

  constructor(private readonly context: RemoteOperationsContext) {
    const { base } = context
    this.t = memoizedLocaleTranslator(base.ctx, 'remote-operations-files').translate
    registerRemoteOperationsLocale(base, 'remote-operations-files', zh)
    this.lifecycle = new RemoteFeatureLifecycle(base, this.attach)
    this.lifecycle.start()
  }

  readonly dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    this.lifecycle.dispose()
    this.stopProjection?.()
    this.stopProjection = undefined
    this.browser?.close()
  }

  private readonly attach = (generation: number): void => {
    if (this.disposed) return
    this.stopProjection?.()
    this.stopProjection = undefined
    this.browser?.close()
    this.browser = undefined
    this.state = { available: false, rows: [] }
    const current = this.lifecycle.selection(generation)
    if (current !== undefined) this.watch(current)
  }

  private watch(current: RemoteFeatureSelection): void {
    const face = current.binding.session.projections.faceOf(DELIVERABLES_KEY)
    const update = (): void => {
      this.state = readDeliverables(face.getSnapshot())
      this.browser?.refresh()
    }
    this.stopProjection = face.subscribe(update)
    update()
  }

  readonly execute = (rawInput: string): void => {
    if (rawInput.trim() !== '') throw new Error(this.t('Usage: /files'))
    const current = this.context.base.hosts.current()
    if (current === undefined) throw new Error(this.t('No current session'))
    this.browser?.close()
    this.browser = openRemoteBrowser(this.context.base, {
      id: 'remote.operations.files',
      scope: { kind: 'session', sessionId: current.ref.sessionId },
      isCurrent: () => isRemoteFeatureSelection(this.context.base.hosts.current(), current.client, current.ref),
      view: () => remoteFilesNode(this.state, this.t),
      observe: (_event: MayflyUiObservationEvent) => {},
      action: (event: MayflyUiActionEvent): MayflyUiActionReply => {
        if (event.kind === 'activate' && event.actionId === REMOTE_FILES_REFRESH_ID) {
          this.state = readDeliverables(current.binding.session.projections.faceOf(DELIVERABLES_KEY).getSnapshot())
          this.browser?.refresh()
        }
        return { kind: 'completed' }
      },
      onClosed: () => { this.browser = undefined },
    })
  }
}

/** Mount the `/files` delivered-files browser. */
export function mountRemoteFilesOperations(context: RemoteOperationsContext): () => void {
  const controller = new RemoteFilesController(context)
  const unregister = context.base.commands.register({
    name: 'files',
    description: 'Browse files delivered by the agent',
    execute: controller.execute,
  })
  return () => {
    unregister()
    controller.dispose()
  }
}
