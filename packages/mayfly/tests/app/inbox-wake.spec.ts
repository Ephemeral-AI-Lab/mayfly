/** The queue nudge wakes an Agent whose pending inbox a settled abort or failed turn left behind. @module app/inbox-wake */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as inboxWake from '../../src/app/inbox-wake.ts'
import { INBOX_WAKE_COOLDOWN_MS } from '../../src/app/inbox-wake.ts'

interface Pending {
  readonly id: string
}

/** One live Agent with the two inbox lanes the nudge reads and the two wake calls it makes. */
function fakeAgent() {
  const nextTurn: Pending[] = [{ id: 'turn-1' }, { id: 'turn-2' }]
  const nextStep: Pending[] = []
  const followed: string[] = []
  const steered: string[] = []
  const agent = {
    id: 'agent-1',
    session: { id: 'agent-1' },
    status: 'idle' as 'idle' | 'running',
    inbox: {
      get nextTurn() { return nextTurn },
      get nextStep() { return nextStep },
      remove(id: string): boolean {
        for (const lane of [nextStep, nextTurn]) {
          const at = lane.findIndex(message => message.id === id)
          if (at >= 0) { lane.splice(at, 1); return true }
        }
        return false
      },
    },
    followup(message: Pending): void { followed.push(message.id); this.status = 'running' },
    steer(message: Pending): void { steered.push(message.id); this.status = 'running' },
  }
  return { agent, nextTurn, nextStep, followed, steered }
}

/** The plugin under a Fiber, with the Agent registry it resolves identity through. */
async function bench() {
  const parts = fakeAgent()
  const ctx = new Context()
  ctx.provide('agents', { get: (id: string) => id === parts.agent.id ? parts.agent : undefined } as never)
  const fiber = ctx.plugin(inboxWake)
  // Cordis applies an injected plugin off the current job; let it register its listeners and timers first.
  await Promise.resolve()
  await Promise.resolve()
  return { ...parts, ctx, fiber }
}

const emitStatus = (ctx: Context, agent: ReturnType<typeof fakeAgent>['agent'], status: 'idle' | 'running'): void => {
  ctx.emit('agent/status', { agent: agent as unknown as Agent, status })
}

/** The turn the nudge exists for: it ended aborted with the queue kept, so its driver parked the inbox. */
const park = (ctx: Context, id = 'agent-1', reason: 'aborted' | 'error' = 'aborted'): void => {
  ctx.emit('session/event', { id } as never, { type: 'turn/end', data: { reason: { kind: reason } } } as never)
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }) })
afterEach(() => { vi.useRealTimers() })

describe('the parked-inbox nudge', () => {
  it('re-submits the oldest queued turn and leaves the rest in the inbox', async () => {
    const { agent, ctx, fiber, nextTurn, followed, steered } = await bench()
    park(ctx)
    emitStatus(ctx, agent, 'idle')
    vi.advanceTimersByTime(INBOX_WAKE_COOLDOWN_MS)
    expect(followed).toEqual(['turn-1'])
    expect(steered).toEqual([])
    expect(nextTurn.map(message => message.id)).toEqual(['turn-2'])
    expect(agent.status).toBe('running')
    await fiber.dispose()
  })

  it('re-submits steering through steer, in claim order', async () => {
    const { agent, ctx, fiber, nextStep, steered, followed } = await bench()
    nextStep.push({ id: 'step-1' })
    park(ctx)
    emitStatus(ctx, agent, 'idle')
    vi.advanceTimersByTime(INBOX_WAKE_COOLDOWN_MS)
    expect(steered).toEqual(['step-1'])
    expect(followed).toEqual([])
    await fiber.dispose()
  })

  it('wakes a resumed Agent that was published idle with durable pending input', async () => {
    const { agent, ctx, fiber, followed } = await bench()
    ctx.emit('agent/created', { agent: agent as unknown as Agent, source: 'resume' })
    vi.advanceTimersByTime(INBOX_WAKE_COOLDOWN_MS)
    expect(followed).toEqual(['turn-1'])
    await fiber.dispose()
  })

  it('leaves a queue an idle Agent never parked alone, and a new turn clears the mark', async () => {
    const { agent, ctx, fiber, followed } = await bench()
    // No aborted or failed turn: this is the replay's seeded queue (or a row the person is still working on).
    emitStatus(ctx, agent, 'idle')
    vi.advanceTimersByTime(INBOX_WAKE_COOLDOWN_MS)
    expect(followed).toEqual([])
    // A settled abort parks it, but the next turn start (a normal boundary took the queue) retires the mark.
    park(ctx)
    ctx.emit('session/event', { id: 'agent-1' } as never, { type: 'turn/start' } as never)
    emitStatus(ctx, agent, 'idle')
    vi.advanceTimersByTime(INBOX_WAKE_COOLDOWN_MS)
    expect(followed).toEqual([])
    await fiber.dispose()
  })

  it('never talks to a running, disposed, or claimed-away Agent', async () => {
    const first = await bench()
    park(first.ctx)
    first.agent.status = 'running'
    emitStatus(first.ctx, first.agent, 'idle')
    vi.advanceTimersByTime(INBOX_WAKE_COOLDOWN_MS)
    expect(first.followed).toEqual([])
    await first.fiber.dispose()

    const second = await bench()
    second.agent.inbox.remove = () => false
    park(second.ctx)
    emitStatus(second.ctx, second.agent, 'idle')
    vi.advanceTimersByTime(INBOX_WAKE_COOLDOWN_MS)
    expect(second.followed).toEqual([])
    await second.fiber.dispose()
  })

  it('schedules one wake for a burst of idle transitions, and unload cancels it', async () => {
    const { agent, ctx, fiber, followed } = await bench()
    park(ctx)
    emitStatus(ctx, agent, 'idle')
    emitStatus(ctx, agent, 'idle')
    vi.advanceTimersByTime(INBOX_WAKE_COOLDOWN_MS)
    expect(followed).toEqual(['turn-1'])
    await fiber.dispose()

    const late = await bench()
    park(late.ctx)
    emitStatus(late.ctx, late.agent, 'idle')
    await late.fiber.dispose()
    vi.advanceTimersByTime(INBOX_WAKE_COOLDOWN_MS)
    expect(late.followed).toEqual([])
  })

  it('wakes the next queued message on the next settle and leaves an empty inbox silent', async () => {
    const { agent, ctx, fiber, followed, nextTurn } = await bench()
    park(ctx)
    emitStatus(ctx, agent, 'idle')
    vi.advanceTimersByTime(INBOX_WAKE_COOLDOWN_MS)
    expect(followed).toEqual(['turn-1'])
    // The next turn settles aborted too: the message after it starts the one after that.
    agent.status = 'idle'
    park(ctx)
    emitStatus(ctx, agent, 'idle')
    vi.advanceTimersByTime(INBOX_WAKE_COOLDOWN_MS)
    expect(followed).toEqual(['turn-1', 'turn-2'])
    expect(nextTurn).toEqual([])
    // Idle again with nothing pending: the wake finds no message and calls nothing.
    agent.status = 'idle'
    emitStatus(ctx, agent, 'idle')
    vi.advanceTimersByTime(INBOX_WAKE_COOLDOWN_MS)
    expect(followed).toEqual(['turn-1', 'turn-2'])
    await fiber.dispose()
  })
})
