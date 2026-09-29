/** Native current-goal status contribution behavior.
 * @module @ephemeral-ai/mayfly/transcript/tests/status-goal
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GoalPhase, GoalView } from '@deepseek-ai/dsh-goal'
import { describe, expect, it, vi } from 'vitest'
import * as goalStatus from '../../src/transcript/status-goal.ts'
import { bootStatusPlugin, fakeAgent, type FakeFactsService } from './status-fakes.ts'

function goal(phase: GoalPhase, options: { rounds?: number, max?: number, activation?: GoalView['activation'] } = {}): GoalView {
  return {
    id: 'goal-1' as GoalView['id'],
    revision: 3,
    objective: 'ship the footer',
    phase,
    ...(phase === 'blocked' ? { blockedReason: { code: 'tests-red', message: 'tests are red' } } : {}),
    maxGoalRounds: options.max ?? 8,
    roundsStarted: options.rounds ?? 2,
    createdAt: 1_000,
    updatedAt: 2_000,
    activation: options.activation ?? 'armed',
  }
}

function currentAgentService(initial: Agent | null) {
  let current = initial
  const listeners = new Set<(agent: Agent | null, revision: number) => void>()
  return {
    service: {
      current: () => current,
      revision: () => 0,
      subscribe(listener: (agent: Agent | null, revision: number) => void) {
        listeners.add(listener)
        listener(current, 0)
        return () => { listeners.delete(listener) }
      },
    },
    listenerCount: () => listeners.size,
    switchTo(agent: Agent | null) {
      current = agent
      for (const listener of listeners) listener(agent, 1)
    },
  }
}

describe('goalStatusText', () => {
  it('labels the round unit and hides completed goals', () => {
    expect(goalStatus.goalStatusText(undefined)).toBe('')
    expect(goalStatus.goalStatusText(goal('active'))).toBe('Goal active · round 2/8')
    expect(goalStatus.goalStatusText(goal('paused', { rounds: 4, max: 12 }))).toBe('Goal paused · round 4/12')
    expect(goalStatus.goalStatusText(goal('blocked'))).toBe('Goal blocked · round 2/8')
    expect(goalStatus.goalStatusText(goal('complete'))).toBe('')
  })

  it('keeps armed silent and words disarmed as auto-continue off', () => {
    expect(goalStatus.goalStatusText(goal('active', { activation: 'armed' }))).toBe('Goal active · round 2/8')
    expect(goalStatus.goalStatusText(goal('active', { activation: 'disarmed' }))).toBe('Goal active · round 2/8 · auto-continue off')
    expect(goalStatus.goalStatusText(goal('complete', { activation: 'disarmed' }))).toBe('')
  })
})

describe('mayfly-status-goal', () => {
  it('tracks only the exact current Agent across durable and activation changes', async () => {
    const first = fakeAgent([]) as unknown as Agent
    const second = fakeAgent([]) as unknown as Agent
    const foreign = fakeAgent([]) as unknown as Agent
    const selected = currentAgentService(first)
    const views = new Map<Agent, GoalView>()
    const get = vi.fn((agent: Agent) => views.get(agent))
    const harness = await bootStatusPlugin(goalStatus, first as never, {
      services: { mayflyCurrentAgent: selected.service, goals: { get } },
    })
    expect(harness.entry.id).toBe('')
    expect(get).toHaveBeenLastCalledWith(first)

    views.set(first, goal('active'))
    harness.ctx.emit('goal/changed', { agent: foreign } as never)
    expect(harness.entry.id).toBe('')
    harness.ctx.emit('goal/changed', { agent: first } as never)
    expect(harness.entry.id).toBe('mayfly.status.goal')
    expect(harness.entry.priority).toBe(2)
    expect(harness.entry.render(80)).toBe('Goal active · round 2/8')
    expect(harness.entry.render(5)).toBe('')

    const baseline = harness.screen.renderRequests.length
    harness.ctx.emit('goal/changed', { agent: first } as never)
    expect(harness.screen.renderRequests.length).toBe(baseline)

    views.set(first, goal('paused', { rounds: 4, max: 12, activation: 'disarmed' }))
    ;(harness.ctx.get('mayflySessionFacts') as FakeFactsService).setGoal(null)
    expect(harness.entry.render(80)).toBe('Goal paused · round 4/12 · auto-continue off')
    views.set(first, goal('blocked'))
    harness.ctx.emit('goal/changed', { agent: first } as never)
    expect(harness.entry.render(80)).toBe('Goal blocked · round 2/8')
    views.set(first, goal('complete', { activation: 'disarmed' }))
    harness.ctx.emit('goal/changed', { agent: first } as never)
    expect(harness.entry.id).toBe('')

    views.set(first, goal('active', { activation: 'armed' }))
    harness.ctx.emit('agent/created', { agent: foreign, source: 'resume' } as never)
    expect(harness.entry.id).toBe('')
    harness.ctx.emit('agent/created', { agent: first, source: 'resume' } as never)
    expect(harness.entry.render(80)).toBe('Goal active · round 2/8')

    views.set(second, goal('paused', { rounds: 1, activation: 'disarmed' }))
    selected.switchTo(second)
    expect(get).toHaveBeenLastCalledWith(second)
    expect(harness.entry.render(80)).toBe('Goal paused · round 1/8 · auto-continue off')
    selected.switchTo(null)
    expect(harness.entry.id).toBe('')
    await harness.dispose()
    expect(selected.listenerCount()).toBe(0)
  })

  it('contains native read failures and skips the registry without a current Agent', async () => {
    const current = fakeAgent([]) as unknown as Agent
    const errorGet = vi.fn(() => { throw new Error('goal registry offline') })
    const first = await bootStatusPlugin(goalStatus, current as never, {
      services: { mayflyCurrentAgent: currentAgentService(current).service, goals: { get: errorGet } },
    })
    expect(first.entry.id).toBe('')
    await first.dispose()

    const stringGet = vi.fn(() => { throw 'goal string failure' })
    const second = await bootStatusPlugin(goalStatus, current as never, {
      services: { mayflyCurrentAgent: currentAgentService(current).service, goals: { get: stringGet } },
    })
    expect(second.entry.id).toBe('')
    await second.dispose()

    const absentGet = vi.fn()
    const absent = await bootStatusPlugin(goalStatus, null, {
      services: { mayflyCurrentAgent: currentAgentService(null).service, goals: { get: absentGet } },
    })
    expect(absent.entry.id).toBe('')
    expect(absentGet).not.toHaveBeenCalled()
    await absent.dispose()
  })

  it('paints the phase tone aligned with the todo pane badge', async () => {
    const agent = fakeAgent([]) as unknown as Agent
    const selected = currentAgentService(agent)
    const views = new Map<Agent, GoalView>()
    const get = vi.fn((query: Agent) => views.get(query))
    const marker = (tag: string) => (text: string) => `<${tag}>${text}`
    const harness = await bootStatusPlugin(goalStatus, agent as never, {
      colors: {
        accent: marker('accent'), error: marker('danger'), muted: marker('muted'),
        warning: marker('warning'), success: marker('success'),
      },
      services: { mayflyCurrentAgent: selected.service, goals: { get } },
    })
    views.set(agent, goal('active'))
    harness.ctx.emit('goal/changed', { agent } as never)
    expect(harness.entry.render(80)).toBe('<accent>Goal active · round 2/8')
    views.set(agent, goal('blocked'))
    harness.ctx.emit('goal/changed', { agent } as never)
    expect(harness.entry.render(80)).toBe('<danger>Goal blocked · round 2/8')
    views.set(agent, goal('paused'))
    harness.ctx.emit('goal/changed', { agent } as never)
    expect(harness.entry.render(80)).toBe('<muted>Goal paused · round 2/8')
    await harness.dispose()
  })
})
