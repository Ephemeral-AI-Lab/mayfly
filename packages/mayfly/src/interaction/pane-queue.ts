/** Current-Agent inbox pane contributed through Mayfly's public pane registry.
 * @module @ephemeral-ai/mayfly/interaction/pane-queue
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { userMessageText } from '../transcript/stream-facts.ts'
import { interactionTranslator } from './locale.ts'
import type {} from '../app/index.ts'

export const name = 'mayfly-pane-queue'
export const inject = ['mayflyPanes', 'mayflyCurrentAgent']

/** Register one ordinary bottom pane over the selected Agent's inbox. */
export function apply(ctx: Context): void {
  const t = interactionTranslator(ctx)
  const render = (): MayflyUiNode | null => {
    const agent = ctx.mayflyCurrentAgent.current()
    if (agent === null || (agent.inbox.nextTurn.length === 0 && agent.inbox.nextStep.length === 0)) return null
    const rows = [
      ...agent.inbox.nextTurn.filter(message => message.source.kind === 'user').map(message => t('Queued: {text}', { text: userMessageText(message) })),
      ...agent.inbox.nextStep.filter(message => message.source.kind === 'user').map(message => t('Steer: {text}', { text: userMessageText(message) })),
    ]
    if (rows.length === 0) return null
    return {
      kind: 'stack',
      direction: 'column',
      children: [
        { node: { kind: 'divider' } },
        ...rows.map(content => ({ node: { kind: 'text' as const, content, tone: 'muted' as const, overflow: 'truncate' as const } })),
      ],
    }
  }
  const pane = ctx.mayflyPanes.register({
    id: 'mayfly.pane.queue',
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
