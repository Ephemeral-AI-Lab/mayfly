/**
 * Decision tests of the notices the session's facts raise into the notification lane: a rate limit by status 429 and
 * any other provider error (their texts, the countdown re-reported on the host's tick, the record cleared with the
 * fact), the context notice from 92% occupancy and its silence without a window, the resumed-session notice once per
 * Agent switch and never while the session is active, and the Fiber that owns the records retiring them on unload.
 * Time comes from an injected clock and a hand-driven tick; nothing sleeps.
 * @module transcript-notices
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { initialConversationFacts } from '../../src/conversation/facts.ts'
import type { ConversationFacts } from '../../src/conversation/types.ts'
import { UiInteractionService } from '../../src/core/ui-interaction-state.ts'
import { CONTEXT_WARN_PERCENT, mountNotices } from '../../src/transcript/notices.ts'
import type { TickSource } from '../../src/transcript/tick.ts'
import { transcriptTranslatorFake } from './notices-fakes.ts'

const NOW = 1_700_000_000_000

/** A facts source the test drives: the value, its listeners, and the Agent switch listeners. */
class HandFacts {
  current: ConversationFacts = initialConversationFacts()
  currentAgent: { readonly id: string, readonly status: string } | undefined = { id: 'agent-1', status: 'idle' }
  private readonly listeners = new Set<(facts: ConversationFacts) => void>()
  private readonly agentListeners = new Set<(agent: unknown) => void>()

  set(next: Partial<ConversationFacts>): void {
    this.current = { ...this.current, ...next }
    for (const listener of this.listeners) listener(this.current)
  }

  switchTo(agent: { readonly id: string, readonly status: string }, facts: Partial<ConversationFacts>): void {
    this.currentAgent = agent
    this.current = { ...initialConversationFacts(), ...facts }
    for (const listener of this.agentListeners) listener(agent)
    for (const listener of this.listeners) listener(this.current)
  }

  subscribe(listener: (facts: ConversationFacts) => void): () => void {
    this.listeners.add(listener)
    listener(this.current)
    return () => { this.listeners.delete(listener) }
  }

  subscribeAgent(listener: (agent: unknown) => void): () => void {
    this.agentListeners.add(listener)
    return () => { this.agentListeners.delete(listener) }
  }
}

/** A tick the test fires by hand, with the listeners it has. */
class HandTick implements TickSource {
  readonly listeners = new Set<(now: number) => void>()
  subscribe(listener: (now: number) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  fire(now: number): void {
    for (const listener of [...this.listeners]) listener(now)
  }
}

interface Harness {
  readonly ctx: Context
  readonly facts: HandFacts
  readonly tick: HandTick
  readonly lane: UiInteractionService
  clock: { now: number }
  /** The texts of the notices the lane holds, by their producer id. */
  notices(): Record<string, string>
  dispose(): Promise<void>
}

/** Mount the notices under a plugin Fiber, with the lane, facts and tick they read. */
async function boot(facts = new HandFacts()): Promise<Harness> {
  const ctx = new Context()
  const lane = new UiInteractionService(ctx)
  const tick = new HandTick()
  const clock = { now: NOW }
  ctx.reflect.provide('mayflySessionFacts', facts)
  ctx.reflect.provide('mayflyTick', tick)
  const fiber = await ctx.plugin({
    name: 'notices-under-test',
    apply(owner: Context) {
      mountNotices(owner, transcriptTranslatorFake, () => clock.now)
    },
  })
  return {
    ctx, facts, tick, lane, clock,
    notices: () => Object.fromEntries(lane.notificationSnapshot().map(record => [record.id.replace(/^mayfly\.notices\/\d+\//u, ''), record.message])),
    dispose: () => fiber.dispose(),
  }
}

/** A retry wait the provider raised: the attempt, its delay, and the status it failed with. */
const retry = (status: number, extra: Partial<NonNullable<ConversationFacts['retrying']>> = {}): NonNullable<ConversationFacts['retrying']> => ({
  at: NOW, delayMs: 5_000, retry: 1, maxRetries: 5, status, ...extra,
} as NonNullable<ConversationFacts['retrying']>)

describe('notices from the session facts', () => {
  it('says a rate limit by its status 429, with the countdown and the attempt', async () => {
    const harness = await boot()
    harness.facts.set({ retrying: retry(429) })
    expect(harness.notices()).toEqual({ 'notice/retry': 'Rate limited · retrying in 5s · 1/5' })
    await harness.dispose()
  })

  it('says any other failure as a provider error, with the reason the Harness gave', async () => {
    const harness = await boot()
    harness.facts.set({ retrying: retry(503, { reason: 'overloaded' }) })
    expect(harness.notices()).toEqual({ 'notice/retry': 'Provider error · retrying in 5s · 1/5 · overloaded' })
    await harness.dispose()
  })

  it('re-reports the countdown on each tick, and says the attempt when the wait has run out', async () => {
    const harness = await boot()
    harness.facts.set({ retrying: retry(429) })
    harness.clock.now = NOW + 2_000
    harness.tick.fire(NOW + 2_000)
    expect(harness.notices()).toEqual({ 'notice/retry': 'Rate limited · retrying in 3s · 1/5' })
    harness.tick.fire(NOW + 5_000)
    expect(harness.notices()).toEqual({ 'notice/retry': 'Rate limited · retrying 1/5…' })
    await harness.dispose()
  })

  it('clears the retry record and stops the countdown once the retry fact is gone', async () => {
    const harness = await boot()
    harness.facts.set({ retrying: retry(429) })
    expect(harness.tick.listeners.size).toBe(1)
    harness.facts.set({ retrying: undefined })
    expect(harness.notices()).toEqual({})
    expect(harness.tick.listeners.size).toBe(0)
    await harness.dispose()
  })

  it('warns from 92% context occupancy, says how full it is, and clears below the threshold', async () => {
    expect(CONTEXT_WARN_PERCENT).toBe(92)
    const harness = await boot()
    harness.facts.set({ contextWindow: 64_000, contextTokens: 50_000 })
    expect(harness.notices()).toEqual({})
    harness.facts.set({ contextTokens: 59_000 })
    expect(harness.notices()).toEqual({ 'notice/context': 'Context 93% full · /compact now' })
    harness.facts.set({ contextTokens: 40_000 })
    expect(harness.notices()).toEqual({})
    await harness.dispose()
  })

  it('stays silent about the context when the session has no window', async () => {
    const harness = await boot()
    harness.facts.set({ contextWindow: undefined, contextTokens: 900_000 })
    expect(harness.notices()).toEqual({})
    await harness.dispose()
  })

  it('reports a resumed session once per switch, with its turns and its age', async () => {
    const harness = await boot()
    harness.facts.switchTo({ id: 'agent-2', status: 'idle' }, { turn: 3, active: false, endedAt: NOW - 5 * 60_000 })
    expect(harness.notices()).toEqual({ 'notice/resumed': 'Resumed session · 3 turns · last active 5m ago' })
    // A fact update within the same session does not raise it again.
    harness.facts.set({ turn: 3 })
    expect(Object.values(harness.notices())).toHaveLength(1)
    // A session with one turn says so; a session that is running raises nothing.
    harness.facts.switchTo({ id: 'agent-3', status: 'running' }, { turn: 1, active: true })
    expect(harness.notices()).toEqual({})
    await harness.dispose()
  })

  it('clears the resumed notice when the Agent changes to one with no history', async () => {
    const harness = await boot()
    harness.facts.switchTo({ id: 'agent-2', status: 'idle' }, { turn: 2, active: false })
    expect(Object.keys(harness.notices())).toEqual(['notice/resumed'])
    harness.facts.switchTo({ id: 'agent-4', status: 'idle' }, { turn: 0, active: false })
    expect(harness.notices()).toEqual({})
    await harness.dispose()
  })

  it('retires its records when its Fiber unloads, and stops the countdown with them', async () => {
    const harness = await boot()
    harness.facts.set({ retrying: retry(429), contextWindow: 64_000, contextTokens: 60_000 })
    expect(Object.keys(harness.notices()).sort()).toEqual(['notice/context', 'notice/retry'])
    await harness.dispose()
    expect(harness.lane.notificationSnapshot()).toEqual([])
    expect(harness.tick.listeners.size).toBe(0)
  })
})
