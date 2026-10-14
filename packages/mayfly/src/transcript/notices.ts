/**
 * The notices the session's facts raise, reported into the notification lane for the notification pane to show: a
 * provider request waiting to be retried (a rate limit by its status), a context that is nearly full, and a session
 * resumed with its history. Each is a pure function of `mayflySessionFacts`: nothing here folds events, and the lane
 * owns the lifetimes (the warnings stay while their fact holds and are cleared with it, the resume notice is `info`
 * and leaves after five seconds). The retry countdown is re-reported on the host's one tick. Offline and a low balance
 * are not raised: the Harness has no signal for the first and the balance is not read yet.
 *
 * @module @ephemeral-ai/mayfly/transcript/notices
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MayflyTranslate } from '../frontend/locale.ts'
import type { ConversationFacts } from '../conversation/types.ts'
import { createInteractionNotificationOwner } from '../interaction/notifications.ts'
import type { SessionFactsService } from './session-facts.ts'
import { contextPercent } from './status-context.ts'
import type { TickSource } from './tick.ts'

/** The occupancy from which the context notice shows (the Harness has no threshold of its own to follow). */
export const CONTEXT_WARN_PERCENT = 92

const RETRY = 'notice/retry'
const CONTEXT = 'notice/context'
const RESUMED = 'notice/resumed'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** The notice text of a retry wait: a rate limit by its HTTP status, any other failure as a provider error. */
function retryText(retrying: NonNullable<ConversationFacts['retrying']>, now: number, t: MayflyTranslate): string {
  const seconds = Math.max(0, Math.ceil((retrying.at + retrying.delayMs - now) / 1000))
  const attempt = Number.isFinite(retrying.maxRetries) ? `${retrying.retry}/${retrying.maxRetries}` : String(retrying.retry)
  const rateLimited = retrying.status === 429
  const head = rateLimited ? 'Rate limited' : 'Provider error'
  const wait = seconds === 0 ? t('retrying {attempt}…', { attempt }) : t('retrying in {seconds}s · {attempt}', { seconds, attempt })
  return [t(head), wait, ...rateLimited || retrying.reason === undefined ? [] : [retrying.reason]].join(' · ')
}

/** How long ago, as the session list says it (`5m ago`, `2h ago`, `3d ago`). */
function ageText(ms: number, t: MayflyTranslate): string {
  if (ms < MINUTE) return t('just now')
  if (ms < HOUR) return t('{count}m ago', { count: Math.floor(ms / MINUTE) })
  if (ms < DAY) return t('{count}h ago', { count: Math.floor(ms / HOUR) })
  return t('{count}d ago', { count: Math.floor(ms / DAY) })
}

/**
 * Mount the notices under the calling Fiber.
 * @param ctx - plugin context; needs `mayflySessionFacts`, `mayflyUiInteraction`, and `mayflyTick`.
 * @param t - the translator of the namespace that holds the notice texts.
 * @param clock - the time source the retry countdown and the resume age are measured against.
 */
export function mountNotices(ctx: Context, t: MayflyTranslate, clock: () => number): void {
  const factsService = ctx.get('mayflySessionFacts') as SessionFactsService | undefined
  const tick = ctx.get('mayflyTick') as TickSource | undefined
  if (factsService === undefined) return
  const owner = createInteractionNotificationOwner(ctx, 'mayfly.notices', 'notices')
  let facts: ConversationFacts = factsService.current
  let offTick: (() => void) | undefined
  /** Set when the Agent changed and the facts of the new session have not been read yet. */
  let fresh = false

  const reportRetry = (now: number): void => {
    const retrying = facts.retrying
    if (retrying === undefined) return
    owner.report(RETRY, { severity: 'warning', message: retryText(retrying, now, t) })
  }
  const stopTick = (): void => {
    offTick?.()
    offTick = undefined
  }
  const sync = (): void => {
    if (fresh) {
      fresh = false
      owner.clearAll()
      if (facts.turn > 0 && !facts.active) {
        const age = facts.endedAt === undefined ? undefined : Math.max(0, clock() - facts.endedAt)
        const turns = facts.turn === 1 ? t('1 turn') : t('{count} turns', { count: facts.turn })
        owner.report(RESUMED, {
          severity: 'info',
          message: [t('Resumed session'), turns, ...age === undefined ? [] : [t('last active {age}', { age: ageText(age, t) })]].join(' · '),
        })
      }
    }
    if (facts.retrying === undefined) {
      stopTick()
      owner.clear(RETRY)
    } else {
      reportRetry(clock())
      if (offTick === undefined && tick !== undefined) offTick = tick.subscribe(now => { reportRetry(now) })
    }
    const window = facts.contextWindow
    const percent = window === undefined ? 0 : contextPercent(facts.contextTokens, window)
    if (percent >= CONTEXT_WARN_PERCENT) owner.report(CONTEXT, { severity: 'warning', message: t('Context {percent}% full · /compact now', { percent }) })
    else owner.clear(CONTEXT)
  }

  const offAgent = factsService.subscribeAgent(() => { fresh = true })
  const offFacts = factsService.subscribe((next) => {
    facts = next
    sync()
  })
  ctx.effect(() => () => {
    offAgent()
    offFacts()
    stopTick()
  })
}
