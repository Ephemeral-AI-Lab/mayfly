/**
 * The notification pane: the one row between the activity block and the editor that carries the notice to read now.
 * It shows the notification lane's records (the commands' feedback, an editor extension's report, and the notices
 * `notices.ts` raises from the session's facts) one at a time, the most severe and then the newest, scoped to the app
 * or the current session, with a muted `+N` for the ones waiting behind it. The lane keeps the records and their
 * lifetimes (`✓` and information leave after five seconds of visible time, `⚠` and `✗` stay), so the pane holds no timer: it
 * reads the lane when the lane or the current Agent changes and publishes only when the notice on the row changed.
 * When the stream is scrolled away from its tail, the row also carries the chip back to it, centered, announced by the
 * surface renderer (`mayfly/content-tail-changed`); the notice yields the room the chip needs. With no notice the row
 * carries what the prompt awaits, its history counter, the keys of the token under its caret, or else a muted hint of the keys
 * that move focus off the prompt; while the turn runs that hint rotates on the host tick through that group, the keys that
 * steer or stop the turn, the draft's keys, and the keys that switch plan and model (the first alone with quiet hints off).
 * While a second conversation is open, its keys (`F7 btw · F8 close`) come first on the right and take the place of that
 * generic hint. While the stream holds focus the left carries the keys of the row the cursor is on. `components/notification-line.ts`
 * draws it as one row in the alternate layout the pane is compiled in (not in `main` screen mode), so the editor never shifts.
 *
 * @module @ephemeral-ai/mayfly/transcript/pane-notification
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MayflyFeedbackRecord } from '@ephemeral-ai/mayfly-ui'
import type { MayflyConversationView } from '../app/conversation-views.ts'
import { ACTION_CLOSE_AGENT_VIEW, ACTION_TOGGLE_AGENT_VIEW, interactionKeyHint } from '../interaction/keys.ts'
import { NotificationLine, type NotificationFacts, type NotificationKeyPart, type NotificationRowFacts } from '../components/notification-line.ts'
import type { MayflyFocusMode, MayflyFocusRow } from '../core/types.ts'
import type { MayflyTranslate } from '../frontend/locale.ts'
import { observeTranscriptLocale } from './locale.ts'
import type { SessionFactsService } from './session-facts.ts'
import type { TickSource } from './tick.ts'

/** Ticks one group of the running-turn hint stays up before the next replaces it. */
const HINT_TICKS = 15

/** The groups the hint rotates through while a turn runs: where focus goes, how to steer or stop the turn, how to clear or edit the draft, how to switch plan and model. */
const RUNNING_HINTS = [
  'Alt+↑ conversation · Alt+↓ view',
  'Ctrl+Enter steer · Esc interrupt',
  'Ctrl+C clear · Ctrl+G editor',
  'Shift+Tab plan · Alt+M model',
] as const

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

/** The keys on a queued message: the row's own verbs read first and outlast the rest, after `Esc back`. */
function queuedKeys(t: MayflyTranslate): readonly NotificationKeyPart[] {
  return [
    { text: t('e edit'), priority: 1 }, { text: t('s send now'), priority: 3 }, { text: t('d cancel'), priority: 2 }, { text: t('Enter expand'), priority: 4 },
    { text: t('c copy'), priority: 6 }, { text: t('↑/↓ select'), priority: 5 }, { text: t('Esc back'), priority: 0 },
  ]
}

/** The keys on a steering message: as on a queued one, without `s send now` (it is already in the steer lane). */
function steeringKeys(t: MayflyTranslate): readonly NotificationKeyPart[] {
  return [
    { text: t('e edit'), priority: 1 }, { text: t('d cancel'), priority: 2 }, { text: t('Enter expand'), priority: 3 },
    { text: t('c copy'), priority: 5 }, { text: t('↑/↓ select'), priority: 4 }, { text: t('Esc back'), priority: 0 },
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
  /** What the prompt awaits (the clipboard, the file search), else `undefined`. */
  let promptWait: string | undefined
  /** What the prompt teaches about the token its caret is on (`Ctrl+G opens · Backspace removes`), else `undefined`. */
  let promptHint: string | undefined
  /** Where the prompt stands in its history while it is browsed: the counter takes the place of the hints. */
  let recall: string | undefined
  /** What the stream's cursor stands on that has keys of its own, while the stream holds focus. */
  let row: MayflyFocusRow
  /** Whether the displayed Agent's turn runs: the hint then rotates through {@link RUNNING_HINTS}. */
  let running = false
  /** The group of {@link RUNNING_HINTS} on show, and the ticks it has been up. */
  let group = 0
  let ticks = 0
  /** Quiet hints `off` keeps the first group only. */
  const hintsOff = (): boolean => ctx.get('mayflyInteractionState')?.settingsSource()?.quietHints === 'off'
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
    const base = { ...notice === undefined ? {} : { notice }, ...chip === undefined ? {} : { chip } }
    if (mode !== 'prompt') {
      const keys = mode === 'conversation' ? row === 'queued' ? queuedKeys(t) : row === 'steering' ? steeringKeys(t) : conversationKeys(t) : mode === 'search-select' ? searchKeys(t) : undefined
      return { ...base, ...keys === undefined ? {} : { keys } }
    }
    const way = toggle()
    // With no notice the row teaches: where the history walk stands, the keys of the token under the caret, else where focus can go
    // from the prompt (up into the conversation, down to the items of the status row), rotating while a turn runs. The way between
    // conversations takes the place of that last, generic hint; what the prompt awaits is shown before any hint.
    const hint = recall ?? promptHint ?? (way === undefined ? t(RUNNING_HINTS[running && !hintsOff() ? group : 0]!) : undefined)
    return { ...base, ...way === undefined ? {} : { toggle: way }, ...notice !== undefined ? {} : { ...promptWait === undefined ? {} : { wait: promptWait }, ...hint === undefined ? {} : { hint } } }
  }
  /** A panel in the editor slot takes the status rows' place: the row stands aside until it closes. */
  let panelOpen = false
  let shape = JSON.stringify(current() ?? null)
  const pane = ctx.mayflyPanes.register({
    id: 'mayfly.pane.notification',
    placement: 'bottom',
    priority: 9,
    narrow: 'bottom',
  }, NotificationLine(current()))
  const refresh = (): void => {
    const next = current()
    const key = `${panelOpen ? 'panel' : ''}${JSON.stringify(next ?? null)}`
    if (key === shape) return
    shape = key
    pane.set(panelOpen ? null : NotificationLine(next))
  }
  /** The rotation runs on the host tick while a turn runs, and starts again from the first group with each turn. */
  const tick = ctx.get('mayflyTick') as TickSource | undefined
  let offTick: (() => void) | undefined
  const syncRunning = (): void => {
    const next = factsService?.currentAgent?.status === 'running'
    if (next === running) return
    running = next
    group = 0
    ticks = 0
    if (running && offTick === undefined) {
      offTick = tick?.subscribe(() => {
        ticks += 1
        if (ticks % HINT_TICKS !== 0) return
        group = (group + 1) % RUNNING_HINTS.length
        refresh()
      })
    } else if (!running) {
      offTick?.()
      offTick = undefined
    }
    refresh()
  }
  syncRunning()
  const offStatus = ctx.on('agent/status', syncRunning)
  const offSettings = ctx.on('settings/document-updated', (namespace) => { if (String(namespace) === 'mayfly') refresh() })
  const offLocale = observeTranscriptLocale(ctx, refresh)
  const offLane = interaction?.subscribe(refresh)
  const offAgent = factsService?.subscribeAgent(() => { syncRunning(); refresh() })
  const offConversations = conversations.subscribe(refresh)
  const offMode = ctx.on('mayfly/focus-mode-changed', (next) => {
    mode = next
    refresh()
  })
  const offPanel = ctx.on('mayfly/panel-open-changed', (open) => {
    panelOpen = open
    refresh()
  })
  const offHint = ctx.on('mayfly/prompt-hint-changed', (next) => {
    promptHint = next
    refresh()
  })
  const offRow = ctx.on('mayfly/focus-row-changed', (next) => {
    row = next
    refresh()
  })
  const offRecall = ctx.on('mayfly/prompt-recall-changed', (next) => {
    recall = next === undefined ? undefined : t('↑ history {index}/{total}', { index: next.index, total: next.total })
    refresh()
  })
  const offWait = ctx.on('mayfly/prompt-wait-changed', (next) => {
    promptWait = next
    refresh()
  })
  const offTail = ctx.on('mayfly/content-tail-changed', (label) => {
    chip = label
    refresh()
  })
  ctx.effect(() => () => {
    offLocale()
    offStatus()
    offSettings()
    offTick?.()
    offLane?.()
    offAgent?.()
    offConversations()
    offTail()
    offPanel()
    offWait()
    offRow()
    offRecall()
    offHint()
    offMode()
    pane.dispose()
  })
}
