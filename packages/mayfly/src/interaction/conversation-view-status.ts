/**
 * The conversation chip of status row 1: while more than one conversation is open it names the displayed one in the
 * form of the focus chip (` view `, ` conversation `): a strong inverse word, in the one primary tone for every kind so
 * switching never changes the chip's color, ` main ` for the main
 * session, ` btw ` and ` subagent ` for a side conversation. The keys that switch and close live in the notification
 * pane, and the access (live, resumable, read-only) in the editor's placeholder.
 * @module @ephemeral-ai/mayfly/interaction/conversation-view-status
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MayflyStatusNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyConversationsSnapshot, MayflyConversationView } from '../app/conversation-views.ts'
import { interactionTranslator } from './locale.ts'

/** Stable child-plugin name. */
export const name = 'mayfly-conversation-view-status'
/** App registry and direct status registry required by the indicator. */
export const inject = ['mayflyConversations', 'mayflyStatus']

/** Register the displayed-conversation chip. */
export function apply(ctx: Context): void {
  const t = interactionTranslator(ctx)
  const word = (view: MayflyConversationView): string => view.kind === 'primary' ? t('main') : view.kind === 'btw' ? t('btw') : t('subagent')
  const node = (snapshot: MayflyConversationsSnapshot): MayflyStatusNode | null => {
    const displayed = snapshot.views.find(view => view.id === snapshot.displayedId)
    // With one conversation open there is nothing to tell apart: no chip.
    if (displayed === undefined || snapshot.views.length < 2) return null
    return { kind: 'rich-text', spans: [{ text: ` ${word(displayed)} `, tone: 'primary', styles: ['strong', 'inverse'] }] }
  }
  const registration = ctx.mayflyStatus.register({ id: 'mayfly.status.conversation-view', priority: 1 }, node(ctx.mayflyConversations.snapshot()))
  const offView = ctx.mayflyConversations.subscribe((snapshot) => { registration.set(node(snapshot)) })
  ctx.effect(() => offView)
  ctx.effect(() => () => registration.dispose())
}
