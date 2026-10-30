/**
 * `/copy` last assistant reply text, folded from the backwards session journal
 * and handed to the integrator's clipboard seam.
 * @module @ephemeral-ai/mayfly/remote/operations/copy
 */

import { memoizedLocaleTranslator } from '@ephemeral-ai/mayfly/frontend'
import type { SessionWireEvent } from '@deepseek-ai/dsh-api-session-controller/types'
import type { MayflyTranslate } from '@ephemeral-ai/mayfly-ui'
import { remoteErrorMessage } from '../features/official.ts'
import {
  collectRemoteSessionEvents, isRemoteRecord, registerRemoteOperationsLocale,
  type RemoteOperationsContext,
} from './support.ts'

/** Page size of one backwards journal read. */
const COPY_PAGE_MESSAGES = 500

/** Pages one read walks before it reports that no assistant reply was found. */
const COPY_MAX_PAGES = 4

const zh: Readonly<Record<string, string>> = {
  'Copy the last assistant reply to the clipboard': '复制最后一条助手回复到剪贴板',
  'Copied {count} characters': '已复制 {count} 个字符',
  'No assistant reply to copy yet': '还没有可复制的助手回复',
  'Clipboard is unavailable in this frontend': '当前前端不支持剪贴板',
  'Could not copy: {message}': '复制失败：{message}',
  'No current session': '当前没有会话',
  'Usage: /copy': '用法：/copy',
}

/**
 * Join the text blocks of one assistant message, ignoring reasoning blocks,
 * images, and blocks that carry only whitespace.
 */
function assistantText(event: SessionWireEvent): string | undefined {
  if (event.type !== 'assistant/message') return undefined
  const message = isRemoteRecord(event.data) ? event.data['message'] : undefined
  const content = isRemoteRecord(message) ? message['content'] : undefined
  if (!Array.isArray(content)) return undefined
  const text = content
    .flatMap((block: unknown) => {
      if (!isRemoteRecord(block) || block['type'] !== 'text') return []
      const candidate = block['text']
      return typeof candidate === 'string' && candidate.trim() !== '' ? [candidate] : []
    })
    .join('\n\n')
  return text === '' ? undefined : text
}

/** The newest assistant reply with text in seq order, or undefined when the window holds none. */
function latestAssistantText(events: readonly SessionWireEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined) continue
    const text = assistantText(event)
    if (text !== undefined) return text
  }
  return undefined
}

class RemoteCopyCommand {
  private readonly t: MayflyTranslate

  constructor(private readonly context: RemoteOperationsContext) {
    const { base } = context
    this.t = memoizedLocaleTranslator(base.ctx, 'remote-operations-copy').translate
    registerRemoteOperationsLocale(base, 'remote-operations-copy', zh)
  }

  readonly execute = async (rawInput: string, signal: AbortSignal): Promise<void> => {
    if (signal.aborted) return
    if (rawInput.trim() !== '') throw new Error(this.t('Usage: /copy'))
    const current = this.context.base.hosts.current()
    if (current === undefined) throw new Error(this.t('No current session'))
    const copy = this.context.options.copy
    if (copy === undefined) {
      this.context.base.notice.set(this.t('Clipboard is unavailable in this frontend'))
      return
    }
    const events = await collectRemoteSessionEvents(current.client, {
      address: { kind: 'session', sessionId: current.ref.sessionId },
      maxMessages: COPY_PAGE_MESSAGES,
      maxPages: COPY_MAX_PAGES,
      signal,
    })
    if (signal.aborted) return
    const text = latestAssistantText(events)
    if (text === undefined) {
      this.context.base.notice.set(this.t('No assistant reply to copy yet'))
      return
    }
    try {
      await copy(text)
    } catch (error: unknown) {
      throw new Error(this.t('Could not copy: {message}', { message: remoteErrorMessage(error) }))
    }
    if (signal.aborted) return
    this.context.base.notice.set(this.t('Copied {count} characters', { count: text.length }))
  }
}

/** Mount the `/copy` last-assistant-reply command. */
export function mountRemoteCopyOperations(context: RemoteOperationsContext): () => void {
  const command = new RemoteCopyCommand(context)
  const unregister = context.base.commands.register({
    name: 'copy',
    description: 'Copy the last assistant reply to the clipboard',
    execute: command.execute,
  })
  return () => { unregister() }
}
