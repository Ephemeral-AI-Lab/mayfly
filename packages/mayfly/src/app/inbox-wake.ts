/**
 * Wake a live Agent whose pending inbox was parked by a settled abort or a
 * failed turn.
 *
 * The Harness loop only re-arms itself for queued input on two paths: a
 * normal turn boundary keeps the driver and reads the inbox again, and
 * `wakeDriver()` re-runs after an aborted activity when `wakeRequested` was
 * set. A message queued before the turn was cancelled is not such a wake, and
 * an errored turn throws out of `turn()` before its inbox check, so in both
 * cases an idle Agent can hold pending input forever. Mayfly's interrupt
 * (`keepInbox`) and the provider's `TRANSPORT` failure both reach that state.
 *
 * This service restores the documented behavior — the queue runs as soon as
 * the aborted or failed turn settles — through the public inbox and Agent
 * APIs: take the oldest pending message, put it back in its own lane, and let
 * `followup`/`steer` wake the driver. The remove is the wake's guard as well
 * as its atomic claim: a message the loop claimed first is left alone.
 *
 * Only a turn that ended `aborted` or `error` (or a resumed Agent) arms the
 * nudge. A queue an idle Agent holds for any other reason — the replay's
 * seeded rows, a message the person is still editing — is not sent behind
 * their back.
 *
 * Delete this file when the pinned `@deepseek-ai/dsh-agent-loop` wakes an idle
 * Agent whose inbox still has pending input after any settled activity.
 *
 * @module @ephemeral-ai/mayfly/app/inbox-wake
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** Stable Cordis plugin name. */
export const name = 'mayfly-inbox-wake'

/** Services required before the nudge can observe Agents. */
export const inject = ['agents']

/** Quiet time after one nudge before the next; a resumed Agent may settle twice in a row. */
export const INBOX_WAKE_COOLDOWN_MS = 250

/** The lane of the first message the Agent's inbox holds, in claim order. */
type PendingLane = 'step' | 'turn'

/**
 * The lane the Agent's next claimed message waits in, in claim order:
 * steering before the next turn, exactly as `ReactLoopInbox.claim` reads them.
 * @param agent - the live Agent.
 * @returns the oldest pending lane, or `undefined` when the inbox is empty.
 */
function firstPendingLane(agent: Agent): PendingLane | undefined {
  if (agent.inbox.nextStep.length > 0) return 'step'
  if (agent.inbox.nextTurn.length > 0) return 'turn'
  return undefined
}

/**
 * Mount the queue nudge. A status transition to `idle` after an aborted or
 * failed turn, or a resumed Agent created with pending input, schedules one
 * wake after the cooldown; timers and listeners are Fiber-owned.
 * @param ctx - the app context.
 */
export function apply(ctx: Context): void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const lastWake = new Map<string, number>()
  /** Session ids whose driver went idle with a queue an abort or a failure left behind. */
  const parked = new Set<string>()

  /** Wake one Agent by re-submitting the message that already waits in its inbox. */
  const wake = (agent: Agent): void => {
    const id = String(agent.id)
    if (!parked.has(id)) return
    // The Agent may have been disposed or started another turn while the timer waited.
    if (ctx.agents.get(agent.id) !== agent || agent.status !== 'idle') return
    const lane = firstPendingLane(agent)
    if (lane === undefined) {
      parked.delete(id)
      return
    }
    const message = lane === 'step' ? agent.inbox.nextStep[0]! : agent.inbox.nextTurn[0]!
    // `remove` is the atomic claim: a driver that woke first owns the message now.
    if (!agent.inbox.remove(message.id)) return
    parked.delete(id)
    if (lane === 'step') agent.steer(message)
    else agent.followup(message)
  }

  /** Queue one wake for the Agent after the cooldown; a later idle transition does not stack another. */
  const schedule = (agent: Agent): void => {
    const id = String(agent.id)
    if (!parked.has(id) || timers.has(id)) return
    const due = (lastWake.get(id) ?? 0) + INBOX_WAKE_COOLDOWN_MS - Date.now()
    const timer = setTimeout(() => {
      timers.delete(id)
      lastWake.set(id, Date.now())
      wake(agent)
    }, Math.max(0, due))
    if (typeof (timer as { unref?: unknown }).unref === 'function') (timer as { unref(): void }).unref()
    timers.set(id, timer)
  }

  // A settled abort or failure is what parks the queue; a normal turn boundary keeps its driver and must not be nudged.
  const offTurn = ctx.on('session/event', (session, event) => {
    const id = String(session.id)
    if (event.type === 'turn/start') {
      parked.delete(id)
      return
    }
    if (event.type !== 'turn/end') return
    const reason = event.data.reason.kind
    if (reason === 'aborted' || reason === 'error') parked.add(id)
  })
  const offStatus = ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle' && agent != null) schedule(agent)
  })
  // A resumed Agent is published idle with whatever its durable inbox still holds; the crash or quit parked it.
  const offCreated = ctx.on('agent/created', ({ agent, source }) => {
    if (agent == null) return
    if (source === 'resume') parked.add(String(agent.id))
    schedule(agent)
  })
  const offDisposed = ctx.on('agent/disposed', ({ agent }) => {
    const id = String(agent.id)
    parked.delete(id)
    const timer = timers.get(id)
    if (timer === undefined) return
    clearTimeout(timer)
    timers.delete(id)
  })
  ctx.effect(() => () => {
    offTurn()
    offStatus()
    offCreated()
    offDisposed()
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    lastWake.clear()
    parked.clear()
  })
}
