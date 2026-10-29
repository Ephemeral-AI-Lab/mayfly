/**
 * `/retract` explicit turn retraction through the generated mayflyHost face;
 * it never overlaps ordinary `/cancel` semantics.
 * @module @ephemeral-ai/mayfly/remote/operations/retract
 */

import { memoizedLocaleTranslator } from '@ephemeral-ai/mayfly/frontend'
import type { MayflyTranslate } from '@ephemeral-ai/mayfly-ui'
import { mayflyHostRemote } from '../../frontend/host-mount.ts'
import { registerRemoteOperationsLocale, type RemoteOperationsContext } from './support.ts'

const zh: Readonly<Record<string, string>> = {
  'Retract a running tool-free turn by message id': '按消息 id 撤回一个运行中且无工具调用的回合',
  'Usage: /retract <messageId>': '用法：/retract <messageId>',
  'No current session': '当前没有会话',
  'Turn retracted': '回合已撤回',
  'The Host did not retract the turn; it must be running and tool-free': 'Host 未撤回该回合；回合必须正在运行且不含工具调用',
}

class RemoteRetractCommand {
  private readonly t: MayflyTranslate

  constructor(private readonly context: RemoteOperationsContext) {
    const { base } = context
    this.t = memoizedLocaleTranslator(base.ctx, 'remote-operations-retract').translate
    registerRemoteOperationsLocale(base, 'remote-operations-retract', zh)
  }

  readonly execute = async (rawInput: string, signal: AbortSignal): Promise<void> => {
    const messageId = rawInput.trim()
    if (messageId === '') throw new Error(this.t('Usage: /retract <messageId>'))
    const current = this.context.base.hosts.current()
    if (current === undefined) throw new Error(this.t('No current session'))
    const result = await mayflyHostRemote(current.client).retractTurn({
      sessionId: current.ref.sessionId,
      messageId,
    }, signal)
    if (!result.ok) throw result.error
    this.context.base.notice.set(result.value
      ? this.t('Turn retracted')
      : this.t('The Host did not retract the turn; it must be running and tool-free'))
  }
}

/** Mount the `/retract` explicit turn retraction command. */
export function mountRemoteRetractOperations(context: RemoteOperationsContext): () => void {
  const command = new RemoteRetractCommand(context)
  const unregister = context.base.commands.register({
    name: 'retract',
    description: 'Retract a running tool-free turn by message id',
    input: { hint: '<messageId>' },
    execute: command.execute,
  })
  return unregister
}
