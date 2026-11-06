/**
 * Decision tests for the Workflow faces: the durable fold, the live catalog's
 * attribution, the baseline/live merge, and the replacement stream.
 * @module
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { WorkflowLiveCatalog, followWorkflow, mayflyWorkflowProjectionDefinition } from '../../src/remote/workflow.ts'

const fold = mayflyWorkflowProjectionDefinition.apply

/** One session event carrying only the fields the fold reads. */
function event(type: string, data: object, time = 1, seq = 1): SessionEvent {
  return { type, data, time, seq } as never
}

/** Fold events over the initial snapshot for one session. */
function run(events: readonly SessionEvent[]): { sessionId: string, runs: never[] | unknown[] } {
  return events.reduce((state, item) => fold(state as never, item), mayflyWorkflowProjectionDefinition.init('session-1' as never, { id: 'session-1' } as never)) as never
}

/** A harness with event listeners the test can fire, over one parent session. */
function catalogHarness(): {
  ctx: Context
  catalog: WorkflowLiveCatalog
  fire(name: string, ...args: readonly unknown[]): void
  session: Session
} {
  const listeners = new Map<string, ((...args: readonly unknown[]) => void)[]>()
  const session = { id: 'session-1', header: { origin: 'user' } } as never as Session
  const projections = new Map<string, unknown>()
  const ctx = {
    on: (name: string, listener: (...args: readonly unknown[]) => void): (() => void) => {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      return () => { listeners.set(name, (listeners.get(name) ?? []).filter(item => item !== listener)) }
    },
    sessions: { get: (id: string): unknown =>
      id === 'child-1' ? { header: { parentSession: 'session-1' } } : id === 'session-1' ? session : undefined },
    sessionProjections: {
      // A registered projection always answers; an absent stored value reads
      // as the session's empty snapshot, never undefined.
      snapshot: (target: Session, keys: readonly string[]): { values: Record<string, unknown> } => ({
        values: Object.fromEntries(keys.map(key => [key, projections.get(`${String((target as { id: string }).id)}:${key}`)
          ?? { sessionId: String((target as { id: string }).id), runs: [] }])),
      }),
      onChanged: (): (() => void) => () => {},
    },
    logger: { warn: vi.fn() },
  } as unknown as Context
  const catalog = new WorkflowLiveCatalog(ctx)
  return {
    ctx,
    catalog,
    fire: (name: string, ...args: readonly unknown[]): void => { for (const listener of listeners.get(name) ?? []) listener(...args) },
    session,
  }
}

/** The WorkflowRunInfo the native events carry. */
const info = (id: string): { id: string, meta: { name: string, phases?: readonly { title: string }[] } } =>
  ({ id, meta: { name: 'deploy' } })

describe('mayflyWorkflowProjectionDefinition', () => {
  it('pins its key, version, and wire summary exclusion', () => {
    expect(mayflyWorkflowProjectionDefinition.key).toBe('mayflyWorkflow')
    expect(mayflyWorkflowProjectionDefinition.stateVersion).toBe(2)
    expect(mayflyWorkflowProjectionDefinition.wire.summary).toBe(false)
  })

  it('starts empty for the session and returns the same reference for foreign events', () => {
    const initial = mayflyWorkflowProjectionDefinition.init('session-1' as never, { id: 'session-1' } as never)
    expect(initial.runs).toEqual([])
    expect(fold(initial, event('user/message', {}))).toBe(initial)
  })

  it('assembles a run with its agents, phases, and outcomes', () => {
    const state = run([
      event('tool-workflow/run-start', { runId: 'r1', name: 'deploy' }, 10),
      // Agents append in event order here; mergeRun is what re-sorts by seq.
      event('tool-workflow/agent-start', { runId: 'r1', seq: 1, label: 'lint', phase: 'check', childId: 'child-1' }, 11),
      event('tool-workflow/agent-start', { runId: 'r1', seq: 2, label: 'build', phase: 'compile', childId: 'child-2' }, 12),
      event('tool-workflow/agent-end', { runId: 'r1', seq: 1, outcome: 'completed' }, 13),
      event('tool-workflow/run-end', { runId: 'r1', stopReason: 'completed' }, 20),
    ])
    const theRun = (state.runs as unknown[])[0] as Record<string, unknown>
    expect(theRun).toMatchObject({ id: 'r1', name: 'deploy', stopReason: 'completed', endedAt: 20 })
    expect(theRun.phasesSeen).toEqual(['check', 'compile'])
    expect((theRun.agents as { seq: number, outcome?: string }[]).map(agent => [agent.seq, agent.outcome]))
      .toEqual([[1, 'completed'], [2, undefined]])
  })

  it('ignores a duplicate run start and replaces an agent by seq', () => {
    const state = run([
      event('tool-workflow/run-start', { runId: 'r1', name: 'first' }, 10),
      event('tool-workflow/run-start', { runId: 'r1', name: 'second' }, 11),
      event('tool-workflow/agent-start', { runId: 'r1', seq: 1, label: 'v1', childId: 'c1' }, 12),
      event('tool-workflow/agent-start', { runId: 'r1', seq: 1, label: 'v2', childId: 'c1' }, 13),
    ])
    const theRun = (state.runs as unknown[])[0] as { name: string, agents: { label: string }[] }
    expect(state.runs).toHaveLength(1)
    expect(theRun.name).toBe('first')
    expect(theRun.agents).toEqual([{ seq: 1, label: 'v2', childId: 'c1' }])
  })

  it('interrupts open runs on an interrupted turn, a fork, and a session end-seed', () => {
    for (const trigger of [
      event('turn/end', { reason: { kind: 'interrupted' } }, 30),
      event('turn/end', { reason: { kind: 'forked' } }, 30),
      event('session/end-seed', {}, 30),
    ]) {
      const state = run([
        event('tool-workflow/run-start', { runId: 'r1', name: 'deploy' }, 10),
        event('tool-workflow/agent-start', { runId: 'r1', seq: 1, label: 'lint', childId: 'c1' }, 11),
        trigger,
      ])
      const theRun = (state.runs as unknown[])[0] as { interrupted?: boolean, endedAt?: number, agents: { interrupted?: boolean }[] }
      expect(theRun.interrupted).toBe(true)
      expect(theRun.endedAt).toBe(30)
      expect(theRun.agents[0]?.interrupted).toBe(true)
    }
  })

  it('clears every settled or interrupted run at the next turn start, once it has been over for ten seconds', () => {
    const settled = [
      event('tool-workflow/run-start', { runId: 'open', name: 'a' }, 10),
      event('turn/end', { reason: { kind: 'interrupted' } }, 20),
      event('tool-workflow/run-start', { runId: 'done', name: 'b' }, 21),
      event('tool-workflow/run-end', { runId: 'done', stopReason: 'completed' }, 22),
    ]
    // A new turn is a clean panel: both the interrupted run and the settled
    // one are gone, and a still-open run would be the only survivor.
    expect(run([...settled, event('turn/start', { turn: 2 }, 10_022)]).runs).toEqual([])
    // A turn that starts right away, as a killed background run's notice does, leaves the view its hold.
    expect(run([...settled, event('turn/start', { turn: 2 }, 23)]).runs.map(each => (each as { readonly id: string }).id)).toEqual(['open', 'done'])
    expect(run([...settled, event('turn/start', { turn: 2 }, 10_020)]).runs.map(each => (each as { readonly id: string }).id)).toEqual(['done'])
    const unended = { sessionId: 's', runs: [{ id: 'old', name: 'old', phasesSeen: [], agents: [], startedAt: 1, stopReason: 'completed' }] }
    expect(mayflyWorkflowProjectionDefinition.apply(unended as never, event('turn/start', { turn: 2 }, 10_022) as never).runs).toEqual([])
  })
})

describe('WorkflowLiveCatalog', () => {
  it('attributes a live run to the parent session through an agent start', () => {
    const { ctx, catalog, fire, session } = catalogHarness()
    fire('workflow/start', info('r1'))
    fire('workflow/agent-start', info('r1'), { seq: 1, label: 'lint', childId: 'child-1' })
    const snapshot = catalog.snapshot(ctx, session)
    expect(snapshot.runs).toHaveLength(1)
    expect(snapshot.runs[0]).toMatchObject({ id: 'r1', name: 'deploy', agents: [{ seq: 1, label: 'lint', childId: 'child-1' }] })
  })

  it('settles a live run from the native end event', () => {
    const { ctx, catalog, fire, session } = catalogHarness()
    fire('workflow/start', info('r1'))
    fire('workflow/agent-start', info('r1'), { seq: 1, label: 'lint', childId: 'child-1' })
    fire('workflow/end', info('r1'), { stopReason: 'completed', agentsStarted: 3 })
    const theRun = catalog.snapshot(ctx, session).runs[0]!
    expect(theRun).toMatchObject({ stopReason: 'completed', agentsStarted: 3 })
  })

  it('attributes through durable session events too and reports affectedness', () => {
    const { ctx, catalog, fire, session } = catalogHarness()
    fire('session/event', session, event('tool-workflow/run-start', { runId: 'r9', name: 'durable' }, 10))
    expect(catalog.affects(ctx, session, 'r9')).toBe(true)
    expect(catalog.affects(ctx, session, 'other')).toBe(false)
  })

  it('merges the durable baseline with live metadata, live phases winning', () => {
    const { ctx, catalog, fire, session } = catalogHarness()
    // A durable baseline run with no phase list.
    const durable = { sessionId: 'session-1', runs: [{ id: 'r1', name: 'deploy', phasesSeen: [], agents: [], startedAt: 5 }] }
    ;(ctx as unknown as { sessionProjections: { snapshot(target: Session, keys: readonly string[]): { values: Record<string, unknown> } } })
      .sessionProjections.snapshot = (_target, keys): { values: Record<string, unknown> } => ({
        values: Object.fromEntries(keys.map(key => [key, key === 'mayflyWorkflow' ? durable : undefined])),
      })
    fire('workflow/start', { id: 'r1', meta: { name: 'deploy', phases: [{ title: 'build' }] } })
    const merged = catalog.snapshot(ctx, session).runs[0]!
    // The durable startedAt anchors ordering; the live phases describe the plan.
    expect(merged.startedAt).toBe(5)
    expect(merged.phases).toEqual([{ title: 'build' }])
  })
})

describe('followWorkflow', () => {
  /** A full harness with a resolvable agent and the catalog wired. */
  function streamHarness(): { ctx: Context; catalog: WorkflowLiveCatalog; session: Session } {
    const base = catalogHarness()
    const agent = { id: 'session-1', session: base.session }
    const ctx = {
      ...base.ctx,
      agents: { get: (): unknown => agent },
      sessions: { get: (id: string): unknown => id === 'session-1' ? base.session : (base.ctx as unknown as { sessions: { get(id: string): unknown } }).sessions.get(id) },
      sessionController: { resolveAgent: async (): Promise<never> => { throw new Error('unexpected') } },
    } as unknown as Context
    return { ctx, catalog: base.catalog, session: base.session }
  }

  it('yields one baseline frame then a replacement only when the snapshot changes', async () => {
    const { ctx, catalog, session } = streamHarness()
    const stream = followWorkflow(ctx, catalog, 'session-1' as never, new AbortController().signal)
    const iterator = stream[Symbol.asyncIterator]()
    const baseline = await iterator.next()
    expect(baseline.value).toMatchObject({ type: 'baseline' })
    void session
    await iterator.return?.(undefined as never)
  })

  it('fails with the stale code when the exact Agent is disposed mid-stream', async () => {
    const base = catalogHarness()
    const disposed: ((payload: { agent: unknown }) => void)[] = []
    const agent = { id: 'session-1', session: base.session }
    const ctx = {
      on: (name: string, listener: (payload: { agent: unknown }) => void): (() => void) => {
        if (name === 'agent/disposed') disposed.push(listener)
        return () => {}
      },
      agents: { get: (): unknown => agent },
      sessions: { get: (id: string): unknown => id === 'session-1' ? base.session : (base.ctx as unknown as { sessions: { get(id: string): unknown } }).sessions.get(id) },
      sessionController: { resolveAgent: async (): Promise<never> => { throw new Error('unexpected') } },
      sessionProjections: (base.ctx as unknown as { sessionProjections: unknown }).sessionProjections,
    } as unknown as Context
    const stream = followWorkflow(ctx, base.catalog, 'session-1' as never, new AbortController().signal)
    const iterator = stream[Symbol.asyncIterator]()
    await iterator.next()
    for (const listener of disposed.splice(0)) listener({ agent })
    // A failed queue makes the generator throw the error to its consumer.
    await expect(iterator.next()).rejects.toMatchObject({ code: 'mayflyHost/session-stale' })
  })
})
