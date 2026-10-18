/** Native current-Agent and session-projection coverage for SessionFactsService.
 * @module @ephemeral-ai/mayfly/transcript/tests/session-facts
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GoalPhase, GoalProjection } from '@deepseek-ai/dsh-goal'
import type { Session } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initialConversationFacts } from '../../src/conversation/facts.ts'
import { CHILD_VOLATILE_MS, projectChildSessionFacts, SessionFactsService, type ChildSessionFacts } from '../../src/transcript/session-facts.ts'
import { LiveAssistantStreamService } from '../../src/conversation/live-stream.ts'

class ProjectionFake {
  private readonly values = new Map<Session, Record<string, unknown>>()
  private readonly listeners = new Set<(session: Session, key: string, value: unknown, seq: number) => void>()

  set(session: Session, values: Record<string, unknown>): void { this.values.set(session, values) }

  snapshot(session: Session, keys?: readonly string[]): { readonly asOfSeq: number, readonly values: Record<string, unknown> } {
    const source = this.values.get(session) ?? {}
    return {
      asOfSeq: 1,
      values: keys === undefined ? { ...source } : Object.fromEntries(keys.map(key => [key, source[key]])),
    }
  }

  onChanged(listener: (session: Session, key: string, value: unknown, seq: number) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  emit(session: Session, key: string, value: unknown, seq = 2): void {
    this.values.set(session, { ...this.values.get(session), [key]: value })
    for (const listener of this.listeners) listener(session, key, value, seq)
  }

  get listenerCount(): number { return this.listeners.size }
}

function session(id: string, header: Record<string, unknown> = {}): Session {
  return { id, header } as unknown as Session
}

function agent(value: Session): Agent {
  return { id: value.id, session: value } as unknown as Agent
}

function goalProjection(phase: GoalPhase, message?: string): GoalProjection {
  return {
    goal: {
      id: 'goal-1' as GoalProjection['goal']['id'],
      revision: 3,
      objective: 'ship the badge',
      phase,
      ...(message === undefined ? {} : { blockedReason: { code: 'tests-red', message } }),
      maxGoalRounds: 8,
    },
    roundsStarted: 2,
    createdAt: 1_000,
    updatedAt: 2_000,
  }
}

describe('SessionFactsService', () => {
  it('uses live phase boundaries and never revives an older or settled step', async () => {
    const ctx = new Context()
    const liveSession = session('live')
    const selected = agent(liveSession)
    const projections = new ProjectionFake()
    const baseline = { ...initialConversationFacts(), phase: 'thinking' as const, active: true, turn: 1, currentStep: 0 }
    projections.set(liveSession, { mayflyConversationFacts: baseline })
    ctx.reflect.provide('sessionProjections', projections)
    ctx.reflect.provide('sessions', { list: () => [] })
    ctx.reflect.provide('mayflyCurrentAgent', { subscribe(listener: (value: Agent) => void) { listener(selected); return () => {} } })
    const live = new LiveAssistantStreamService(ctx)
    const facts = new SessionFactsService(ctx, live)
    const phases: string[] = []
    facts.subscribe(value => phases.push(value.phase))
    live.accept(selected, { type: 'start', attemptId: 'active' as never, revision: 1, turn: 1, step: 0 })
    live.accept(selected, { type: 'chunk', attemptId: 'active' as never, revision: 2, index: 0, time: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'thought' } })
    await Promise.resolve()
    expect(facts.current).toMatchObject({ phase: 'thinking', flowDownChars: 7 })
    // The overlay names the phase for the activity row; the reasoning text itself is the stream's, not the row's.
    expect(facts.current.activity).toEqual({ kind: 'reasoning' })
    expect(phases.length).toBeGreaterThan(1)
    live.accept(selected, { type: 'chunk', attemptId: 'active' as never, revision: 3, index: 1, time: 2, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thought' } } })
    await Promise.resolve()
    expect(facts.current.phase).toBe('waiting')
    expect(facts.current.outputProgress).toBeUndefined()
    expect(facts.current.activity).toBeUndefined()
    live.accept(selected, { type: 'chunk', attemptId: 'active' as never, revision: 4, index: 2, time: 3, chunk: { type: 'text-delta', index: 1, text: 'answer' } })
    await Promise.resolve()
    expect(facts.current.phase).toBe('composing')
    expect(facts.current.activity).toEqual({ kind: 'text' })
    // A call whose arguments still stream names the newest preparing call.
    live.accept(selected, { type: 'chunk', attemptId: 'active' as never, revision: 5, index: 3, time: 4, chunk: { type: 'tool-call-delta', index: 2, id: 'c1' as never, name: 'write', argumentsDelta: '{"file_path"' } })
    await Promise.resolve()
    expect(facts.current).toMatchObject({ phase: 'waiting', activity: { kind: 'tool', name: 'write', preparing: true } })
    projections.emit(liveSession, 'mayflyConversationFacts', { ...baseline, phase: 'waiting', lastCompletedStep: 0 })
    expect(facts.current.phase).toBe('waiting')
    projections.emit(liveSession, 'mayflyConversationFacts', { ...baseline, phase: 'tool', currentStep: 1 })
    expect(facts.current.phase).toBe('tool')
    projections.emit(liveSession, 'mayflyConversationFacts', { ...baseline, phase: 'idle', active: false, runOutcome: 'completed' })
    expect(facts.current.active).toBe(false)
    projections.emit(liveSession, 'mayflyConversationFacts', { ...baseline, turn: 2, phase: 'waiting' })
    expect(facts.current.turn).toBe(2)
    expect(projectChildSessionFacts('live', { ...baseline, endedAt: 99 }).endedAt).toBe(99)
    facts.dispose()
    live.dispose()
    await ctx.fiber.dispose()
  })

  it('replays and follows native projections for the exact Agent and its direct children', () => {
    const ctx = new Context()
    const parentSession = session('parent')
    const childSession = session('child', { origin: 'subagent', parentSession: 'parent' })
    const invalidChild = session('invalid-child', { origin: 'subagent', parentSession: 'parent' })
    const unrelated = session('other-child', { origin: 'subagent', parentSession: 'other' })
    const current = agent(parentSession)
    const projections = new ProjectionFake()
    const parentFacts = { ...initialConversationFacts(), promptText: 'first prompt' }
    const activeGoal = goalProjection('active')
    const blockedGoal = goalProjection('blocked', 'tests are red')
    const childFacts = { ...initialConversationFacts(), promptText: 'delegate', active: true, phase: 'tool' as const }
    projections.set(parentSession, { mayflyConversationFacts: parentFacts, title: 'first', goal: activeGoal })
    projections.set(childSession, { mayflyConversationFacts: childFacts })
    projections.set(invalidChild, { mayflyConversationFacts: { phase: 'invalid' } })
    let selected: Agent | null = current
    const agentListeners = new Set<(value: Agent | null, revision: number) => void>()
    ctx.reflect.provide('sessionProjections', projections)
    ctx.reflect.provide('sessions', { list: () => [parentSession, childSession, invalidChild, unrelated] })
    ctx.reflect.provide('mayflyCurrentAgent', {
      current: () => selected,
      revision: () => 0,
      subscribe(listener: (value: Agent | null, revision: number) => void) {
        agentListeners.add(listener)
        listener(selected, 0)
        return () => { agentListeners.delete(listener) }
      },
    })

    const service = new SessionFactsService(ctx)
    const prompts: Array<string | undefined> = []
    const titles: Array<string | undefined> = []
    const goals: Array<GoalProjection | null> = []
    const agents: Array<Agent | null> = []
    const children: string[][] = []
    const offFacts = service.subscribe(facts => prompts.push(facts.promptText))
    const offTitle = service.subscribeTitle(title => titles.push(title))
    const offGoal = service.subscribeGoal(goal => goals.push(goal))
    const offAgent = service.subscribeAgent(value => agents.push(value))
    const offChildren = service.subscribeChildren(value => children.push(value.map(row => row.id)))

    expect(service.current).toEqual(parentFacts)
    expect(service.currentTitle).toBe('first')
    expect(service.currentGoal).toEqual(activeGoal)
    expect(service.currentAgent).toBe(current)
    expect(children.at(-1)).toEqual(['child'])
    for (const listener of agentListeners) listener(current, 0)

    projections.emit(unrelated, 'mayflyConversationFacts', { ...parentFacts, promptText: 'ignored' })
    projections.emit(parentSession, 'other', parentFacts)
    projections.emit(parentSession, 'mayflyConversationFacts', { phase: 'bad' })
    const nextFacts = { ...parentFacts, promptText: 'next' }
    projections.emit(parentSession, 'mayflyConversationFacts', nextFacts)
    projections.emit(parentSession, 'mayflyConversationFacts', nextFacts)
    projections.emit(parentSession, 'title', 'second')
    projections.emit(parentSession, 'title', null)
    projections.emit(parentSession, 'goal', { phase: 'bad' })
    projections.emit(parentSession, 'goal', blockedGoal)
    projections.emit(parentSession, 'goal', blockedGoal)
    projections.emit(parentSession, 'goal', null)
    projections.emit(childSession, 'mayflyConversationFacts', { ...childFacts, promptText: 'child prompt' })
    expect(prompts).toEqual(['first prompt', 'next'])
    expect(titles).toEqual(['first', 'second', undefined])
    expect(goals).toEqual([activeGoal, blockedGoal, null])
    expect(children.at(-1)).toEqual(['child'])

    const untitledSession = session('untitled')
    const untitled = agent(untitledSession)
    projections.set(untitledSession, { mayflyConversationFacts: parentFacts, title: null })
    selected = untitled
    for (const listener of agentListeners) listener(untitled, 1)
    expect(service.currentTitle).toBeUndefined()
    expect(service.currentGoal).toBeNull()

    selected = null
    for (const listener of agentListeners) listener(null, 1)
    expect(service.current).toEqual(initialConversationFacts())
    expect(service.currentTitle).toBeUndefined()
    expect(service.currentGoal).toBeNull()
    expect(service.currentAgent).toBeNull()
    expect(agents).toEqual([current, current, untitled, null])
    expect(children.at(-1)).toEqual([])

    offTitle()
    offGoal()
    offFacts()
    offAgent()
    offChildren()
    service.dispose()
    expect(projections.listenerCount).toBe(0)
    expect(agentListeners.size).toBe(0)
  })

  it('rejects malformed goal projection values shape by shape', () => {
    const ctx = new Context()
    const parentSession = session('parent')
    const current = agent(parentSession)
    const projections = new ProjectionFake()
    projections.set(parentSession, {})
    ctx.reflect.provide('sessionProjections', projections)
    ctx.reflect.provide('sessions', { list: () => [] })
    ctx.reflect.provide('mayflyCurrentAgent', {
      current: () => current,
      revision: () => 0,
      subscribe(listener: (value: Agent | null, revision: number) => void) {
        listener(current, 0)
        return () => {}
      },
    })
    const service = new SessionFactsService(ctx)
    const goals: Array<GoalProjection | null> = []
    service.subscribeGoal(goal => goals.push(goal))
    const valid = goalProjection('active')
    const malformed: unknown[] = [
      42,
      { ...valid, roundsStarted: '2' },
      { ...valid, createdAt: '1000' },
      { ...valid, updatedAt: undefined },
      { ...valid, goal: null },
      { ...valid, goal: 'goal' },
      { ...valid, goal: { ...valid.goal, id: 7 } },
      { ...valid, goal: { ...valid.goal, revision: '3' } },
      { ...valid, goal: { ...valid.goal, objective: 9 } },
      { ...valid, goal: { ...valid.goal, phase: 'exploding' } },
      { ...valid, goal: { ...valid.goal, maxGoalRounds: '8' } },
      { ...valid, goal: { ...valid.goal, blockedReason: null } },
      { ...valid, goal: { ...valid.goal, blockedReason: 'red' } },
      { ...valid, goal: { ...valid.goal, blockedReason: { message: 'red' } } },
      { ...valid, goal: { ...valid.goal, blockedReason: { code: 'tests-red' } } },
    ]
    malformed.forEach((value, index) => projections.emit(parentSession, 'goal', value, index + 2))
    expect(goals).toEqual([null])
    projections.emit(parentSession, 'goal', valid, 30)
    expect(goals).toEqual([null, valid])
    service.dispose()
  })

  it('projects every child activity and optional metadata shape', () => {
    const base = initialConversationFacts()
    const selection = {
      lastUsed: { provider: 'p', model: 'chosen', reasoningEffort: 'high' },
      next: { provider: 'p', model: 'pending' },
    }
    expect(projectChildSessionFacts('tool', {
      ...base, active: true, phase: 'tool', activity: { kind: 'tool' },
    }, undefined, selection)).toMatchObject({ id: 'tool', phase: 'running', activity: 'Using tool', model: 'chosen', effort: 'high' })
    expect(projectChildSessionFacts('pending', {
      ...base, active: true, phase: 'waiting',
    }, undefined, { lastUsed: null, next: { provider: 'p', model: 'pending', reasoningEffort: 'low' } })).toMatchObject({ model: 'pending', effort: 'low' })
    expect(projectChildSessionFacts('reasoning', {
      ...base, active: true, phase: 'thinking', activity: { kind: 'reasoning' },
    })).toMatchObject({ phase: 'running', activity: 'Thinking…' })
    expect(projectChildSessionFacts('text', {
      ...base, active: true, phase: 'composing', activity: { kind: 'text' },
    })).toMatchObject({ phase: 'running', activity: 'Writing…' })
    expect(projectChildSessionFacts('starting', {
      ...base, active: true, phase: 'waiting',
    })).toMatchObject({ phase: 'waiting', activity: 'Starting…' })
    // A child whose first turn has not begun has no outcome yet: it is about to work, not finished.
    expect(projectChildSessionFacts('fresh', base)).toEqual({
      id: 'fresh', phase: 'waiting', tokens: 0, inputTokens: 0, outputTokens: 0, toolCount: 0,
    })
    expect(projectChildSessionFacts('done', { ...base, runOutcome: 'completed' as const, endedAt: 9 })).toEqual({
      id: 'done', phase: 'completed', tokens: 0, inputTokens: 0, outputTokens: 0, toolCount: 0, endedAt: 9,
    })
  })

  it('splits a child run tokens into input and output, and tells a stopped run from one that failed', () => {
    const base = { ...initialConversationFacts(), runOutcome: 'failed' as const, endedAt: 7, epochTokens: 5_000, epochOutputTokens: 1_200, epochToolCount: 3 }
    expect(projectChildSessionFacts('failed', base)).toMatchObject({ phase: 'failed', tokens: 5_000, inputTokens: 3_800, outputTokens: 1_200, toolCount: 3 })
    expect(projectChildSessionFacts('failed', base)).not.toHaveProperty('stopped')
    expect(projectChildSessionFacts('stopped', { ...base, runStopped: true })).toMatchObject({ phase: 'failed', stopped: true })
    // The output never exceeds the total: a child that reports more output than total reads zero input.
    expect(projectChildSessionFacts('odd', { ...base, epochTokens: 100, epochOutputTokens: 400 })).toMatchObject({ inputTokens: 0, outputTokens: 400 })
  })

  it('carries the live attempt output progress, for the rate the Agents row shows', () => {
    const base = { ...initialConversationFacts(), active: true, phase: 'waiting' as const, turn: 2, currentStep: 1 }
    const outputProgress = { chars: 400, at: 9 } as never
    const draft = { sessionId: 'child', attemptId: 'a', revision: 4, turn: 2, step: 1, phase: 'composing' as const, reasoning: '', text: 'x', outputProgress, chars: 400, updatedAt: 5 }
    expect(projectChildSessionFacts('child', base, draft)).toMatchObject({ phase: 'running', liveChars: 400, outputProgress })
    expect(projectChildSessionFacts('child', base, { ...draft, outputProgress: undefined })).not.toHaveProperty('outputProgress')
  })

  it('overlays a fresh child draft and rejects stale or foreign drafts', () => {
    const base = { ...initialConversationFacts(), active: true, phase: 'waiting' as const, turn: 2, currentStep: 1 }
    const draft = { sessionId: 'child', attemptId: 'a', revision: 4, turn: 2, step: 1, phase: 'thinking' as const, reasoning: 'r', text: '', outputProgress: undefined, chars: 9, updatedAt: 5 }
    expect(projectChildSessionFacts('child', base, draft)).toMatchObject({ phase: 'running', activity: 'Thinking…', liveChars: 9 })
    expect(projectChildSessionFacts('child', base, { ...draft, phase: 'composing' })).toMatchObject({ phase: 'running', activity: 'Writing…', liveChars: 9 })
    expect(projectChildSessionFacts('child', base, { ...draft, phase: 'waiting' })).toMatchObject({ phase: 'waiting', liveChars: 9 })
    expect(projectChildSessionFacts('child', base, { ...draft, chars: 0 })).not.toHaveProperty('liveChars')
    const foreign = projectChildSessionFacts('child', base, { ...draft, sessionId: 'other' })
    expect(foreign).toMatchObject({ phase: 'waiting' })
    expect(foreign).not.toHaveProperty('liveChars')
    const stale = projectChildSessionFacts('child', base, { ...draft, turn: 1 })
    expect(stale).toMatchObject({ phase: 'waiting' })
    expect(stale).not.toHaveProperty('liveChars')
    expect(projectChildSessionFacts('child', { ...base, active: false, runOutcome: 'completed' as const }, draft)).toMatchObject({ phase: 'completed' })
    expect(projectChildSessionFacts('child', { ...base, currentStep: 2 }, draft)).toMatchObject({ phase: 'waiting' })
    expect(projectChildSessionFacts('child', { ...base, lastCompletedStep: 1 }, draft)).toMatchObject({ phase: 'waiting' })
  })

  it('republishes children when a resident child draft changes phase', async () => {
    const ctx = new Context()
    const parentSession = session('parent')
    const childSession = session('child', { origin: 'subagent', parentSession: 'parent' })
    const current = agent(parentSession)
    const childAgent = agent(childSession)
    const projections = new ProjectionFake()
    projections.set(parentSession, { mayflyConversationFacts: initialConversationFacts() })
    projections.set(childSession, {
      mayflyConversationFacts: { ...initialConversationFacts(), promptText: 'delegate', active: true, phase: 'waiting' as const, turn: 1, currentStep: 0 },
    })
    ctx.reflect.provide('sessionProjections', projections)
    ctx.reflect.provide('sessions', { list: () => [parentSession, childSession] })
    ctx.reflect.provide('agents', { get: (id: unknown) => String(id) === 'child' ? childAgent : undefined })
    ctx.reflect.provide('mayflyCurrentAgent', { subscribe(listener: (value: Agent) => void) { listener(current); return () => {} } })
    const live = new LiveAssistantStreamService(ctx)
    const service = new SessionFactsService(ctx, live)
    const children: Array<readonly ChildSessionFacts[]> = []
    service.subscribeChildren(value => children.push(value))
    expect(children.at(-1)).toEqual([{ id: 'child', activity: 'Starting…', phase: 'waiting', tokens: 0, inputTokens: 0, outputTokens: 0, toolCount: 0, promptText: 'delegate' }])
    live.accept(childAgent, { type: 'start', attemptId: 'run' as never, revision: 1, turn: 1, step: 0 })
    live.accept(childAgent, { type: 'chunk', attemptId: 'run' as never, revision: 2, index: 0, time: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'thinking' } })
    await Promise.resolve()
    expect(children.at(-1)?.[0]).toMatchObject({ phase: 'running', activity: 'Thinking…', liveChars: 8 })
    const published = children.length
    live.accept(current, { type: 'start', attemptId: 'parent-run' as never, revision: 1, turn: 1, step: 0 })
    await Promise.resolve()
    expect(children).toHaveLength(published)
    expect(children.at(-1)?.[0]).toMatchObject({ phase: 'running', activity: 'Thinking…' })
    live.accept(childAgent, { type: 'chunk', attemptId: 'run' as never, revision: 3, index: 1, time: 2, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking' } } })
    live.accept(childAgent, { type: 'chunk', attemptId: 'run' as never, revision: 4, index: 2, time: 3, chunk: { type: 'text-delta', index: 1, text: 'draft' } })
    await Promise.resolve()
    expect(children.at(-1)?.[0]).toMatchObject({ phase: 'running', activity: 'Writing…', liveChars: 13 })
    service.dispose()
    live.dispose()
    await ctx.fiber.dispose()
  })

  describe('child stream coalescing', () => {
    afterEach(() => { vi.useRealTimers() })

    function childFixture() {
      const ctx = new Context()
      const parentSession = session('parent')
      const childSession = session('child', { origin: 'subagent', parentSession: 'parent' })
      const current = agent(parentSession)
      const childAgent = agent(childSession)
      const projections = new ProjectionFake()
      projections.set(parentSession, { mayflyConversationFacts: initialConversationFacts() })
      projections.set(childSession, {
        mayflyConversationFacts: { ...initialConversationFacts(), active: true, phase: 'waiting' as const, turn: 1, currentStep: 0 },
      })
      let listener: ((value: Agent | null) => void) | undefined
      ctx.reflect.provide('sessionProjections', projections)
      ctx.reflect.provide('sessions', { list: () => [parentSession, childSession] })
      const agentGet = vi.fn((id: unknown) => String(id) === 'child' ? childAgent : undefined)
      ctx.reflect.provide('agents', { get: agentGet })
      ctx.reflect.provide('mayflyCurrentAgent', { subscribe(next: (value: Agent | null) => void) { listener = next; next(current); return () => {} } })
      const live = new LiveAssistantStreamService(ctx)
      const service = new SessionFactsService(ctx, live)
      const published: Array<readonly ChildSessionFacts[]> = []
      service.subscribeChildren(value => published.push(value))
      let revision = 0
      const chunk = (text: string, kind: 'text-delta' | 'reasoning-delta' = 'text-delta'): void => {
        revision += 1
        live.accept(childAgent, { type: 'chunk', attemptId: 'run' as never, revision: revision + 1, index: revision - 1, time: revision, chunk: { type: kind, index: 0, text } })
      }
      live.accept(childAgent, { type: 'start', attemptId: 'run' as never, revision: 1, turn: 1, step: 0 })
      return { ctx, live, service, published, chunk, projections, childSession, childAgent, agentGet, switchAgent: (value: Agent | null) => listener?.(value) }
    }

    it('skips a child update whose projection is unchanged', async () => {
      vi.useFakeTimers()
      const { ctx, live, service, published, projections, childSession } = childFixture()
      const count = published.length
      const list = published.at(-1)
      const facts = projections.snapshot(childSession).values.mayflyConversationFacts as Record<string, unknown>
      // A field the child projection does not carry changed; every carried value is equal.
      projections.emit(childSession, 'mayflyConversationFacts', { ...facts, flowDownChars: Number(facts.flowDownChars) + 100 })
      expect(published).toHaveLength(count)
      service.subscribeChildren(value => { expect(value).toBe(list) })
      service.dispose()
      live.dispose()
      await ctx.fiber.dispose()
    })

    it('publishes a tool-call delta immediately, not on the volatile cadence', async () => {
      vi.useFakeTimers()
      const { ctx, live, service, published, projections, childSession } = childFixture()
      const count = published.length
      const facts = projections.snapshot(childSession).values.mayflyConversationFacts as Record<string, unknown>
      projections.emit(childSession, 'mayflyConversationFacts', { ...facts, epochToolCount: 1 })
      expect(published).toHaveLength(count + 1)
      expect(published.at(-1)?.[0]).toMatchObject({ toolCount: 1 })
      vi.advanceTimersByTime(CHILD_VOLATILE_MS)
      expect(published).toHaveLength(count + 1)
      service.dispose()
      live.dispose()
      await ctx.fiber.dispose()
    })

    it('defers streamed-character-only changes to one trailing publish', async () => {
      vi.useFakeTimers()
      const { ctx, live, service, published, chunk } = childFixture()
      chunk('draft')
      await Promise.resolve()
      expect(published.at(-1)?.[0]).toMatchObject({ activity: 'Writing…', liveChars: 5 })
      const count = published.length
      chunk(' more')
      await Promise.resolve()
      chunk(' text')
      await Promise.resolve()
      expect(published).toHaveLength(count)
      vi.advanceTimersByTime(CHILD_VOLATILE_MS)
      expect(published).toHaveLength(count + 1)
      expect(published.at(-1)?.[0]).toMatchObject({ liveChars: 15 })
      // The published list is reused until a child changes.
      const list = published.at(-1)
      service.subscribeChildren(value => { expect(value).toBe(list) })
      service.dispose()
      live.dispose()
      await ctx.fiber.dispose()
    })

    it('flushes pending volatile state with the next structural change', async () => {
      vi.useFakeTimers()
      const { ctx, live, service, published, chunk } = childFixture()
      chunk('draft')
      await Promise.resolve()
      chunk(' more')
      await Promise.resolve()
      const count = published.length
      chunk('reason', 'reasoning-delta')
      await Promise.resolve()
      expect(published).toHaveLength(count + 1)
      expect(published.at(-1)?.[0]).toMatchObject({ activity: 'Thinking…' })
      vi.advanceTimersByTime(CHILD_VOLATILE_MS)
      expect(published).toHaveLength(count + 1)
      service.dispose()
      live.dispose()
      await ctx.fiber.dispose()
    })

    it('keeps the child Agent instead of asking the registry on every live notification', async () => {
      const { ctx, live, service, childAgent, agentGet } = childFixture()
      agentGet.mockClear()
      live.accept(childAgent, { type: 'chunk', attemptId: 'run' as never, revision: 9, index: 8, time: 9, chunk: { type: 'text-delta', index: 0, text: 'more' } })
      await Promise.resolve()
      expect(agentGet).not.toHaveBeenCalled()
      service.dispose()
      live.dispose()
      await ctx.fiber.dispose()
    })

    it('follows a replaced child Agent and forgets one that is disposed', async () => {
      vi.useFakeTimers()
      const { ctx, live, service, published, childSession, childAgent } = childFixture()
      const replacement = agent(childSession)
      ctx.emit('agent/created', { agent: replacement } as never)
      live.accept(replacement, { type: 'start', attemptId: 'replaced' as never, revision: 1, turn: 1, step: 0 })
      live.accept(replacement, { type: 'chunk', attemptId: 'replaced' as never, revision: 2, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'replaced' } })
      await Promise.resolve()
      expect(published.at(-1)?.[0]).toMatchObject({ liveChars: 8 })
      // The old Agent's disposal does not clear the replacement.
      ctx.emit('agent/disposed', { agent: childAgent } as never)
      live.accept(replacement, { type: 'chunk', attemptId: 'replaced' as never, revision: 3, index: 1, time: 2, chunk: { type: 'text-delta', index: 0, text: '!' } })
      await Promise.resolve()
      vi.advanceTimersByTime(CHILD_VOLATILE_MS)
      expect(published.at(-1)?.[0]).toMatchObject({ liveChars: 9 })
      // Once the stored Agent is gone, its stream no longer projects.
      ctx.emit('agent/disposed', { agent: replacement } as never)
      live.accept(replacement, { type: 'chunk', attemptId: 'replaced' as never, revision: 4, index: 2, time: 3, chunk: { type: 'text-delta', index: 0, text: '?' } })
      await Promise.resolve()
      vi.advanceTimersByTime(CHILD_VOLATILE_MS)
      expect(published.at(-1)?.[0]).not.toHaveProperty('liveChars')
      service.dispose()
      live.dispose()
      await ctx.fiber.dispose()
    })

    it('drops a pending volatile publish on agent switch and dispose', async () => {
      vi.useFakeTimers()
      const { ctx, live, service, published, chunk, switchAgent } = childFixture()
      chunk('draft')
      await Promise.resolve()
      chunk(' more')
      await Promise.resolve()
      switchAgent(null)
      const afterSwitch = published.length
      expect(published.at(-1)).toEqual([])
      vi.advanceTimersByTime(CHILD_VOLATILE_MS)
      expect(published).toHaveLength(afterSwitch)
      service.dispose()
      vi.advanceTimersByTime(CHILD_VOLATILE_MS)
      expect(published).toHaveLength(afterSwitch)
      live.dispose()
      await ctx.fiber.dispose()
    })
  })

  it('keeps every live child and only the 32 most recently settled ones', async () => {
    const ctx = new Context()
    const parentSession = session('parent')
    const childSessions = Array.from({ length: 34 }, (_, index) => session(`child-${String(index)}`, { origin: 'subagent', parentSession: 'parent' }))
    const projections = new ProjectionFake()
    projections.set(parentSession, { mayflyConversationFacts: initialConversationFacts() })
    childSessions.forEach((child, index) => {
      const facts = index === 0
        ? { ...initialConversationFacts(), active: true, phase: 'waiting' as const, turn: 1, currentStep: 0, promptText: 'live' }
        : { ...initialConversationFacts(), active: false, runOutcome: 'completed' as const, endedAt: index, promptText: `settled ${String(index)}` }
      projections.set(child, { mayflyConversationFacts: facts })
    })
    const current = agent(parentSession)
    ctx.reflect.provide('sessionProjections', projections)
    ctx.reflect.provide('sessions', { list: () => [parentSession, ...childSessions] })
    ctx.reflect.provide('mayflyCurrentAgent', { subscribe(listener: (value: Agent) => void) { listener(current); return () => {} } })
    const service = new SessionFactsService(ctx)
    const lists: Array<readonly ChildSessionFacts[]> = []
    service.subscribeChildren(value => lists.push(value))
    const ids = lists.at(-1)!.map(child => child.id)
    // The live child stays however old; the oldest settled child (child-1) is the one dropped.
    expect(ids).toContain('child-0')
    expect(ids).not.toContain('child-1')
    expect(ids).toHaveLength(33)
    service.dispose()
    await ctx.fiber.dispose()
  })
})

describe('SessionFactsService child selection and live in-flight calls', () => {
  function childSetup() {
    const ctx = new Context()
    const parentSession = session('parent')
    const childSession = session('child', { origin: 'subagent', parentSession: 'parent' })
    const current = agent(parentSession)
    const projections = new ProjectionFake()
    projections.set(parentSession, { mayflyConversationFacts: initialConversationFacts() })
    projections.set(childSession, { mayflyConversationFacts: { ...initialConversationFacts(), promptText: 'delegate' } })
    ctx.reflect.provide('sessionProjections', projections)
    ctx.reflect.provide('sessions', { list: () => [parentSession, childSession] })
    ctx.reflect.provide('mayflyCurrentAgent', { subscribe(listener: (value: Agent) => void) { listener(current); return () => {} } })
    return { ctx, parentSession, childSession, current, projections }
  }

  it('projects a child\'s native model selection, reuses an equal projection, and ignores malformed values', () => {
    const { ctx, parentSession, childSession, projections } = childSetup()
    const service = new SessionFactsService(ctx)
    const lists: Array<readonly ChildSessionFacts[]> = []
    service.subscribeChildren(value => lists.push(value))
    const initial = lists.at(-1)![0]!
    expect(initial).not.toHaveProperty('model')

    const used = { provider: 'p', model: 'chosen', reasoningEffort: 'high' }
    projections.emit(childSession, 'modelSelection', { lastUsed: used, next: null })
    expect(lists.at(-1)?.[0]).toMatchObject({ model: 'chosen', effort: 'high' })
    // The same projected selection does not replace the list identity.
    const same = lists.at(-1)
    projections.emit(childSession, 'modelSelection', { lastUsed: { ...used }, next: { provider: 'p', model: 'other' } })
    expect(lists.at(-1)).toBe(same)
    // A changed used selection is a structural change; a missing lastUsed falls to next.
    projections.emit(childSession, 'modelSelection', { lastUsed: null, next: { provider: 'q', model: 'fallback' } })
    expect(lists.at(-1)?.[0]).toMatchObject({ model: 'fallback' })
    expect(lists.at(-1)?.[0]).not.toHaveProperty('effort')
    // Malformed native values are not a selection projection: nothing republishes.
    const count = lists.length
    const malformed: unknown[] = [
      42,
      'model',
      { lastUsed: 7, next: null },
      { lastUsed: null, next: { provider: 1, model: 'x' } },
      { lastUsed: { provider: 'p' }, next: null },
      { lastUsed: null, next: { provider: 'p', model: 'm', reasoningEffort: 3 } },
      { lastUsed: { provider: 'p', model: 'm', reasoningEffort: null }, next: null },
    ]
    malformed.forEach((value, index) => projections.emit(childSession, 'modelSelection', value, index + 3))
    expect(lists).toHaveLength(count)
    // A selection projection for a session the parent did not admit is ignored wholesale.
    projections.emit(parentSession, 'modelSelection', { lastUsed: used, next: null })
    expect(lists).toHaveLength(count)
    service.dispose()
  })

  it('ignores Agents that come or go for a session that is not an admitted child', async () => {
    const { ctx, childSession } = childSetup()
    const service = new SessionFactsService(ctx)
    const lists: Array<readonly ChildSessionFacts[]> = []
    service.subscribeChildren(value => lists.push(value))
    const stranger = agent(session('stranger', { origin: 'subagent', parentSession: 'elsewhere' }))
    const before = lists.length
    ctx.emit('agent/created', { agent: stranger } as never)
    ctx.emit('agent/disposed', { agent: stranger } as never)
    ctx.emit('agent/disposed', { agent: agent(childSession) } as never)
    expect(lists).toHaveLength(before)
    service.dispose()
    await ctx.fiber.dispose()
  })

  it('merges the live draft\'s preparing calls around committed and spawn calls', async () => {
    const { ctx, parentSession, projections, current: selected } = childSetup()
    const committed = { callId: 'committed', name: 'bash', detail: 'pnpm test' }
    projections.set(parentSession, {
      mayflyConversationFacts: {
        ...initialConversationFacts(), active: true, phase: 'tool' as const, turn: 1, currentStep: 1, inFlight: [committed],
      },
    })
    const live = new LiveAssistantStreamService(ctx)
    const service = new SessionFactsService(ctx, live)
    live.accept(selected, { type: 'start', attemptId: 'run' as never, revision: 1, turn: 1, step: 1 })
    live.accept(selected, { type: 'chunk', attemptId: 'run' as never, revision: 2, index: 0, time: 1, chunk: { type: 'tool-call-delta', index: 0, id: 'committed' as never, name: 'bash', argumentsDelta: '{"command"' } })
    live.accept(selected, { type: 'chunk', attemptId: 'run' as never, revision: 3, index: 1, time: 2, chunk: { type: 'tool-call-delta', index: 1, id: 'spawn-1' as never, name: 'subagent', argumentsDelta: '{"description"' } })
    live.accept(selected, { type: 'chunk', attemptId: 'run' as never, revision: 4, index: 2, time: 3, chunk: { type: 'tool-call-delta', index: 2, id: 'fresh' as never, name: 'grep', argumentsDelta: '{"pattern"' } })
    await Promise.resolve()
    expect(service.current.inFlight).toEqual([committed, { callId: 'fresh', name: 'grep', preparing: true }])
    expect(service.current.activity).toEqual({ kind: 'tool', name: 'grep', preparing: true })
    service.dispose()
    live.dispose()
    await ctx.fiber.dispose()
  })

  it('keeps the durable in-flight list when no preparing call qualifies', async () => {
    const { ctx, parentSession, projections, current: selected } = childSetup()
    const committed = { callId: 'committed', name: 'bash' }
    projections.set(parentSession, {
      mayflyConversationFacts: { ...initialConversationFacts(), active: true, phase: 'tool' as const, turn: 1, currentStep: 1, inFlight: [committed] },
    })
    const live = new LiveAssistantStreamService(ctx)
    const service = new SessionFactsService(ctx, live)
    live.accept(selected, { type: 'start', attemptId: 'run' as never, revision: 1, turn: 1, step: 1 })
    live.accept(selected, { type: 'chunk', attemptId: 'run' as never, revision: 2, index: 0, time: 1, chunk: { type: 'tool-call-delta', index: 0, id: 'committed' as never, name: 'bash', argumentsDelta: '{' } })
    live.accept(selected, { type: 'chunk', attemptId: 'run' as never, revision: 3, index: 1, time: 2, chunk: { type: 'tool-call-delta', index: 1, id: 'spawn-1' as never, name: 'subagent', argumentsDelta: '{' } })
    await Promise.resolve()
    expect(service.current.inFlight).toEqual([committed])
    service.dispose()
    live.dispose()
    await ctx.fiber.dispose()
  })
})

describe('SessionFactsService late children and attach snapshots', () => {
  it('admits a direct child that first appears after the Agent attached, including its selection', () => {
    const ctx = new Context()
    const parentSession = session('parent')
    const lateSession = session('late', { origin: 'subagent', parentSession: 'parent' })
    const current = agent(parentSession)
    const projections = new ProjectionFake()
    projections.set(parentSession, { mayflyConversationFacts: initialConversationFacts() })
    ctx.reflect.provide('sessionProjections', projections)
    ctx.reflect.provide('sessions', { list: () => [parentSession] })
    ctx.reflect.provide('mayflyCurrentAgent', { subscribe(listener: (value: Agent) => void) { listener(current); return () => {} } })
    const service = new SessionFactsService(ctx)
    const lists: Array<readonly ChildSessionFacts[]> = []
    service.subscribeChildren(value => lists.push(value))
    // The child was not in the sessions list at attach: its first projection creates the record.
    projections.emit(lateSession, 'mayflyConversationFacts', { ...initialConversationFacts(), promptText: 'late' })
    expect(lists.at(-1)).toEqual([expect.objectContaining({ id: 'late', promptText: 'late' })])
    const selection = { lastUsed: { provider: 'p', model: 'late-model' }, next: null }
    projections.emit(lateSession, 'modelSelection', selection)
    expect(lists.at(-1)?.[0]).toMatchObject({ model: 'late-model' })
    // A selection projection for a child no record knows is ignored.
    projections.emit(session('stranger', { origin: 'subagent', parentSession: 'parent' }), 'modelSelection', selection)
    expect(lists.at(-1)?.[0]).toMatchObject({ model: 'late-model' })
    service.dispose()
  })

  it('projects a selection the child snapshot already carries when the Agent attaches', () => {
    const ctx = new Context()
    const parentSession = session('parent')
    const childSession = session('child', { origin: 'subagent', parentSession: 'parent' })
    const current = agent(parentSession)
    const projections = new ProjectionFake()
    projections.set(parentSession, { mayflyConversationFacts: initialConversationFacts() })
    projections.set(childSession, {
      mayflyConversationFacts: { ...initialConversationFacts(), promptText: 'delegate' },
      modelSelection: { lastUsed: null, next: { provider: 'p', model: 'from-snapshot' } },
    })
    ctx.reflect.provide('sessionProjections', projections)
    ctx.reflect.provide('sessions', { list: () => [parentSession, childSession] })
    ctx.reflect.provide('mayflyCurrentAgent', { subscribe(listener: (value: Agent) => void) { listener(current); return () => {} } })
    const service = new SessionFactsService(ctx)
    const lists: Array<readonly ChildSessionFacts[]> = []
    service.subscribeChildren(value => lists.push(value))
    expect(lists.at(-1)?.[0]).toMatchObject({ id: 'child', model: 'from-snapshot' })
    service.dispose()
  })

  it('drops to the durable facts while no Agent is current and a live stream publishes', async () => {
    const ctx = new Context()
    const parentSession = session('parent')
    const selected = agent(parentSession)
    const projections = new ProjectionFake()
    projections.set(parentSession, { mayflyConversationFacts: { ...initialConversationFacts(), active: true, phase: 'thinking' as const, turn: 1, currentStep: 0 } })
    ctx.reflect.provide('sessionProjections', projections)
    ctx.reflect.provide('sessions', { list: () => [parentSession] })
    let listener: ((value: Agent | null) => void) | undefined
    ctx.reflect.provide('mayflyCurrentAgent', {
      current: () => selected,
      subscribe(next: (value: Agent | null) => void) { listener = next; next(selected); return () => {} },
    })
    const live = new LiveAssistantStreamService(ctx)
    const service = new SessionFactsService(ctx, live)
    live.accept(selected, { type: 'start', attemptId: 'run' as never, revision: 1, turn: 1, step: 0 })
    live.accept(selected, { type: 'chunk', attemptId: 'run' as never, revision: 2, index: 0, time: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'x' } })
    await Promise.resolve()
    expect(service.current.phase).toBe('thinking')
    listener!(null)
    live.accept(selected, { type: 'chunk', attemptId: 'run' as never, revision: 3, index: 1, time: 2, chunk: { type: 'reasoning-delta', index: 1, text: 'y' } })
    await Promise.resolve()
    expect(service.current).toEqual(initialConversationFacts())
    service.dispose()
    live.dispose()
    await ctx.fiber.dispose()
  })

  it('prunes settled children that have no end time by treating it as the oldest', async () => {
    const ctx = new Context()
    const parentSession = session('parent')
    const childSessions = Array.from({ length: 34 }, (_, index) => session(`child-${String(index)}`, { origin: 'subagent', parentSession: 'parent' }))
    const projections = new ProjectionFake()
    projections.set(parentSession, { mayflyConversationFacts: initialConversationFacts() })
    childSessions.forEach((child, index) => {
      const facts = index === 0
        ? { ...initialConversationFacts(), active: true, phase: 'waiting' as const, turn: 1, currentStep: 0 }
        : { ...initialConversationFacts(), active: false, runOutcome: 'completed' as const }
      projections.set(child, { mayflyConversationFacts: facts })
    })
    const current = agent(parentSession)
    ctx.reflect.provide('sessionProjections', projections)
    ctx.reflect.provide('sessions', { list: () => [parentSession, ...childSessions] })
    ctx.reflect.provide('mayflyCurrentAgent', { subscribe(listener: (value: Agent) => void) { listener(current); return () => {} } })
    const service = new SessionFactsService(ctx)
    const lists: Array<readonly ChildSessionFacts[]> = []
    service.subscribeChildren(value => lists.push(value))
    expect(lists.at(-1)!.map(child => child.id)).toHaveLength(33)
    expect(lists.at(-1)!.some(child => child.id === 'child-0')).toBe(true)
    service.dispose()
    await ctx.fiber.dispose()
  })
})

describe('SessionFactsService child Agent replacement', () => {
  it('publishes a replaced child Agent on the volatile cadence when only its streamed output moved', async () => {
    vi.useFakeTimers()
    const ctx = new Context()
    const parentSession = session('parent')
    const childSession = session('child', { origin: 'subagent', parentSession: 'parent' })
    const current = agent(parentSession)
    const original = agent(childSession)
    const projections = new ProjectionFake()
    projections.set(parentSession, { mayflyConversationFacts: initialConversationFacts() })
    projections.set(childSession, {
      mayflyConversationFacts: { ...initialConversationFacts(), active: true, phase: 'waiting' as const, turn: 1, currentStep: 0 },
    })
    ctx.reflect.provide('sessionProjections', projections)
    ctx.reflect.provide('sessions', { list: () => [parentSession, childSession] })
    ctx.reflect.provide('agents', { get: (id: unknown) => String(id) === 'child' ? original : undefined })
    ctx.reflect.provide('mayflyCurrentAgent', { subscribe(listener: (value: Agent) => void) { listener(current); return () => {} } })
    const live = new LiveAssistantStreamService(ctx)
    const service = new SessionFactsService(ctx, live)
    const published: Array<readonly ChildSessionFacts[]> = []
    service.subscribeChildren(value => published.push(value))
    let revision = 0
    const streamed = (...chunks: readonly (readonly [string, number, 'text' | 'reasoning'])[]): Agent => {
      const next = agent(childSession)
      const attemptId = `run-${String(revision + 1)}`
      live.accept(next, { type: 'start', attemptId: attemptId as never, revision: ++revision, turn: 1, step: 0 })
      for (let index = 0; index < chunks.length; index += 1) {
        const [text, time, kind] = chunks[index]!
        live.accept(next, { type: 'chunk', attemptId: attemptId as never, revision: ++revision, index, time, chunk: kind === 'reasoning' ? { type: 'reasoning-delta', index: 0, text } : { type: 'text-delta', index: 0, text } })
      }
      return next
    }
    // The first replacement introduces the progress object.
    ctx.emit('agent/created', { agent: streamed(['ab', 1, 'text'], ['cdef', 2, 'text']) } as never)
    expect(published.at(-1)?.[0]).toMatchObject({ activity: 'Writing…', liveChars: 6 })
    // Same characters and start, a different first-chunk share.
    ctx.emit('agent/created', { agent: streamed(['abcd', 1, 'text'], ['ef', 2, 'text']) } as never)
    // Back to the first share, then one whose first chunk started a second later.
    ctx.emit('agent/created', { agent: streamed(['ab', 1, 'text'], ['cdef', 2, 'text']) } as never)
    ctx.emit('agent/created', { agent: streamed(['ab', 2, 'text'], ['cdef', 3, 'text']) } as never)
    // Same start, a later last chunk.
    ctx.emit('agent/created', { agent: streamed(['ab', 1, 'text'], ['cdef', 3, 'text']) } as never)
    // Same progress as a fresh single chunk, but more streamed characters in total.
    ctx.emit('agent/created', { agent: streamed(['abcdef', 1, 'text']) } as never)
    ctx.emit('agent/created', { agent: streamed(['xyz', 0, 'reasoning'], ['abcdef', 1, 'text']) } as never)
    vi.advanceTimersByTime(CHILD_VOLATILE_MS)
    expect(published.at(-1)?.[0]).toMatchObject({ liveChars: 9 })
    // A replacement with the very same figures is not a change at all.
    ctx.emit('agent/created', { agent: streamed(['xyz', 0, 'reasoning'], ['abcdef', 1, 'text']) } as never)
    vi.advanceTimersByTime(CHILD_VOLATILE_MS)
    expect(published.at(-1)?.[0]).toMatchObject({ liveChars: 9 })
    service.dispose()
    vi.useRealTimers()
    live.dispose()
    await ctx.fiber.dispose()
  })
})
