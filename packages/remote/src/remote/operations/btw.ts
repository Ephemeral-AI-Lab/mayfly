/**
 * `/btw` side-question command over the shared RemoteBtwService and presented view.
 * @module @ephemeral-ai/mayfly/remote/operations/btw
 */

import { memoizedLocaleTranslator } from '@ephemeral-ai/mayfly/frontend'
import type { MayflyTranslate } from '@ephemeral-ai/mayfly-ui'
import { registerRemoteOperationsLocale, type RemoteOperationsContext } from './support.ts'

const zh: Readonly<Record<string, string>> = {
  'Ask a side question in a forked session': '在派生会话中提出一个旁路问题',
  'Usage: /btw <question> | /btw close': '用法：/btw <问题> | /btw close',
  'No current session': '当前没有会话',
  'BTW view closed; the side session keeps running': 'BTW 视图已关闭；旁路会话仍在运行',
  'BTW question shown in the side view': 'BTW 问题已在侧视图展示',
  'The BTW question was cancelled': 'BTW 问题已取消',
}

class RemoteBtwCommand {
  private readonly t: MayflyTranslate

  constructor(private readonly context: RemoteOperationsContext) {
    const { base } = context
    this.t = memoizedLocaleTranslator(base.ctx, 'remote-operations-btw').translate
    registerRemoteOperationsLocale(base, 'remote-operations-btw', zh)
  }

  readonly execute = async (rawInput: string, signal: AbortSignal): Promise<void> => {
    const input = rawInput.trim()
    if (input === '') throw new Error(this.t('Usage: /btw <question> | /btw close'))
    const { base, options } = this.context
    if (input === 'close') {
      this.context.presentSlot.close()
      options.btw.close()
      base.notice.set(this.t('BTW view closed; the side session keeps running'))
      return
    }
    const current = base.hosts.current()
    if (current === undefined) throw new Error(this.t('No current session'))
    const result = await options.btw.ask(current.ref, input, { signal })
    if (!result.ok) throw result.error
    const session = result.value
    const binding = await session.view.ready
    if (signal.aborted) return
    this.context.presentSlot.present(session.child, binding)
    base.notice.set(this.t('BTW question shown in the side view'))
  }
}

/** Mount the `/btw` side-question command. */
export function mountRemoteBtwOperations(context: RemoteOperationsContext): () => void {
  const command = new RemoteBtwCommand(context)
  const unregister = context.base.commands.register({
    name: 'btw',
    description: 'Ask a side question in a forked session',
    input: { hint: '<question>|close' },
    execute: command.execute,
  })
  return unregister
}
