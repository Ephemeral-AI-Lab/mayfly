/**
 * Compact centered status for the displayed conversation: its kind badge,
 * label, and access, the F7 counterpart, and how many more stay open.
 * @module @ephemeral-ai/mayfly/interaction/conversation-view-status
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MayflyInlineSpan, MayflyStatusNode, MayflyTone } from '@ephemeral-ai/mayfly-ui'
import type { MayflyConversationsSnapshot, MayflyConversationView } from '../app/conversation-views.ts'
import { interactionTranslator } from './locale.ts'
import { ACTION_CLOSE_AGENT_VIEW, ACTION_TOGGLE_AGENT_VIEW, interactionKeyHint } from './keys.ts'

/** Stable child-plugin name. */
export const name = 'mayfly-conversation-view-status'
/** App registry and direct status registry required by the indicator. */
export const inject = ['mayflyConversations', 'mayflyStatus', 'mayflyKeymap']

/** Badge tone per conversation kind; each kind reads distinctly at a glance. */
const KIND_TONE: Readonly<Record<MayflyConversationView['kind'], MayflyTone>> = {
  primary: 'accent',
  btw: 'user',
  subagent: 'primary',
}

/** Register the centered displayed-conversation indicator. */
export function apply(ctx: Context): void {
  const t = interactionTranslator(ctx)
  const badge = (view: MayflyConversationView): string => view.kind === 'primary' ? t('MAIN') : view.kind === 'btw' ? 'BTW' : t('SUBAGENT')
  const title = (view: MayflyConversationView): string => view.kind === 'primary' ? badge(view) : `${badge(view)} · ${view.label}`
  const access = (view: MayflyConversationView): MayflyInlineSpan[] => view.access === 'interactive'
    ? []
    : [{ text: view.access === 'resumable' ? t(' · reply to resume') : t(' · read-only'), tone: 'muted' }]
  const node = (snapshot: MayflyConversationsSnapshot): MayflyStatusNode | null => {
    const byId = new Map(snapshot.views.map(view => [view.id, view]))
    const displayed = snapshot.displayedId === null ? undefined : byId.get(snapshot.displayedId)
    const counterpart = snapshot.recent[1] === undefined ? undefined : byId.get(snapshot.recent[1])
    if (displayed === undefined || counterpart === undefined) return null
    const controls = ` · ${interactionKeyHint(ctx.mayflyKeymap, ACTION_TOGGLE_AGENT_VIEW, 'F7')} switch · ${interactionKeyHint(ctx.mayflyKeymap, ACTION_CLOSE_AGENT_VIEW, 'F8')} close`
    const more = snapshot.views.length - 2
    // Identity first, key hints last: a narrow footer truncates the hints first.
    return {
      kind: 'rich-text',
      spans: [
        { text: badge(displayed), tone: KIND_TONE[displayed.kind], styles: ['strong'] },
        ...displayed.kind === 'primary'
          ? [{ text: ` ⇄ ${title(counterpart)}`, tone: 'muted' as const }, ...access(counterpart)]
          : [{ text: ` · ${displayed.label} ⇄ ${title(counterpart)}`, tone: 'muted' as const }, ...access(displayed)],
        ...more > 0 ? [{ text: t(' · {count} more open', { count: more }), tone: 'muted' as const }] : [],
        { text: controls, tone: 'muted' },
      ],
    }
  }
  const registration = ctx.mayflyStatus.register({
    id: 'mayfly.status.conversation-view',
    priority: 0,
    band: 'center',
  }, node(ctx.mayflyConversations.snapshot()))
  const offView = ctx.mayflyConversations.subscribe((snapshot) => { registration.set(node(snapshot)) })
  ctx.effect(() => offView)
  ctx.effect(() => () => registration.dispose())
}
