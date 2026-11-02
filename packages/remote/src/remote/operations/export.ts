/**
 * `/export` and `/save` render the Host conversation projection, with native
 * backwards `session.events` paging for full audit exports, written exclusively
 * inside the local `mayfly-exports/` directory.
 * @module @ephemeral-ai/mayfly/remote/operations/export
 */

import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ConversationProjection } from '@ephemeral-ai/mayfly-host/types'
import { memoizedLocaleTranslator } from '@ephemeral-ai/mayfly/frontend'
import type { MayflyTranslate } from '@ephemeral-ai/mayfly-ui'
import { remoteErrorMessage } from '../features/official.ts'
import {
  buildRemoteExportMarkdown, buildRemoteFullExportMarkdown, remoteExportFileName, remoteExportItems, sanitizeRemoteExportName,
} from './export-markdown.ts'
import {
  collectRemoteSessionEvents, registerRemoteOperationsLocale, type RemoteOperationsContext,
} from './support.ts'

/** Page size of one backwards history read. */
const EXPORT_PAGE_MESSAGES = 500

/** Attempts to find an unused exclusive filename before giving up. */
const EXPORT_NAME_ATTEMPTS = 100

const zh: Readonly<Record<string, string>> = {
  'Export the current session as Markdown': '将当前会话导出为 Markdown',
  'No current session': '当前没有会话',
  'Usage: /export [full] [name]': '用法：/export [full] [name]',
  'Nothing to export yet': '还没有可导出的内容',
  'Could not find an unused export filename': '找不到可用的导出文件名',
  'Exported {count} events to {path}': '已导出 {count} 条事件到 {path}',
  'Exported {count} items to {path}': '已导出 {count} 项内容到 {path}',
  'Session changed during export': '导出期间会话已更改',
  'Conversation projection is unavailable': '会话投影不可用',
}

class RemoteExportCommand {
  private readonly t: MayflyTranslate
  private active = true

  constructor(private readonly context: RemoteOperationsContext) {
    const { base } = context
    this.t = memoizedLocaleTranslator(base.ctx, 'remote-operations-export').translate
    registerRemoteOperationsLocale(base, 'remote-operations-export', zh)
  }

  /** Retire pending local writes when the command's owning composition unloads. */
  dispose(): void { this.active = false }

  /** Write one exclusively created file, never overwriting, cleaning a partial on failure. */
  private async writeExclusive(directory: string, name: string, content: string, assertCurrent: () => void): Promise<string> {
    for (let attempt = 0; attempt < EXPORT_NAME_ATTEMPTS; attempt += 1) {
      const candidate = attempt === 0 ? name : `${name.replace(/\.md$/u, '')}-${String(attempt + 1)}.md`
      const target = resolve(directory, candidate)
      assertCurrent()
      try {
        await writeFile(target, content, { encoding: 'utf8', flag: 'wx' })
        assertCurrent()
        return target
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException | null)?.code === 'EEXIST') continue
        await unlink(target).then(undefined, () => undefined)
        throw error
      }
    }
    throw new Error(this.t('Could not find an unused export filename'))
  }

  readonly execute = async (rawInput: string, signal: AbortSignal): Promise<void> => {
    const tokens = rawInput.trim().split(/\s+/u).filter(token => token !== '')
    const full = tokens[0] === 'full'
    const nameArg = (full ? tokens.slice(1) : tokens).join(' ')
    const current = this.context.base.hosts.current()
    if (current === undefined) throw new Error(this.t('No current session'))
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
    if (count === 0) throw new Error(this.t('Nothing to export yet'))
    const directory = resolve(this.context.options.localCwd, 'mayfly-exports')
    const name = nameArg === ''
      ? remoteExportFileName(current.ref.sessionId, exportedAt)
      : sanitizeRemoteExportName(nameArg)
    if (name === undefined) throw new Error(this.t('Usage: /export [full] [name]'))
    await mkdir(directory, { recursive: true })
    assertCurrent()
    let target: string
    try {
      target = await this.writeExclusive(directory, name, markdown, assertCurrent)
    } catch (error: unknown) {
      throw new Error(`could not write export: ${remoteErrorMessage(error)}`)
    }
    this.context.base.notice.set(this.t(full ? 'Exported {count} events to {path}' : 'Exported {count} items to {path}', { count, path: target }))
  }
}

/**
 * Mount the `/export` Markdown export command and its `/save` name. The local
 * registry has no alias table, so both names are registered over one executor:
 * `/save` reads as the obvious verb but must write the same file as `/export`,
 * and routing it through the Host instead would silently reach no command.
 */
export function mountRemoteExportOperations(context: RemoteOperationsContext): () => void {
  const command = new RemoteExportCommand(context)
  const unregister = [
    context.base.commands.register({
      name: 'export',
      description: 'Export the current session as Markdown',
      input: { hint: '[full] [name]' },
      execute: command.execute,
    }),
    context.base.commands.register({
      name: 'save',
      description: 'Save the current session as a Markdown file',
      input: { hint: '[full] [name]' },
      execute: command.execute,
    }),
  ]
  return () => { command.dispose(); for (const dispose of unregister) dispose() }
}
