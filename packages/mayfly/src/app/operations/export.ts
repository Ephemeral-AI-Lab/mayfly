/**
 * `/export` and `/save` render the Host conversation projection, with native
 * backwards `session.events` paging for full audit exports, written to caller
 * paths on the TUI machine with overwrite-aware ownership cleanup.
 * @module @ephemeral-ai/mayfly/remote/operations/export
 */

import { renameSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { ConversationProjection } from '@ephemeral-ai/mayfly-host/types'
import { memoizedLocaleTranslator } from '../../frontend.ts'
import type { MayflyTranslate } from '@ephemeral-ai/mayfly-ui'
import { remoteErrorMessage } from '../features/official.ts'
import {
  buildRemoteExportMarkdown, buildRemoteFullExportMarkdown, remoteExportFileName, remoteExportItems,
} from './export-markdown.ts'
import {
  collectRemoteSessionEvents, registerRemoteOperationsLocale, type RemoteOperationsContext,
} from './support.ts'

/** Page size of one backwards history read. */
const EXPORT_PAGE_MESSAGES = 500

const zh: Readonly<Record<string, string>> = {
  'Export the current session as Markdown': '将当前会话导出为 Markdown',
  'no session is live yet': '还没有正在运行的会话',
  'nothing to export yet': '还没有可导出的内容',
  'exported {count} events to {path}': '已导出 {count} 条事件到 {path}',
  'exported {count} items to {path}': '已导出 {count} 项内容到 {path}',
  'Session changed during export': '导出期间会话已更改',
  'Conversation projection is unavailable': '会话投影不可用',
}

class RemoteExportCommand {
  private readonly t: MayflyTranslate
  private readonly writes = new Map<string, Promise<void>>()
  private active = true

  constructor(private readonly context: RemoteOperationsContext) {
    const { base } = context
    this.t = memoizedLocaleTranslator(base.ctx, 'remote-operations-export').translate
    registerRemoteOperationsLocale(base, 'remote-operations-export', zh)
  }

  /** Retire pending local writes when the command's owning composition unloads. */
  dispose(): void { this.active = false }

  readonly execute = async (rawInput: string, signal: AbortSignal): Promise<void> => {
    const trimmed = rawInput.trim()
    const full = trimmed === 'full' || trimmed.startsWith('full ')
    const pathArg = full ? trimmed.slice(4).trim() : trimmed
    const current = this.context.base.hosts.current()
    if (current === undefined) throw new Error(this.t('no session is live yet'))
    const generation = current.client.state.getSnapshot().generation
    const assertCurrent = (): void => {
      signal.throwIfAborted()
      const selected = this.context.base.hosts.current()
      if (!this.active || selected?.client !== current.client || selected.binding !== current.binding
        || selected.ref.host !== current.ref.host || selected.ref.sessionId !== current.ref.sessionId
        || current.client.state.getSnapshot().generation !== generation) throw new Error(this.t('Session changed during export'))
    }
    assertCurrent()
    const workDir = current.client.sessions.list.getSnapshot().byId[current.ref.sessionId]?.cwd
      ?? (typeof current.binding.session.projections.faceOf('workingDirectory').getSnapshot() === 'string'
        ? current.binding.session.projections.faceOf('workingDirectory').getSnapshot() as string
        : undefined)
    const exportedAt = new Date()
    let count: number
    let markdown: string
    if (full) {
      const events = await collectRemoteSessionEvents(current.client, {
        address: { kind: 'session', sessionId: current.ref.sessionId },
        maxMessages: EXPORT_PAGE_MESSAGES,
        signal,
      })
      assertCurrent()
      count = events.length
      markdown = buildRemoteFullExportMarkdown({ sessionId: current.ref.sessionId, workDir, events, exportedAt })
    } else {
      const projection = current.binding.session.projections.faceOf('mayflyConversation').getSnapshot() as ConversationProjection | undefined
      if (projection === undefined) throw new Error(this.t('Conversation projection is unavailable'))
      const items = remoteExportItems(projection)
      count = items.length
      markdown = buildRemoteExportMarkdown({ sessionId: current.ref.sessionId, workDir, items, exportedAt })
    }
    if (count === 0) throw new Error(this.t('nothing to export yet'))
    const target = resolve(this.context.options.localCwd, pathArg || remoteExportFileName(current.ref.sessionId, exportedAt))
    assertCurrent()
    await mkdir(dirname(target), { recursive: true })
    assertCurrent()
    try {
      const previous = this.writes.get(target) ?? Promise.resolve()
      const operation = previous.then(() => this.write(target, markdown, assertCurrent))
      const settled = operation.then(() => undefined, () => undefined)
      this.writes.set(target, settled)
      try { await operation }
      finally { if (this.writes.get(target) === settled) this.writes.delete(target) }
      assertCurrent()
    } catch (error: unknown) {
      throw new Error(`could not write export: ${remoteErrorMessage(error)}`)
    }
    this.context.base.notice.set(this.t(full ? 'exported {count} events to {path}' : 'exported {count} items to {path}', { count, path: target }), 'success')
  }

  private async write(target: string, markdown: string, assertCurrent: () => void): Promise<void> {
    assertCurrent()
    const read = async (): Promise<Buffer | undefined> => readFile(target).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
      throw error
    })
    const previous = await read()
    assertCurrent()
    const temporary = await mkdtemp(join(dirname(target), '.mayfly-export-'))
    try {
      assertCurrent()
      const staged = join(temporary, 'export')
      await writeFile(staged, markdown, 'utf8')
      assertCurrent()
      const latest = await read()
      assertCurrent()
      if (previous === undefined ? latest !== undefined : latest === undefined || !previous.equals(latest)) throw new Error('The export destination changed during export')
      // Admission and the atomic local commit share one synchronous turn. A
      // later selection change never rolls back a committed destination.
      renameSync(staged, target)
    } finally { await rm(temporary, { recursive: true, force: true }).catch(() => {}) }
  }
}

/**
 * Keep the reference `/save` descriptor in help and completion. The additional
 * `/export` route shares its local executor without changing that public catalog.
 */
export function mountRemoteExportOperations(context: RemoteOperationsContext): () => void {
  const command = new RemoteExportCommand(context)
  const unregister = [
    context.base.commands.register({
      name: 'export',
      hidden: true,
      description: 'Export the current session as Markdown',
      input: { hint: '[full] [<path>]' },
      execute: command.execute,
    }),
    context.base.commands.register({
      name: 'save',
      description: 'Save the current session as a Markdown file',
      input: { hint: '[full] [<path>]' },
      execute: command.execute,
    }),
  ]
  return () => { command.dispose(); for (const dispose of unregister) dispose() }
}
