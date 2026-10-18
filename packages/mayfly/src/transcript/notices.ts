/**
 * The notices the session's presentation facts and native context projection raise, reported into the notification
 * lane for the notification pane to show: a provider request waiting to be retried (a rate limit by its status), a
 * context that is nearly full (from `contextPressure`), and a session resumed with its history. Nothing here folds
 * events, and the lane owns the lifetimes (the warnings stay while their fact holds and are cleared with it, the resume
 * notice is `info` and leaves after five seconds), and a blocked goal (it waits for you, so the notice stays while it is
 * blocked). The retry countdown is re-reported on the host's one tick. Offline and a low balance are not raised: the
 * Harness has no signal for the first and the balance is not read yet.
 *
 * @module @ephemeral-ai/mayfly/transcript/notices
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContextPressureProjection } from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { MayflyTranslate } from '../frontend/locale.ts'
import type { ConversationFacts } from '../conversation/types.ts'
import { createInteractionNotificationOwner } from '../interaction/notifications.ts'
import type { SessionFactsService } from './session-facts.ts'
import { contextPercent } from './status-context.ts'
import type { TickSource } from './tick.ts'

/** The occupancy from which the context notice shows (the Harness has no threshold of its own to follow). */
export const CONTEXT_WARN_PERCENT = 92
/** The higher occupancies that report once more when the context crosses them. */
export const CONTEXT_THRESHOLDS: readonly number[] = [CONTEXT_WARN_PERCENT, 95, 98]

const RETRY = 'notice/retry'
const CONTEXT = 'notice/context'
const RESUMED = 'notice/resumed'
const GOAL = 'notice/goal'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * The notice of a retry wait: a rate limit by its HTTP status, any other failure as a provider error with its reason. The wait
 * (the countdown and the attempt) ends the message and is its `tail`, so a narrow row cuts the front and keeps the countdown.
 */
function retryText(retrying: NonNullable<ConversationFacts['retrying']>, now: number, t: MayflyTranslate): { readonly message: string, readonly tail: string } {
  const seconds = Math.max(0, Math.ceil((retrying.at + retrying.delayMs - now) / 1000))
  const attempt = Number.isFinite(retrying.maxRetries) ? `${retrying.retry}/${retrying.maxRetries}` : String(retrying.retry)
  const rateLimited = retrying.status === 429
  const head = rateLimited ? 'Rate limited' : 'Provider error'
  const wait = seconds === 0 ? t('retrying {attempt}…', { attempt }) : t('retrying in {seconds}s · {attempt}', { seconds, attempt })
  return { message: [t(head), ...rateLimited || retrying.reason === undefined ? [] : [retrying.reason], wait].join(' · '), tail: wait }
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
  const projections = ctx.get('sessionProjections')
  /** The main sessions this has already looked at: a session is announced as resumed once, not each time the person switches back to it. */
  const seen = new WeakSet<object>()
  let facts: ConversationFacts = factsService.current
  let pressure: ContextPressureProjection | undefined
  /** The highest context threshold already reported for the attached session; 0 below the warning. */
  let reportedContext = 0
  let offTick: (() => void) | undefined
  /** Set when the Agent changed and the facts of the new session have not been read yet. */
  let fresh = false

  /** The exact selected Agent's native context-pressure value, when the registry is composed. */
  const readPressure = (): ContextPressureProjection | undefined => {
    const session = factsService.currentAgent?.session
    return session === undefined || projections === undefined
      ? undefined
      : projections.snapshot(session, ['contextPressure']).values.contextPressure
  }
  pressure = readPressure()

  const reportRetry = (now: number): void => {
    const retrying = facts.retrying
    if (retrying === undefined) return
    owner.report(RETRY, { severity: 'warning', ...retryText(retrying, now, t) })
  }
  /** A blocked goal waits for the person: the notice holds while the goal is blocked and leaves with it. */
  const reportGoal = (): void => {
    const blocked = factsService.currentGoal?.goal.blockedReason
    if (factsService.currentGoal?.goal.phase !== 'blocked' || blocked === undefined) owner.clear(GOAL)
    else owner.report(GOAL, { severity: 'warning', message: t('Goal blocked · {code}: {message}', { code: blocked.code, message: blocked.message }) })
  }
  const stopTick = (): void => {
    offTick?.()
    offTick = undefined
  }
  const sync = (): void => {
    if (fresh) {
      fresh = false
      reportedContext = 0
      owner.clearAll()
      reportGoal()
      // Only the main session is announced, and only when it is first attached: a switch between conversations (F7) is not a resume.
      const agent = factsService.currentAgent
      const primary = ctx.get('mayflyConversations')?.snapshot().views.find(view => view.kind === 'primary')
      const announce = agent !== null && (primary === undefined || primary.sessionId === String(agent.id)) && !seen.has(agent)
      if (announce) seen.add(agent)
      if (announce && facts.turn > 0 && !facts.active) {
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
    const window = pressure?.contextWindow
    const used = pressure?.projectedTokens ?? pressure?.pressureTokens
    const percent = window === undefined || used === undefined ? 0 : contextPercent(used, window)
    // Report once when the context enters a threshold band: 92, then 95, then 98. A delta inside the band, or a drop
    // back into it, says nothing; dropping below the warning clears the notice and arms the crossings again.
    const threshold = window === undefined || used === undefined
      ? undefined
      : CONTEXT_THRESHOLDS.findLast(each => percent >= each)
    if (threshold === undefined) {
      reportedContext = 0
      owner.clear(CONTEXT)
    } else if (threshold > reportedContext) {
      reportedContext = threshold
      owner.report(CONTEXT, { severity: 'warning', message: t('Context {percent}% full · /compact now', { percent }) })
    }
  }

  const offGoal = factsService.subscribeGoal(reportGoal)
  const offAgent = factsService.subscribeAgent(() => {
    fresh = true
    pressure = readPressure()
  })
  const offFacts = factsService.subscribe((next) => {
    facts = next
    sync()
  })
  // The native occupancy can move without a presentation-facts change
  // (compaction repricing, a new request's usage); re-read only this Agent's key.
  const offPressure = projections?.onChanged((session, key) => {
    if (key !== 'contextPressure' || session !== factsService.currentAgent?.session) return
    pressure = readPressure()
    sync()
  })
  ctx.effect(() => () => {
    offAgent()
    offGoal()
    offFacts()
    offPressure?.()
    stopTick()
  })
}
