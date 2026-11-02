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
  'copied the last assistant message ({count} characters)': '已复制最后一条助手消息（{count} 个字符）',
  'copied via terminal escape sequence (unverified, {count} characters)': '已通过终端转义序列复制（未经验证，{count} 个字符）',
  'no assistant message to copy': '没有可复制的助手消息',
  'Clipboard is unavailable in this frontend': '当前前端不支持剪贴板',
  'could not copy to clipboard: {message}': '无法复制到剪贴板：{message}',
  'no session is live yet': '还没有正在运行的会话',
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

  readonly execute = async (_rawInput: string, signal: AbortSignal): Promise<void> => {
    if (signal.aborted) return
    const current = this.copyContext.base.hosts.current()
    // A missing selection is an ordinary state, not a failed command: throwing
    // here would surface as 'Submission was not confirmed; no retry was sent',
    // which reads like a transport fault. Every other Remote command notices.
    if (current === undefined) {
      this.copyContext.base.notice.set(this.t('no session is live yet'))
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
        this.copyContext.base.notice.set(this.t('no assistant message to copy'))
        return
      }
      try {
        const method = await copy(text)
        if (!operation.valid()) return
        this.copyContext.base.notice.set(this.t(method === 'osc52'
          ? 'copied via terminal escape sequence (unverified, {count} characters)'
          : 'copied the last assistant message ({count} characters)', { count: text.length }), 'success')
      } catch (error: unknown) {
        // Clipboard refusal is an outcome; it must still belong to the displayed Session.
        if (operation.valid()) this.copyContext.base.notice.set(this.t('could not copy to clipboard: {message}', { message: remoteErrorMessage(error) }))
        return
      }
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
