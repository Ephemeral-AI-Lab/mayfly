/**
 * `/copy` reads the last visible assistant reply from the whole Host
 * conversation projection and hands it to the integrator's clipboard seam.
 * @module @ephemeral-ai/mayfly/remote/operations/copy
 */

import { memoizedLocaleTranslator } from '@ephemeral-ai/mayfly/frontend'
import type { ConversationEntry, ConversationProjection } from '@ephemeral-ai/mayfly-host/types'
import type { MayflyTranslate } from '@ephemeral-ai/mayfly-ui'
import { RemoteFeatureController, remoteErrorMessage } from '../features/official.ts'
import {
  registerRemoteOperationsLocale,
  type RemoteOperationsContext,
} from './support.ts'

const zh: Readonly<Record<string, string>> = {
  'Copied {count} characters': '已复制 {count} 个字符',
  'No assistant reply to copy yet': '还没有可复制的助手回复',
  'Clipboard is unavailable in this frontend': '当前前端不支持剪贴板',
  'Could not copy: {message}': '复制失败：{message}',
  'No current session': '当前没有会话',
  'Usage: /copy': '用法：/copy',
  'Conversation projection is unavailable': '会话投影不可用',
}

/** The newest non-empty visible assistant item, matching the reference transcript. */
function latestAssistantText(entries: readonly ConversationEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!
    if (entry.kind === 'assistant' && entry.text.trim() !== '') return entry.text
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
      const projection = current.binding.session.projections.faceOf('mayflyConversation').getSnapshot() as ConversationProjection | undefined
      if (!operation.valid()) return
      if (projection === undefined) throw new Error(this.t('Conversation projection is unavailable'))
      const text = latestAssistantText(projection.entries)
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
