/** The Goal item of the status row: its summary and panel as pure functions of the goal, and the view that follows the exact current Agent.
 * @module @ephemeral-ai/mayfly/transcript/tests/status-goal
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MayflyLocaleService } from '../../src/frontend/locale.ts'
import type { GoalPhase, GoalView } from '@deepseek-ai/dsh-goal'
import type { MayflyActionItem, MayflyUiActionEvent, MayflyUiEventContext } from '@ephemeral-ai/mayfly-ui'
import { describe, expect, it, vi } from 'vitest'
import * as goalStatus from '../../src/transcript/status-goal.ts'
import { SHED } from '../../src/transcript/status-shed.ts'
import { transcriptTranslatorFake } from './notices-fakes.ts'
import { bootPanePlugin, HandTick } from './pane-fakes.ts'
import { fakeAgent, type FakeFactsService } from './status-fakes.ts'

function goal(phase: GoalPhase, options: { rounds?: number, max?: number, activation?: GoalView['activation'], updatedAt?: number } = {}): GoalView {
  return {
    id: 'goal-1' as GoalView['id'],
    revision: 3,
    objective: 'ship the footer',
    phase,
    ...(phase === 'blocked' ? { blockedReason: { code: 'tests-red', message: 'tests are red' } } : {}),
    maxGoalRounds: options.max ?? 8,
    roundsStarted: options.rounds ?? 2,
    createdAt: 1_000,
    updatedAt: options.updatedAt ?? 2_000,
    activation: options.activation ?? 'armed',
  }
}

/** The text of every rich-text span under a node, in order, and the spans themselves. */
function spansOf(node: unknown): { readonly text: string, readonly tone?: string }[] {
  if (node === null || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(spansOf)
  const record = node as Record<string, unknown>
  return [...record.kind === 'rich-text' ? record.spans as never[] : [], ...Object.entries(record).filter(([key]) => key !== 'spans').flatMap(([, value]) => spansOf(value))]
}
const textOf = (node: unknown): string => spansOf(node).map(span => span.text).join('')
/** The words of a summary at its full form (a shed node also holds its narrower forms). */
const fullText = (node: unknown): string => textOf((node as { readonly node: unknown }).node)

/** The summary's full form and its narrower forms. */
function forms(node: unknown): { readonly full: unknown, readonly narrower: readonly { readonly rank: number, readonly node: unknown }[] } {
  const shed = node as { readonly kind: string, readonly node: unknown, readonly narrower: readonly { readonly rank: number, readonly node: unknown }[] }
  expect(shed.kind).toBe('shed')
  return { full: shed.node, narrower: shed.narrower }
}

describe('goalSummary', () => {
  const t = transcriptTranslatorFake
  const summary = (value: GoalView | undefined, now = 61_000, done?: goalStatus.GoalItemState['done']) => goalStatus.goalSummary({ goal: value, now, ...done === undefined ? {} : { done } }, t)

  it('says the mark, the rounds over their cap, and the time, with the time as the form the row gives up first', () => {
    const { full, narrower } = forms(summary(goal('active'))!.node)
    // An armed goal's time runs: now minus its creation.
    expect(textOf(full)).toBe('● goal 2/8 1m 0s')
    expect(narrower.map(form => [form.rank, textOf(form.node)])).toEqual([[SHED.time, '● goal 2/8']])
  })

  it('marks the phase: armed, disarmed, paused, blocked, with their tones', () => {
    const marks = (value: GoalView) => spansOf(summary(value)!.node)[0]
    expect(marks(goal('active', { activation: 'armed' }))).toEqual({ text: '●', tone: 'accent' })
    expect(marks(goal('active', { activation: 'disarmed' }))).toEqual({ text: '○', tone: 'muted' })
    expect(marks(goal('paused'))).toEqual({ text: '⏸', tone: 'muted' })
    expect(marks(goal('blocked'))).toEqual({ text: '✕', tone: 'danger' })
  })

  it('holds the time it had at its last change unless the goal is armed', () => {
    expect(fullText(summary(goal('paused', { updatedAt: 31_000 }), 999_000)!.node)).toBe('⏸ goal 2/8 30s')
    expect(fullText(summary(goal('active', { activation: 'disarmed', updatedAt: 31_000 }), 999_000)!.node)).toBe('○ goal 2/8 30s')
    expect(fullText(summary(goal('active'), 999_000)!.node)).toContain('16m')
  })

  it('shows nothing for no goal or a completed one, and a closing item with the mark of success once it finishes', () => {
    expect(summary(undefined)).toBeNull()
    expect(summary(goal('complete'))).toBeNull()
    const closing = summary(goal('complete'), 5_000, { rounds: 8, total: 8, elapsedMs: 119_000 })!.node
    expect(fullText(closing)).toBe('✓ goal 8/8 1m 59s')
    expect(spansOf(closing)[0]).toEqual({ text: '✓', tone: 'success' })
  })
})

describe('goalPanel', () => {
  const t = transcriptTranslatorFake
  const panel = (value: GoalView | undefined) => goalStatus.goalPanel({ goal: value, now: 0 }, t)
  /** The keys the panel carries: id, key, and hint label of each, in order. */
  const keysOf = (node: unknown): { readonly verb: string, readonly key: string | undefined, readonly confirm: boolean }[] => {
    const found: MayflyActionItem[] = []
    const walk = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return
      const record = value as { readonly kind?: string, readonly items?: MayflyActionItem[] }
      if (record.kind === 'actions') found.push(...record.items!)
      for (const child of Object.values(value)) walk(child)
    }
    walk(node)
    return found.map(item => ({ verb: item.id.replace(/^goal-/u, '').replace(/:\d+$/u, ''), key: item.key, confirm: item.confirm !== undefined }))
  }

  it('has no panel for no goal or a finished one', () => {
    expect(panel(undefined)).toBeNull()
    expect(panel(goal('complete'))).toBeNull()
  })

  it('shows the whole objective, and a blocked goal its code and reason, with no heading, count, or time', () => {
    expect(textOf(panel(goal('active')))).toBe('  ship the footer')
    expect(textOf(panel(goal('blocked')))).toBe('  ship the footer  blocked · tests-red: tests are red')
    expect(spansOf(panel(goal('blocked'))).find(span => span.text.includes('tests-red'))?.tone).toBe('danger')
  })

  it('offers single letters, none a button: pause for an armed goal, resume for one that waits and has rounds left, always edit and clear', () => {
    expect(keysOf(panel(goal('active')))).toEqual([{ verb: 'pause', key: 'p', confirm: false }, { verb: 'edit', key: 'e', confirm: false }, { verb: 'clear', key: 'c', confirm: true }])
    expect(keysOf(panel(goal('paused'))).map(item => item.key)).toEqual(['r', 'e', 'c'])
    expect(keysOf(panel(goal('blocked'))).map(item => item.key)).toEqual(['r', 'e', 'c'])
    expect(keysOf(panel(goal('active', { activation: 'disarmed' }))).map(item => item.key)).toEqual(['r', 'e', 'c'])
    // The round cap spent: nothing to resume.
    expect(keysOf(panel(goal('paused', { rounds: 8, max: 8 }))).map(item => item.key)).toEqual(['e', 'c'])
    // Each id is fenced to the revision the panel was built for.
    expect(JSON.stringify(panel(goal('active')))).toContain('goal-pause:3')
  })
})

/** The current-Agent service the view follows, driven by hand. */
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

async function bootGoal(agent: Agent | null, services: Record<string, unknown>) {
  const tick = new HandTick()
  const harness = await bootPanePlugin(goalStatus, agent as never, { mayflyTick: tick, ...services })
  const entry = () => harness.ctx.mayflyPanes.list().find(candidate => candidate.id === 'mayfly.view.goal')!
  const act = async (actionId: string): Promise<unknown> => {
    const current = entry()
    const event = { kind: 'activate', pagePath: [], controlId: actionId, actionId } as unknown as MayflyUiActionEvent
    const context = { surfaceId: current.id, operationId: 'goal-test', source: current.source, revision: current.revision, signal: new AbortController().signal, report: vi.fn() } as unknown as MayflyUiEventContext
    return current.definition.onEvent!.action!(event, context)
  }
  return { ...harness, tick, entry, act }
}

describe('mayfly-status-goal', () => {
  it('registers a views pane before todo, with no item until a goal exists, and tracks only the exact current Agent', async () => {
    const first = fakeAgent([]) as unknown as Agent
    const second = fakeAgent([]) as unknown as Agent
    const foreign = fakeAgent([]) as unknown as Agent
    const selected = currentAgentService(first)
    const views = new Map<Agent, GoalView>()
    const get = vi.fn((agent: Agent) => views.get(agent))
    const harness = await bootGoal(first, { mayflyCurrentAgent: selected.service, goals: { get } })
    expect(harness.entry().definition).toMatchObject({ placement: 'views', priority: 13 })
    expect(harness.entry().summary).toBeNull()
    expect(get).toHaveBeenLastCalledWith(first)

    views.set(first, goal('active'))
    harness.ctx.emit('goal/changed', { agent: foreign } as never)
    expect(harness.entry().summary).toBeNull()
    harness.ctx.emit('goal/changed', { agent: first } as never)
    expect(fullText(harness.entry().summary!.node)).toMatch(/^● goal 2\/8/u)
    expect(textOf(harness.entry().node)).toContain('ship the footer')

    // The same goal again republishes nothing: the entry keeps its revision.
    const revision = harness.ctx.mayflyPanes.list().find(candidate => candidate.id === 'mayfly.view.goal')!.revision
    harness.ctx.emit('goal/changed', { agent: first } as never)
    expect(harness.ctx.mayflyPanes.list().find(candidate => candidate.id === 'mayfly.view.goal')!.revision).toBe(revision)

    views.set(first, goal('paused', { rounds: 4, max: 12, activation: 'disarmed' }))
    ;(harness.ctx.get('mayflySessionFacts') as unknown as FakeFactsService).setGoal(null)
    expect(fullText(harness.entry().summary!.node)).toMatch(/^⏸ goal 4\/12/u)
    views.set(first, goal('blocked'))
    harness.ctx.emit('goal/changed', { agent: first } as never)
    expect(fullText(harness.entry().summary!.node)).toMatch(/^✕ goal 2\/8/u)

    // Activation is process-local: the driver disarms without a durable change.
    views.set(first, goal('active', { activation: 'disarmed' }))
    harness.ctx.emit('goal/activation-changed', { agent: first } as never)
    expect(fullText(harness.entry().summary!.node)).toMatch(/^○ goal 2\/8/u)

    views.set(first, goal('active'))
    harness.ctx.emit('agent/created', { agent: foreign, source: 'resume' } as never)
    expect(fullText(harness.entry().summary!.node)).toMatch(/^○ goal/u)
    harness.ctx.emit('agent/created', { agent: first, source: 'resume' } as never)
    expect(fullText(harness.entry().summary!.node)).toMatch(/^● goal/u)

    views.set(second, goal('paused', { rounds: 1, activation: 'disarmed' }))
    selected.switchTo(second)
    expect(get).toHaveBeenLastCalledWith(second)
    expect(fullText(harness.entry().summary!.node)).toMatch(/^⏸ goal 1\/8/u)
    selected.switchTo(null)
    expect(harness.entry().summary).toBeNull()
    await harness.dispose()
    expect(selected.listenerCount()).toBe(0)
    expect(harness.ctx.mayflyPanes.list().some(candidate => candidate.id === 'mayfly.view.goal')).toBe(false)
  })

  it('runs the clock only while an armed goal moves or the closing item is up, and holds the closing item five seconds', async () => {
    const agent = fakeAgent([]) as unknown as Agent
    const views = new Map<Agent, GoalView>([[agent, goal('active')]])
    const harness = await bootGoal(agent, { mayflyCurrentAgent: currentAgentService(agent).service, goals: { get: (query: Agent) => views.get(query) } })
    expect(harness.tick.subscribers).toBe(1)
    harness.tick.fire(61_000)
    expect(fullText(harness.entry().summary!.node)).toBe('● goal 2/8 1m 0s')
    views.set(agent, goal('paused'))
    harness.ctx.emit('goal/changed', { agent } as never)
    expect(harness.tick.subscribers).toBe(0)

    // A goal that is complete when the session loads shows nothing; one seen in progress closes with its item.
    views.set(agent, goal('active'))
    harness.ctx.emit('goal/changed', { agent } as never)
    views.set(agent, goal('complete', { rounds: 8, max: 8, updatedAt: 120_000 }))
    const before = Date.now()
    harness.ctx.emit('goal/changed', { agent } as never)
    expect(fullText(harness.entry().summary!.node)).toBe('✓ goal 8/8 1m 59s')
    expect(harness.entry().node).toBeNull()
    expect(harness.tick.subscribers).toBe(1)
    const after = Date.now()
    harness.tick.fire(before + goalStatus.GOAL_DONE_LINGER_MS - 1)
    expect(harness.entry().summary).not.toBeNull()
    harness.tick.fire(after + goalStatus.GOAL_DONE_LINGER_MS + 1000)
    expect(harness.entry().summary).toBeNull()
    expect(harness.tick.subscribers).toBe(0)
    await harness.dispose()

    const loaded = await bootGoal(agent, { mayflyCurrentAgent: currentAgentService(agent).service, goals: { get: () => goal('complete') } })
    expect(loaded.entry().summary).toBeNull()
    await loaded.dispose()
  })

  it('republishes when the language changes', async () => {
    const agent = fakeAgent([]) as unknown as Agent
    const harness = await bootGoal(agent, { mayflyCurrentAgent: currentAgentService(agent).service, goals: { get: () => goal('active') } })
    await harness.ctx.plugin({ name: 'item-locale', apply(owner: Context) { const service = new MayflyLocaleService(owner, { systemLocale: 'en' }); owner.effect(() => () => service.dispose()) } })
    harness.ctx.mayflyLocale.setPreference('zh')
    expect(harness.entry().summary).not.toBeNull()
    await harness.dispose()
  })

  it('contains native read failures and skips the registry without a current Agent', async () => {
    const current = fakeAgent([]) as unknown as Agent
    for (const failure of [new Error('goal registry offline'), 'goal string failure']) {
      const get = vi.fn(() => { throw failure })
      const harness = await bootGoal(current, { mayflyCurrentAgent: currentAgentService(current).service, goals: { get } })
      expect(harness.entry().summary).toBeNull()
      await harness.dispose()
    }
    const absentGet = vi.fn()
    const absent = await bootGoal(null, { mayflyCurrentAgent: currentAgentService(null).service, goals: { get: absentGet } })
    expect(absent.entry().summary).toBeNull()
    expect(absentGet).not.toHaveBeenCalled()
    await absent.dispose()
  })

  describe('the keys', () => {
    async function withGoal(view: GoalView) {
      const agent = fakeAgent([]) as unknown as Agent
      const goals = { get: vi.fn(() => view), resume: vi.fn(), pause: vi.fn(), clear: vi.fn() }
      const leaveViews = vi.fn()
      const setText = vi.fn()
      const harness = await bootGoal(agent, {
        mayflyCurrentAgent: currentAgentService(agent).service, goals, mayflyScreen: { leaveViews },
        mayflyPromptEditor: { current: { editor: { setText } } },
      })
      return { harness, agent, goals, leaveViews, setText }
    }

    it('runs each /goal verb on the exact current Agent and goal', async () => {
      const { harness, agent, goals } = await withGoal(goal('paused'))
      await expect(harness.act('goal-resume:3')).resolves.toEqual({ kind: 'completed' })
      expect(goals.resume).toHaveBeenCalledWith(agent, expect.objectContaining({ revision: 3 }))
      await harness.act('goal-clear:3')
      expect(goals.clear).toHaveBeenCalledWith(agent, expect.objectContaining({ id: 'goal-1' }))
      await harness.dispose()
      const armed = await withGoal(goal('active'))
      await armed.harness.act('goal-pause:3')
      expect(armed.goals.pause).toHaveBeenCalledWith(armed.agent, expect.objectContaining({ revision: 3 }))
      await armed.harness.dispose()
    })

    it('refuses an action built for an older revision, and an unknown verb, and reports a failing call', async () => {
      const { harness, goals } = await withGoal(goal('paused'))
      await expect(harness.act('goal-resume:2')).resolves.toMatchObject({ kind: 'failed', message: 'The goal changed; open it again' })
      expect(goals.resume).not.toHaveBeenCalled()
      await expect(harness.act('goal-explode:3')).resolves.toMatchObject({ kind: 'failed', message: 'Unknown goal action' })
      goals.resume.mockImplementation(() => { throw new Error('round cap reached') })
      await expect(harness.act('goal-resume:3')).resolves.toMatchObject({ kind: 'failed', message: 'round cap reached' })
      await harness.dispose()
    })

    it('puts the objective in the prompt for edit and leaves the view, and says so when there is no prompt', async () => {
      const { harness, leaveViews, setText } = await withGoal(goal('active'))
      await expect(harness.act('goal-edit:3')).resolves.toEqual({ kind: 'completed' })
      expect(setText).toHaveBeenCalledWith('/goal edit ship the footer')
      expect(leaveViews).toHaveBeenCalledTimes(1)
      await harness.dispose()

      const agent = fakeAgent([]) as unknown as Agent
      const noPrompt = await bootGoal(agent, { mayflyCurrentAgent: currentAgentService(agent).service, goals: { get: () => goal('active') }, mayflyScreen: { leaveViews: vi.fn() } })
      await expect(noPrompt.act('goal-edit:3')).resolves.toMatchObject({ kind: 'failed', message: 'The prompt is not available' })
      await noPrompt.dispose()
    })

    it('says what failed when the registry cannot be read or a verb throws a string', async () => {
      const { harness, goals } = await withGoal(goal('paused'))
      goals.get.mockImplementationOnce(() => { throw new Error('goal registry offline') })
      await expect(harness.act('goal-resume:3')).resolves.toMatchObject({ kind: 'failed', message: 'goal registry offline' })
      goals.pause.mockImplementationOnce(() => { throw 'pause string failure' })
      await expect(harness.act('goal-pause:3')).resolves.toMatchObject({ kind: 'failed', message: 'pause string failure' })
      // With no goal at all the panel's key has nothing to act on.
      goals.get.mockReturnValueOnce(undefined as never)
      await expect(harness.act('goal-clear:3')).resolves.toMatchObject({ kind: 'failed', message: 'The goal changed; open it again' })
      await harness.dispose()
    })

    it('says the goal changed when there is no Agent to act on', async () => {
      const agent = fakeAgent([]) as unknown as Agent
      const selected = currentAgentService(agent)
      const harness = await bootGoal(agent, { mayflyCurrentAgent: selected.service, goals: { get: () => goal('paused'), resume: vi.fn() } })
      selected.switchTo(null)
      await expect(harness.act('goal-resume:3')).resolves.toMatchObject({ kind: 'failed', message: 'The goal changed; open it again' })
      await harness.dispose()
    })

    it('ignores events that are not an activation', async () => {
      const { harness, goals } = await withGoal(goal('paused'))
      const current = harness.entry() as never as { definition: { onEvent: { action: (event: unknown, context: unknown) => unknown } } }
      expect(current.definition.onEvent.action({ kind: 'dismiss', pagePath: [] }, {})).toEqual({ kind: 'completed' })
      expect(goals.resume).not.toHaveBeenCalled()
      await harness.dispose()
    })
  })
})
