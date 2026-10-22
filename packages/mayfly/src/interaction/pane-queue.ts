/** Current-Agent inbox pane contributed through Mayfly's public pane registry.
 * @module @ephemeral-ai/mayfly/interaction/pane-queue
 */

import type { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type {} from '../app/index.ts'

export const name = 'mayfly-pane-queue'
export const inject = ['mayflyPanes', 'mayflyCurrentAgent']

function messageText(message: UserMessage): string {
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join(' ')
    .replace(/[\r\n]+/g, ' ')
    .trim()
}

/** Register one ordinary bottom pane over the selected Agent's inbox. */
export function apply(ctx: Context): void {
  const render = (): MayflyUiNode | null => {
    const agent = ctx.mayflyCurrentAgent.current()
    if (agent === null || !agent.inbox.hasPending) return null
    const rows = [
      ...agent.inbox.nextTurn.map(message => `queued / turn: ${messageText(message)}`),
      ...agent.inbox.nextStep.map(message => `queued / step: ${messageText(message)}`),
    ]
    return {
      kind: 'stack',
      direction: 'column',
      children: rows.map(content => ({ node: { kind: 'text', content, tone: 'muted' } })),
    }
  }
  const pane = ctx.mayflyPanes.register({
    id: 'mayfly.pane.queue',
    title: 'Queued messages',
    placement: 'bottom',
    priority: 20,
    narrow: 'bottom',
  }, render())
  const refresh = (): void => pane.set(render())
  const offAgent = ctx.mayflyCurrentAgent.subscribe(refresh)
  const offInserted = ctx.on('agent/inbox/inserted', ({ agent }) => {
    if (agent === ctx.mayflyCurrentAgent.current()) refresh()
  })
  const offClaimed = ctx.on('agent/inbox/claimed', ({ agent }) => {
    if (agent === ctx.mayflyCurrentAgent.current()) refresh()
  })
  const offDiscarded = ctx.on('agent/inbox/discarded', ({ agent }) => {
    if (agent === ctx.mayflyCurrentAgent.current()) refresh()
  })
  ctx.effect(() => () => {
    offAgent()
    offInserted()
    offClaimed()
    offDiscarded()
    pane.dispose()
  })
}
