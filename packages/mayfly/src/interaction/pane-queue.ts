/** Current-Agent inbox pane contributed through Mayfly's public pane registry.
 * @module @ephemeral-ai/mayfly/interaction/pane-queue
 */

import type { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { interactionTranslator } from './locale.ts'
import type {} from '../app/index.ts'
import { ACTION_MOVE_UP, interactionKeyHint } from './keys.ts'

export const name = 'mayfly-pane-queue'
export const inject = ['mayflyPanes', 'mayflyCurrentAgent']

function messageText(message: UserMessage): string {
  const text = message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join(' ')
    .replace(/[\r\n]+/g, ' ')
    .trim()
  const images = message.content.filter(block => block.type === 'image').length
  return [text, ...(images === 0 ? [] : [`[${images} image${images === 1 ? '' : 's'}]`])].filter(Boolean).join(' ')
}

/** Register one ordinary bottom pane over the selected Agent's inbox. */
export function apply(ctx: Context): void {
  const t = interactionTranslator(ctx)
  const render = (): MayflyUiNode | null => {
    const agent = ctx.mayflyCurrentAgent.current()
    if (agent === null || (agent.inbox.nextTurn.length === 0 && agent.inbox.nextStep.length === 0)) return null
    const rows = [
      ...agent.inbox.nextTurn.filter(message => message.source.kind === 'user').map(message => t('Queued: {text}', { text: messageText(message) })),
      ...agent.inbox.nextStep.filter(message => message.source.kind === 'user').map(message => t('Steer: {text}', { text: messageText(message) })),
    ]
    if (rows.length === 0) return null
    const draft = ctx.get('mayflyInteractionState')?.draft
    const keymap = ctx.get('mayflyKeymap')
    const recall = draft !== undefined && draft.getStashedDraft().length === 0 && draft.getStashedInputMode() !== 'bash'
      && ctx.get('mayflyPromptEditor')?.current?.editor.isShowingAutocomplete() === false
      && (keymap?.getKeys(ACTION_MOVE_UP).length ?? 0) > 0
    return {
      kind: 'stack',
      direction: 'column',
      children: [
        { node: { kind: 'text', content: recall ? t('Queued ({count}) · {key} recall newest', { count: rows.length, key: interactionKeyHint(keymap!, ACTION_MOVE_UP, '↑') }) : t('Queued ({count})', { count: rows.length }), tone: 'muted', overflow: 'truncate' } },
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
  ctx.inject(['mayflyInteractionState'], owner => { owner.effect(() => owner.mayflyInteractionState.draft.subscribe(refresh)); refresh() })
  ctx.on('mayfly/keymap-changed', refresh)
  ctx.on('mayfly/input-editor-changed', refresh)
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
