/** Native current-Agent and session-projection coverage for SessionFactsService.
 * @module @ephemeral-ai/mayfly/transcript/tests/session-facts
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GoalPhase, GoalProjection } from '@deepseek-ai/dsh-goal'
import type { Session } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { initialConversationFacts } from '../../src/conversation/facts.ts'
import { projectChildSessionFacts, SessionFactsService } from '../../src/transcript/session-facts.ts'
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
    live.accept(selected, { type: 'start', attemptId: 'active' as never, revision: 1, turn: 1, step: 0 })
    live.accept(selected, { type: 'chunk', attemptId: 'active' as never, revision: 2, index: 0, time: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'thought' } })
    await Promise.resolve()
    expect(facts.current).toMatchObject({ phase: 'thinking', flowDownChars: 7 })
    live.accept(selected, { type: 'chunk', attemptId: 'active' as never, revision: 3, index: 1, time: 2, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thought' } } })
    await Promise.resolve()
    expect(facts.current.phase).toBe('waiting')
    expect(facts.current.outputProgress).toBeUndefined()
    live.accept(selected, { type: 'chunk', attemptId: 'active' as never, revision: 4, index: 2, time: 3, chunk: { type: 'text-delta', index: 1, text: 'answer' } })
    await Promise.resolve()
    expect(facts.current.phase).toBe('composing')
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
    const parentFacts = { ...initialConversationFacts(), model: 'm' }
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
    const models: Array<string | undefined> = []
    const titles: Array<string | undefined> = []
    const goals: Array<GoalProjection | null> = []
    const agents: Array<Agent | null> = []
    const children: string[][] = []
    const offFacts = service.subscribe(facts => models.push(facts.model))
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

    projections.emit(unrelated, 'mayflyConversationFacts', { ...parentFacts, model: 'ignored' })
    projections.emit(parentSession, 'other', parentFacts)
    projections.emit(parentSession, 'mayflyConversationFacts', { phase: 'bad' })
    projections.emit(parentSession, 'mayflyConversationFacts', { ...parentFacts, model: 'next' })
    projections.emit(parentSession, 'title', 'second')
    projections.emit(parentSession, 'title', null)
    projections.emit(parentSession, 'goal', { phase: 'bad' })
    projections.emit(parentSession, 'goal', blockedGoal)
    projections.emit(parentSession, 'goal', blockedGoal)
    projections.emit(parentSession, 'goal', null)
    projections.emit(childSession, 'mayflyConversationFacts', { ...childFacts, model: 'child-model' })
    expect(models).toEqual(['m', 'next'])
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
    expect(projectChildSessionFacts('tool', {
      ...base, active: true, phase: 'tool', activity: { kind: 'tool' }, reasoningEffort: 'high',
    })).toMatchObject({ id: 'tool', phase: 'running', activity: 'Using tool', effort: 'high' })
    expect(projectChildSessionFacts('reasoning', {
      ...base, active: true, phase: 'thinking', activity: { kind: 'reasoning' },
    })).toMatchObject({ phase: 'running', activity: 'Thinking…' })
    expect(projectChildSessionFacts('text', {
      ...base, active: true, phase: 'composing', activity: { kind: 'text' },
    })).toMatchObject({ phase: 'running', activity: 'Writing…' })
    expect(projectChildSessionFacts('starting', {
      ...base, active: true, phase: 'waiting',
    })).toMatchObject({ phase: 'waiting', activity: 'Starting…' })
    expect(projectChildSessionFacts('done', base)).toEqual({
      id: 'done', phase: 'completed', tokens: 0, toolCount: 0,
    })
  })

  it('overlays a fresh child draft and rejects stale or foreign drafts', () => {
    const base = { ...initialConversationFacts(), active: true, phase: 'waiting' as const, turn: 2, currentStep: 1 }
    const draft = { sessionId: 'child', attemptId: 'a', revision: 4, turn: 2, step: 1, phase: 'thinking' as const, reasoning: 'r', text: '', outputProgress: undefined, chars: 9, updatedAt: 5 }
    expect(projectChildSessionFacts('child', base, draft)).toMatchObject({ phase: 'running', activity: 'Thinking…' })
    expect(projectChildSessionFacts('child', base, { ...draft, phase: 'composing' })).toMatchObject({ phase: 'running', activity: 'Writing…' })
    expect(projectChildSessionFacts('child', base, { ...draft, phase: 'waiting' })).toMatchObject({ phase: 'waiting' })
    expect(projectChildSessionFacts('child', base, { ...draft, sessionId: 'other' })).toMatchObject({ phase: 'waiting' })
    expect(projectChildSessionFacts('child', base, { ...draft, turn: 1 })).toMatchObject({ phase: 'waiting' })
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
    const children: Array<ReadonlyArray<{ readonly id: string, readonly activity?: string }>> = []
    service.subscribeChildren(value => children.push(value))
    expect(children.at(-1)).toEqual([{ id: 'child', activity: 'Starting…', phase: 'waiting', tokens: 0, toolCount: 0, promptText: 'delegate' }])
    live.accept(childAgent, { type: 'start', attemptId: 'run' as never, revision: 1, turn: 1, step: 0 })
    live.accept(childAgent, { type: 'chunk', attemptId: 'run' as never, revision: 2, index: 0, time: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'thinking' } })
    await Promise.resolve()
    expect(children.at(-1)?.[0]).toMatchObject({ phase: 'running', activity: 'Thinking…' })
    const published = children.length
    live.accept(current, { type: 'start', attemptId: 'parent-run' as never, revision: 1, turn: 1, step: 0 })
    await Promise.resolve()
    expect(children).toHaveLength(published)
    expect(children.at(-1)?.[0]).toMatchObject({ phase: 'running', activity: 'Thinking…' })
    live.accept(childAgent, { type: 'chunk', attemptId: 'run' as never, revision: 3, index: 1, time: 2, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking' } } })
    live.accept(childAgent, { type: 'chunk', attemptId: 'run' as never, revision: 4, index: 2, time: 3, chunk: { type: 'text-delta', index: 1, text: 'draft' } })
    await Promise.resolve()
    expect(children.at(-1)?.[0]).toMatchObject({ phase: 'running', activity: 'Writing…' })
    service.dispose()
    live.dispose()
    await ctx.fiber.dispose()
  })
})
