/**
 * `/export` session Markdown export over backwards `session.events` paging,
 * written exclusively inside the local `mayfly-exports/` directory.
 * @module @ephemeral-ai/mayfly/remote/operations/export
 */

import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { memoizedLocaleTranslator } from '@ephemeral-ai/mayfly/frontend'
import type { MayflyTranslate } from '@ephemeral-ai/mayfly-ui'
import { remoteErrorMessage } from '../features/official.ts'
import {
  buildRemoteExportMarkdown, buildRemoteFullExportMarkdown, remoteExportFileName, sanitizeRemoteExportName,
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
  'Export directory escapes the local working directory': '导出目录超出了本地工作目录',
  'Could not find an unused export filename': '找不到可用的导出文件名',
  'Exported {count} events to {path}': '已导出 {count} 条事件到 {path}',
}

/** Whether one resolved path stays strictly inside `parent`. */
function isInsideDirectory(parent: string, path: string): boolean {
  const distance = relative(parent, path)
  return distance !== '' && !distance.startsWith('..') && !isAbsolute(distance)
}

class RemoteExportCommand {
  private readonly t: MayflyTranslate

  constructor(private readonly context: RemoteOperationsContext) {
    const { base } = context
    this.t = memoizedLocaleTranslator(base.ctx, 'remote-operations-export').translate
    registerRemoteOperationsLocale(base, 'remote-operations-export', zh)
  }

  /** Write one exclusively created file, never overwriting, cleaning a partial on failure. */
  private async writeExclusive(directory: string, name: string, content: string): Promise<string> {
    for (let attempt = 0; attempt < EXPORT_NAME_ATTEMPTS; attempt += 1) {
      const candidate = attempt === 0 ? name : `${name.replaceAll(/\.md$/u, '')}-${String(attempt + 1)}.md`
      const target = resolve(directory, candidate)
      if (!isInsideDirectory(directory, target)) throw new Error(this.t('Export directory escapes the local working directory'))
      try {
        await writeFile(target, content, { encoding: 'utf8', flag: 'wx' })
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
    const events = await collectRemoteSessionEvents(current.client, {
      address: { kind: 'session', sessionId: current.ref.sessionId },
      maxMessages: EXPORT_PAGE_MESSAGES,
      signal,
    })
    if (events.length === 0) throw new Error(this.t('Nothing to export yet'))
    const workDir = current.client.sessions.list.getSnapshot().byId[current.ref.sessionId]?.cwd
      ?? (typeof current.binding.session.projections.faceOf('workingDirectory').getSnapshot() === 'string'
        ? current.binding.session.projections.faceOf('workingDirectory').getSnapshot() as string
        : undefined)
    const exportedAt = new Date()
    const markdown = full
      ? buildRemoteFullExportMarkdown({ sessionId: current.ref.sessionId, workDir, events, exportedAt })
      : buildRemoteExportMarkdown({ sessionId: current.ref.sessionId, workDir, events, exportedAt })
    const directory = resolve(this.context.options.localCwd, 'mayfly-exports')
    const name = nameArg === ''
      ? remoteExportFileName(current.ref.sessionId, exportedAt)
      : sanitizeRemoteExportName(nameArg)
    if (name === undefined) throw new Error(this.t('Usage: /export [full] [name]'))
    await mkdir(directory, { recursive: true })
    let target: string
    try {
      target = await this.writeExclusive(directory, name, markdown)
    } catch (error: unknown) {
      throw new Error(`could not write export: ${remoteErrorMessage(error)}`)
    }
    this.context.base.notice.set(this.t('Exported {count} events to {path}', { count: events.length, path: target }))
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
      description: 'Save the current session as Markdown (/export)',
      input: { hint: '[full] [name]' },
      execute: command.execute,
    }),
  ]
  return () => { for (const dispose of unregister) dispose() }
}
