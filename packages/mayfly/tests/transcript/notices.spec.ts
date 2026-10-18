/**
 * Decision tests of the notices the session's facts raise into the notification lane: a rate limit by status 429 and
 * any other provider error (their texts, the countdown re-reported on the host's tick, the record cleared with the
 * fact), the context notice from 92% occupancy and its silence without a window, the resumed-session notice once per
 * Agent switch and never while the session is active, and the Fiber that owns the records retiring them on unload.
 * Time comes from an injected clock and a hand-driven tick; nothing sleeps.
 * @module transcript-notices
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ContextPressureProjection } from '@deepseek-ai/dsh-token-meter'
import type { GoalProjection } from '@deepseek-ai/dsh-goal'
import { initialConversationFacts } from '../../src/conversation/facts.ts'
import type { ConversationFacts } from '../../src/conversation/types.ts'
import { UiInteractionService } from '../../src/core/ui-interaction-state.ts'
import { UiNotificationStore } from '../../src/core/ui-interaction-notifications.ts'
import { CONTEXT_WARN_PERCENT, mountNotices } from '../../src/transcript/notices.ts'
import type { TickSource } from '../../src/transcript/tick.ts'
import { transcriptTranslatorFake } from './notices-fakes.ts'

const NOW = 1_700_000_000_000

/** The native `contextPressure` projection face. */
class HandPressures {
  private readonly values = new Map<object, ContextPressureProjection>()
  private readonly listeners = new Set<(session: unknown, key: string, value: unknown, seq: number) => void>()

  set(session: object, value: ContextPressureProjection): void {
    this.values.set(session, value)
    for (const listener of this.listeners) listener(session, 'contextPressure', value, 0)
  }

  snapshot(session: object): { readonly asOfSeq: number, readonly values: Record<string, unknown> } {
    return { asOfSeq: 0, values: { contextPressure: this.values.get(session) } }
  }

  onChanged(listener: (session: unknown, key: string, value: unknown, seq: number) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

/** The Agent identity the notices read, with its exact Session object for native projection reads. */
interface HandAgent {
  readonly id: string
  readonly status: string
  readonly session: object
}

/** A facts source the test drives: the value, its listeners, and the Agent switch listeners. */
class HandFacts {
  current: ConversationFacts = initialConversationFacts()
  currentAgent: HandAgent | undefined = { id: 'agent-1', status: 'idle', session: {} }
  currentGoal: GoalProjection | null = null
  private readonly goalListeners = new Set<(goal: GoalProjection | null) => void>()
  private readonly listeners = new Set<(facts: ConversationFacts) => void>()
  private readonly agentListeners = new Set<(agent: unknown) => void>()

  set(next: Partial<ConversationFacts>): void {
    this.current = { ...this.current, ...next }
    for (const listener of this.listeners) listener(this.current)
  }

  switchTo(agent: { readonly id: string, readonly status: string }, facts: Partial<ConversationFacts>): void {
    this.currentAgent = { ...agent, session: {} }
    this.current = { ...initialConversationFacts(), ...facts }
    for (const listener of this.agentListeners) listener(agent)
    for (const listener of this.listeners) listener(this.current)
  }

  subscribe(listener: (facts: ConversationFacts) => void): () => void {
    this.listeners.add(listener)
    listener(this.current)
    return () => { this.listeners.delete(listener) }
  }

  setGoal(goal: GoalProjection | null): void {
    this.currentGoal = goal
    for (const listener of this.goalListeners) listener(goal)
  }

  subscribeGoal(listener: (goal: GoalProjection | null) => void): () => void {
    this.goalListeners.add(listener)
    return () => { this.goalListeners.delete(listener) }
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
  /** Publish the current Agent's native context pressure. */
  setPressure(value: ContextPressureProjection): void
  /** The texts of the notices the lane holds, by their producer id. */
  notices(): Record<string, string>
  /** The tails the lane records carry (the end of the message that a narrow row keeps whole), by producer id. */
  tails(): Record<string, string | undefined>
  dispose(): Promise<void>
}

/** Mount the notices under a plugin Fiber, with the lane, facts and tick they read. */
async function boot(facts = new HandFacts(), provided: { readonly facts?: boolean, readonly tick?: boolean } = {}): Promise<Harness> {
  const ctx = new Context()
  const lane = new UiInteractionService(ctx)
  const tick = new HandTick()
  const clock = { now: NOW }
  const pressures = new HandPressures()
  if (provided.facts !== false) ctx.reflect.provide('mayflySessionFacts', facts)
  if (provided.tick !== false) ctx.reflect.provide('mayflyTick', tick)
  ctx.reflect.provide('sessionProjections', pressures)
  const fiber = await ctx.plugin({
    name: 'notices-under-test',
    apply(owner: Context) {
      mountNotices(owner, transcriptTranslatorFake, () => clock.now)
    },
  })
  return {
    ctx, facts, tick, lane, clock,
    setPressure: (value) => {
      const session = facts.currentAgent?.session
      if (session !== undefined) pressures.set(session, value)
    },
    notices: () => Object.fromEntries(lane.notificationSnapshot().map(record => [record.id.replace(/^mayfly\.notices\/\d+\//u, ''), record.message])),
    tails: () => Object.fromEntries(lane.notificationSnapshot().map(record => [record.id.replace(/^mayfly\.notices\/\d+\//u, ''), record.tail])),
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
    expect(harness.tails()).toEqual({ 'notice/retry': 'retrying in 5s · 1/5' })
    await harness.dispose()
  })

  it('says any other failure as a provider error, with the reason the Harness gave', async () => {
    const harness = await boot()
    harness.facts.set({ retrying: retry(503, { reason: 'overloaded' }) })
    expect(harness.notices()).toEqual({ 'notice/retry': 'Provider error · overloaded · retrying in 5s · 1/5' })
    // The wait is the tail: a narrow row cuts the front and keeps the countdown.
    expect(harness.tails()).toEqual({ 'notice/retry': 'retrying in 5s · 1/5' })
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
    expect(harness.tails()).toEqual({ 'notice/retry': 'retrying 1/5…' })
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

  it('does not raise the retry again from a tick already in flight when the retry fact cleared', async () => {
    const harness = await boot()
    harness.facts.set({ retrying: retry(429) })
    // The tick dispatches a copy of its listeners: an earlier one that clears the retry runs before the notices' own.
    const own = [...harness.tick.listeners]
    harness.tick.listeners.clear()
    harness.tick.listeners.add(() => { harness.facts.set({ retrying: undefined }) })
    for (const listener of own) harness.tick.listeners.add(listener)
    harness.tick.fire(NOW + 1_000)
    expect(harness.notices()).toEqual({})
    await harness.dispose()
  })

  it('says the attempt alone while the Harness retries without a limit', async () => {
    const harness = await boot()
    harness.facts.set({ retrying: retry(503, { maxRetries: Infinity, retry: 4, delayMs: 2_000 }) })
    expect(harness.notices()).toEqual({ 'notice/retry': 'Provider error · retrying in 2s · 4' })
    await harness.dispose()
  })

  it('reports a retry once and counts nothing down when the host has no tick', async () => {
    const harness = await boot(new HandFacts(), { tick: false })
    harness.facts.set({ retrying: retry(429) })
    expect(harness.notices()).toEqual({ 'notice/retry': 'Rate limited · retrying in 5s · 1/5' })
    expect(harness.tick.listeners.size).toBe(0)
    await harness.dispose()
  })

  it('raises nothing when the host has no session facts', async () => {
    const harness = await boot(new HandFacts(), { facts: false })
    expect(harness.notices()).toEqual({})
    expect(harness.tick.listeners.size).toBe(0)
    await harness.dispose()
  })

  it('warns from 92% context occupancy, says how full it is, and clears below the threshold', async () => {
    expect(CONTEXT_WARN_PERCENT).toBe(92)
    const harness = await boot()
    harness.setPressure({ pressureTokens: 50_000, contextWindow: 64_000 })
    expect(harness.notices()).toEqual({})
    harness.setPressure({ pressureTokens: 59_000, contextWindow: 64_000 })
    expect(harness.notices()).toEqual({ 'notice/context': 'Context 93% full · /compact now' })
    harness.setPressure({ pressureTokens: 40_000, contextWindow: 64_000 })
    expect(harness.notices()).toEqual({})
    await harness.dispose()
  })

  it('prefers projectedTokens for the occupancy', async () => {
    const harness = await boot()
    harness.setPressure({ pressureTokens: 60_000, projectedTokens: 59_000, contextWindow: 64_000 })
    expect(harness.notices()).toEqual({ 'notice/context': 'Context 93% full · /compact now' })
    await harness.dispose()
  })

  it('reports the context once per threshold crossing, not on every delta, and re-arms on an Agent switch', async () => {
    const report = vi.spyOn(UiNotificationStore.prototype, 'report')
    try {
      const harness = await boot()
      const contextReports = (): number => report.mock.calls.filter(call => String(call[0]).endsWith('/notice/context')).length
      // 92% is the first crossing.
      harness.setPressure({ pressureTokens: 58_880, contextWindow: 64_000 })
      expect(contextReports()).toBe(1)
      expect(harness.notices()).toEqual({ 'notice/context': 'Context 92% full · /compact now' })
      // A delta inside the same band says nothing more.
      harness.setPressure({ pressureTokens: 59_000, contextWindow: 64_000 })
      expect(contextReports()).toBe(1)
      // 95% is a new crossing, and so is 98%.
      harness.setPressure({ pressureTokens: 60_800, contextWindow: 64_000 })
      expect(contextReports()).toBe(2)
      expect(harness.notices()).toEqual({ 'notice/context': 'Context 95% full · /compact now' })
      harness.setPressure({ pressureTokens: 62_720, contextWindow: 64_000 })
      expect(contextReports()).toBe(3)
      expect(harness.notices()).toEqual({ 'notice/context': 'Context 98% full · /compact now' })
      // Dropping back into a reported band does not report again.
      harness.setPressure({ pressureTokens: 59_000, contextWindow: 64_000 })
      expect(contextReports()).toBe(3)
      harness.setPressure({ pressureTokens: 40_000, contextWindow: 64_000 })
      expect(harness.notices()).toEqual({})
      harness.setPressure({ pressureTokens: 58_880, contextWindow: 64_000 })
      expect(contextReports()).toBe(4)
      // Another Agent has no reported crossing yet: 92% reports again.
      harness.facts.switchTo({ id: 'agent-2', status: 'idle' }, {})
      harness.setPressure({ pressureTokens: 58_880, contextWindow: 64_000 })
      expect(contextReports()).toBe(5)
      expect(harness.notices()).toEqual({ 'notice/context': 'Context 92% full · /compact now' })
      await harness.dispose()
    } finally {
      report.mockRestore()
    }
  })

  it('stays silent about the context when the session has no window', async () => {
    const harness = await boot()
    harness.setPressure({ pressureTokens: 900_000 })
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

  it('says how long ago a resumed session was last active: just now under a minute, then in minutes, hours, and days', async () => {
    const harness = await boot()
    const resumedAfter = async (ms: number, turn: number): Promise<string | undefined> => {
      harness.facts.switchTo({ id: `agent-${String(ms)}`, status: 'idle' }, { turn, active: false, endedAt: NOW - ms })
      return harness.notices()['notice/resumed']
    }
    expect(await resumedAfter(30_000, 1)).toBe('Resumed session · 1 turn · last active just now')
    expect(await resumedAfter(3 * 3_600_000, 2)).toBe('Resumed session · 2 turns · last active 3h ago')
    expect(await resumedAfter(2 * 86_400_000, 2)).toBe('Resumed session · 2 turns · last active 2d ago')
    // A session that never recorded an end names no age.
    harness.facts.switchTo({ id: 'agent-new', status: 'idle' }, { turn: 2, active: false })
    expect(harness.notices()).toEqual({ 'notice/resumed': 'Resumed session · 2 turns' })
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
    harness.facts.set({ retrying: retry(429) })
    harness.setPressure({ pressureTokens: 60_000, contextWindow: 64_000 })
    expect(Object.keys(harness.notices()).sort()).toEqual(['notice/context', 'notice/retry'])
    await harness.dispose()
    expect(harness.lane.notificationSnapshot()).toEqual([])
    expect(harness.tick.listeners.size).toBe(0)
  })
  it('holds a notice while the goal is blocked, with its code and message, and clears it with the block', async () => {
    const harness = await boot()
    const goal = (phase: 'active' | 'blocked'): GoalProjection => ({
      goal: { id: 'goal-1', revision: 2, objective: 'ship it', phase, ...phase === 'blocked' ? { blockedReason: { code: 'tests-red', message: 'the suite fails' } } : {}, maxGoalRounds: 8 },
      roundsStarted: 1, createdAt: 1, updatedAt: 2,
    } as unknown as GoalProjection)
    harness.facts.setGoal(goal('blocked'))
    expect(harness.notices()).toEqual({ 'notice/goal': 'Goal blocked · tests-red: the suite fails' })
    expect(harness.lane.notificationSnapshot()[0]).toMatchObject({ severity: 'warning' })
    harness.facts.setGoal(goal('active'))
    expect(harness.notices()).toEqual({})
    harness.facts.setGoal(goal('blocked'))
    harness.facts.setGoal(null)
    expect(harness.notices()).toEqual({})
    await harness.dispose()
  })

  it('reports a goal that is already blocked when the Agent switches to its session', async () => {
    const harness = await boot()
    harness.facts.currentGoal = { goal: { id: 'g', revision: 1, objective: 'o', phase: 'blocked', blockedReason: { code: 'cap', message: 'round cap reached' }, maxGoalRounds: 8 }, roundsStarted: 8, createdAt: 1, updatedAt: 2 } as unknown as GoalProjection
    harness.facts.switchTo({ id: 'agent-2', status: 'idle' }, {})
    expect(harness.notices()).toMatchObject({ 'notice/goal': 'Goal blocked · cap: round cap reached' })
    await harness.dispose()
  })
})
