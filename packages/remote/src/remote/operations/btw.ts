/**
 * `/btw` side-question command over the shared RemoteBtwService and presented view.
 * @module @ephemeral-ai/mayfly/remote/operations/btw
 */

import { memoizedLocaleTranslator } from '@ephemeral-ai/mayfly/frontend'
import type { MayflyTranslate } from '@ephemeral-ai/mayfly-ui'
import { RemoteFeatureOperation } from '../features/official.ts'
import { RemoteFeatureLifecycle } from '../features/lifecycle.ts'
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
  private readonly lifecycle: RemoteFeatureLifecycle
  private lifetime = new AbortController()
  private disposed = false

  constructor(private readonly operations: RemoteOperationsContext) {
    const { base } = operations
    this.t = memoizedLocaleTranslator(base.ctx, 'remote-operations-btw').translate
    registerRemoteOperationsLocale(base, 'remote-operations-btw', zh)
    this.lifecycle = new RemoteFeatureLifecycle(base, () => { this.lifetime.abort(); this.lifetime = new AbortController() })
    this.lifecycle.start()
  }

  readonly dispose = (): void => {
    this.disposed = true
    this.lifecycle.dispose()
    this.lifetime.abort()
  }

  readonly execute = async (rawInput: string, signal: AbortSignal): Promise<void> => {
    if (this.disposed) return
    const input = rawInput.trim()
    if (input === '') throw new Error(this.t('Usage: /btw <question> | /btw close'))
    const { base, options } = this.operations
    if (input === 'close') {
      this.operations.presentSlot.closeBtw()
      options.btw.close()
      base.notice.set(this.t('BTW view closed; the side session keeps running'))
      return
    }
    const current = base.hosts.current()
    if (current === undefined) throw new Error(this.t('No current session'))
    const operation = new RemoteFeatureOperation(base, current.client, current, AbortSignal.any([signal, this.lifetime.signal]))
    try {
      if (!operation.valid()) return
      const result = await options.btw.ask(current.ref, input, { signal: operation.signal })
      if (!result.ok) {
        if (operation.valid()) throw result.error
        return
      }
      const session = result.value
      const binding = await session.view.ready
      if (!operation.valid()) {
        const active = options.btw.current()?.child
        if (active?.host === session.child.host && active.sessionId === session.child.sessionId) options.btw.close()
        return
      }
      this.operations.presentSlot.present(session.child, binding, {
        kind: 'btw', access: 'interactive', label: 'btw', cwd: session.selection.cwd,
        ...session.selection.historyFloorSeq === undefined ? {} : { historyFloorSeq: session.selection.historyFloorSeq },
      })
      base.notice.set(this.t('BTW question shown in the side view'))
    } finally { operation.dispose() }
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
  return () => { unregister(); command.dispose() }
}
