/**
 * `/copy` last assistant reply text, folded from the backwards session journal
 * and handed to the integrator's clipboard seam.
 * @module @ephemeral-ai/mayfly/remote/operations/copy
 */

import { memoizedLocaleTranslator } from '@ephemeral-ai/mayfly/frontend'
import type { SessionWireEvent } from '@deepseek-ai/dsh-api-session-controller/types'
import type { MayflyTranslate } from '@ephemeral-ai/mayfly-ui'
import { RemoteFeatureController, remoteErrorMessage } from '../features/official.ts'
import {
  collectRemoteSessionEvents, isRemoteRecord, registerRemoteOperationsLocale,
  type RemoteOperationsContext,
} from './support.ts'

/** Page size of one backwards journal read. */
const COPY_PAGE_MESSAGES = 500

/** Pages one read walks before it reports that no assistant reply was found. */
const COPY_MAX_PAGES = 4

const zh: Readonly<Record<string, string>> = {
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
    const event = events[index]!
    const text = assistantText(event)
    if (text !== undefined) return text
  }
  return undefined
}

class RemoteCopyCommand extends RemoteFeatureController<RemoteOperationsContext['base']> {
  private readonly t: MayflyTranslate

  constructor(private readonly copyContext: RemoteOperationsContext) {
    super(copyContext.base)
    const { base } = copyContext
    this.t = memoizedLocaleTranslator(base.ctx, 'remote-operations-copy').translate
    registerRemoteOperationsLocale(base, 'remote-operations-copy', zh)
  }

  readonly execute = async (rawInput: string, signal: AbortSignal): Promise<void> => {
    if (signal.aborted) return
    if (rawInput.trim() !== '') throw new Error(this.t('Usage: /copy'))
    const current = this.copyContext.base.hosts.current()
    // A missing selection is an ordinary state, not a failed command: throwing
    // here would surface as 'Submission was not confirmed; no retry was sent',
    // which reads like a transport fault. Every other Remote command notices.
    if (current === undefined) {
      this.copyContext.base.notice.set(this.t('No current session'))
      return undefined
    }
    const copy = this.copyContext.options.copy
    if (copy === undefined) {
      this.copyContext.base.notice.set(this.t('Clipboard is unavailable in this frontend'))
      return
    }
    const operation = this.sessionOperation(current, signal)
    if (operation === undefined) return
    try {
      const events = await collectRemoteSessionEvents(current.client, {
        address: { kind: 'session', sessionId: current.ref.sessionId },
        maxMessages: COPY_PAGE_MESSAGES,
        maxPages: COPY_MAX_PAGES,
        signal: operation.signal,
      })
      if (!operation.valid()) return
      const text = latestAssistantText(events)
      if (text === undefined) {
        this.copyContext.base.notice.set(this.t('No assistant reply to copy yet'))
        return
      }
      try {
        await copy(text)
      } catch (error: unknown) {
        // Clipboard refusal is an outcome; it must still belong to the displayed Session.
        if (operation.valid()) this.copyContext.base.notice.set(this.t('Could not copy: {message}', { message: remoteErrorMessage(error) }))
        return
      }
      if (!operation.valid()) return
      this.copyContext.base.notice.set(this.t('Copied {count} characters', { count: text.length }))
    } catch (error: unknown) {
      if (operation.valid()) throw error
    } finally { operation.dispose() }
  }
}

/** Mount the `/copy` last-assistant-reply command. */
export function mountRemoteCopyOperations(context: RemoteOperationsContext): () => void {
  const command = new RemoteCopyCommand(context)
  const unregister = context.base.commands.register({
    name: 'copy',
    description: 'Copy the last assistant message to the clipboard',
    execute: command.execute,
  })
  return () => { unregister(); command.dispose() }
}
