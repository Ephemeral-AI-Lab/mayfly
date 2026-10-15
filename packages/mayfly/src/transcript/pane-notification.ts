/**
 * The notification pane: the one row between the activity block and the editor that carries the notice to read now.
 * It shows the notification lane's records (the commands' feedback, an editor extension's report, and the notices
 * `notices.ts` raises from the session's facts) one at a time, the most severe and then the newest, scoped to the app
 * or the current session, with a muted `+N` for the ones waiting behind it. The lane keeps the records and their
 * lifetimes (`✓` and `ℹ` leave after five seconds of visible time, `⚠` and `✗` stay), so the pane holds no timer: it
 * reads the lane when the lane or the current Agent changes and publishes only when the notice on the row changed.
 * When the stream is scrolled away from its tail, the row also carries the chip back to it, centered, announced by the
 * surface renderer (`mayfly/content-tail-changed`); the notice yields the room the chip needs. With no notice the row
 * carries a muted hint of the keys that move focus off the prompt. `components/notification-line.ts`
 * draws it as one row in the alternate layout the pane is compiled in (not in `main` screen mode), so the editor never shifts.
 *
 * @module @ephemeral-ai/mayfly/transcript/pane-notification
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MayflyFeedbackRecord } from '@ephemeral-ai/mayfly-ui'
import type { MayflyConversationView } from '../app/conversation-views.ts'
import { ACTION_CLOSE_AGENT_VIEW, ACTION_TOGGLE_AGENT_VIEW, interactionKeyHint } from '../interaction/keys.ts'
import { NotificationLine, type NotificationFacts, type NotificationKeyPart, type NotificationRowFacts } from '../components/notification-line.ts'
import type { MayflyFocusMode } from '../core/types.ts'
import type { MayflyTranslate } from '../frontend/locale.ts'
import { observeTranscriptLocale } from './locale.ts'
import type { SessionFactsService } from './session-facts.ts'

const RANK: Readonly<Record<MayflyFeedbackRecord['severity'], number>> = { info: 0, success: 1, warning: 2, error: 3 }

/**
 * The notice the row shows: among the records of the app or of the current session, the most severe, then the newest.
 * @param records - the lane's records.
 * @param sessionId - the current Agent's session id, if any.
 * @returns the notice with the count waiting behind it, or `undefined` for a blank row.
 */
export function selectNotification(records: readonly MayflyFeedbackRecord[], sessionId: string | undefined): NotificationFacts | undefined {
  const visible = records
    .filter(record => record.scope.kind === 'app' || (record.scope.kind === 'session' && String(record.scope.sessionId) === sessionId))
    .toSorted((left, right) => RANK[left.severity] - RANK[right.severity] || left.createdAt - right.createdAt)
  const top = visible.at(-1)
  if (top === undefined) return undefined
  return { severity: top.severity, message: top.message, ...top.tail === undefined ? {} : { tail: top.tail }, ...visible.length > 1 ? { waiting: visible.length - 1 } : {} }
}

/**
 * The keys of a mode as the row sheds them: lower numbers survive a narrow row, so leaving the mode, moving, and opening a row go last.
 * The first part reads first and is the one that stays, because the row writes the separator before every part but the first.
 */
function conversationKeys(t: MayflyTranslate): readonly NotificationKeyPart[] {
  return [
    { text: t('↑/↓ select'), priority: 1 }, { text: t('Enter expand'), priority: 2 }, { text: t('c copy'), priority: 4 }, { text: t('/ ? search'), priority: 3 },
    { text: t('Ctrl+G editor'), priority: 5 }, { text: t('Ctrl+C JSON'), priority: 6 }, { text: t('Esc back'), priority: 0 },
  ]
}

/** The keys while a search holds focus; `Esc end search` is the last to go. */
function searchKeys(t: MayflyTranslate): readonly NotificationKeyPart[] {
  return [
    { text: t('↑/↓ or n/N match'), priority: 1 }, { text: t('Enter expand'), priority: 2 }, { text: t('c copy'), priority: 4 }, { text: t('/ ? new search'), priority: 3 },
    { text: t('Ctrl+C JSON'), priority: 5 }, { text: t('Esc end search'), priority: 0 },
  ]
}

/**
 * Mount the notification pane under the calling Fiber.
 * @param ctx - plugin context; needs `mayflyPanes`, `mayflyUiInteraction`, `mayflySessionFacts`, `mayflyConversations`, and `mayflyKeymap`.
 * @param t - translator for the hint the row teaches while it has no notice.
 */
export function mountNotificationPane(ctx: Context, t: MayflyTranslate): void {
  const interaction = ctx.get('mayflyUiInteraction')
  const factsService = ctx.get('mayflySessionFacts') as SessionFactsService | undefined
  /** The words of the chip back to the tail of the stream while the view is scrolled away, else `undefined`. */
  let chip: string | undefined
  /** Where keyboard focus is: the hint of the keys that leave the prompt only teaches while focus is on it. */
  let mode: MayflyFocusMode = 'prompt'
  const conversations = ctx.mayflyConversations
  const kindWord = (view: MayflyConversationView): string => view.kind === 'primary' ? t('main') : view.kind === 'btw' ? t('btw') : t('subagent')
  /** The way back and forth: `F7` names the other conversation, `F8` closes (or detaches) the side one; absent with one conversation open. */
  const toggle = (): string | undefined => {
    const snapshot = conversations.snapshot()
    const displayed = snapshot.views.find(view => view.id === snapshot.displayedId)
    const counterpart = snapshot.views.find(view => view.id === snapshot.recent[1])
    if (displayed === undefined || counterpart === undefined) return undefined
    const switchKey = `${interactionKeyHint(ctx.mayflyKeymap, ACTION_TOGGLE_AGENT_VIEW, 'F7')} ${kindWord(counterpart)}`
    // `F8` acts on the displayed side conversation, or on the `F7` counterpart while the main session is displayed.
    const target = displayed.kind === 'primary' ? counterpart : displayed
    return `${switchKey} · ${interactionKeyHint(ctx.mayflyKeymap, ACTION_CLOSE_AGENT_VIEW, 'F8')} ${target.kind === 'subagent' ? t('detach') : t('close')}`
  }
  const current = (): NotificationRowFacts => {
    const agent = factsService?.currentAgent
    const notice = interaction === undefined ? undefined : selectNotification(interaction.notificationSnapshot(), agent == null ? undefined : String(agent.id))
    // With no notice the row teaches where focus can go from the prompt: up into the conversation, down to the items of the status row.
    return { ...notice === undefined ? {} : { notice }, ...mode === 'prompt' ? notice === undefined ? { hint: t('Alt+↑ conversation · Alt+↓ view') } : {} : mode === 'conversation' ? { keys: conversationKeys(t) } : mode === 'search-select' ? { keys: searchKeys(t) } : {}, ...chip === undefined ? {} : { chip }, ...toggle() === undefined || mode !== 'prompt' ? {} : { toggle: toggle()! } }
  }
  let shape = JSON.stringify(current() ?? null)
  const pane = ctx.mayflyPanes.register({
    id: 'mayfly.pane.notification',
    placement: 'bottom',
    priority: 9,
    narrow: 'bottom',
  }, NotificationLine(current()))
  const refresh = (): void => {
    const next = current()
    const key = JSON.stringify(next ?? null)
    if (key === shape) return
    shape = key
    pane.set(NotificationLine(next))
  }
  const offLocale = observeTranscriptLocale(ctx, refresh)
  const offLane = interaction?.subscribe(refresh)
  const offAgent = factsService?.subscribeAgent(refresh)
  const offConversations = conversations.subscribe(refresh)
  const offMode = ctx.on('mayfly/focus-mode-changed', (next) => {
    mode = next
    refresh()
  })
  const offTail = ctx.on('mayfly/content-tail-changed', (label) => {
    chip = label
    refresh()
  })
  ctx.effect(() => () => {
    offLocale()
    offLane?.()
    offAgent?.()
    offConversations()
    offTail()
    offMode()
    pane.dispose()
  })
}
