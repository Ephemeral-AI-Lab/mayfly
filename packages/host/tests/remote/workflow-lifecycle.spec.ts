/** Native Workflow projection replay, live metadata, replacement streams and retirement. @module */
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionStore, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type { WorkflowRunInfo } from '@deepseek-ai/dsh-workflow'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MayflyWorkflowSnapshot } from '../../src/types.ts'
import { followWorkflow, mayflyWorkflowProjectionDefinition as definition, mayflyWorkflowSnapshotSchema, WorkflowLiveCatalog } from '../../src/remote/workflow.ts'
import { expectFrozenJson } from './frozen-frame.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

function event(type: string, data: object, time = 1): SessionEvent {
  return { type, data, time, seq: 0 } as SessionEvent
}

function initial(): MayflyWorkflowSnapshot {
  return definition.init({ version: SESSION_FORMAT_VERSION, id: SessionId('parent'), createdAt: 0, isSeeded: false }, SessionLogOffset(0))
}

function replay(events: readonly SessionEvent[]): MayflyWorkflowSnapshot {
  return events.reduce((state, item) => definition.apply(state, item), initial())
}

function info(id: string, phases?: readonly { title: string }[]): WorkflowRunInfo {
  return { id, meta: { name: id, ...phases === undefined ? {} : { phases } } } as WorkflowRunInfo
}

async function harness(): Promise<{
  ctx: Context
  parent: Session
  foreign: Session
  child: Session
  catalog: WorkflowLiveCatalog
  agent: { id: SessionId, session: Session }
  replaceAgent(): void
}> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.sessionProjections.register(definition)
  const parent = ctx.sessions.create(SessionId('parent'))
  const foreign = ctx.sessions.create(SessionId('foreign'))
  const child = ctx.sessions.create(SessionId('child'), { meta: { parentSession: parent.id, origin: 'subagent' } })
  const agent = { id: parent.id, session: parent }
  let current = agent
  Object.defineProperty(ctx, 'agents', { value: { get: (id: SessionId) => id === parent.id ? current : undefined } })
  const catalog = new WorkflowLiveCatalog(ctx)
  return { ctx, parent, foreign, child, catalog, agent, replaceAgent: () => { current = { ...agent } } }
}

describe('durable Workflow lifecycle', () => {
  it('validates phase metadata instead of allowing renderer or malformed values into the wire', () => {
    const snapshot = { sessionId: 'parent', runs: [{ id: 'r', name: 'r', phasesSeen: [], agents: [], startedAt: 1 }] }
    for (const phase of [null, [], 1, {}, { title: 1 }, { title: 'p', detail: 1 }, { title: 'p', provider: 1 }, { title: 'p', model: 1 }]) {
      expect(mayflyWorkflowSnapshotSchema.safeParse({ ...snapshot, runs: [{ ...snapshot.runs[0], phases: [phase] }] }).success).toBe(false)
    }
    const valid = { ...snapshot, runs: [{ ...snapshot.runs[0], phases: [{ title: 'p' }, { title: 'q', detail: 'd', provider: 'a', model: 'b' }] }] }
    const parsed = mayflyWorkflowSnapshotSchema.parse(valid)
    expect(parsed).toEqual(valid)
    expect(parsed.runs[0]!.phases![0]).not.toBe(valid.runs[0]!.phases[0])
    valid.runs[0]!.phases[0]!.title = 'producer changed'
    expect(parsed.runs[0]!.phases![0]!.title).toBe('p')
    const extended = { ...snapshot, runs: [{ ...snapshot.runs[0], phases: [{ title: 'p', renderer: () => 'private' }] }] }
    expect(mayflyWorkflowSnapshotSchema.parse(extended).runs[0]!.phases).toEqual([{ title: 'p' }])
    expect(definition.wire.view(initial())).toEqual(initial())
  })

  it('retains active runs across ordinary turns and ignores late events for unknown runs', () => {
    let state = replay([event('tool-workflow/run-start', { runId: 'r', name: 'r' })])
    for (const trigger of [event('turn/start', {}), event('turn/end', { reason: { kind: 'completed' } }),
      event('tool-workflow/agent-start', { runId: 'missing', seq: 1, childId: 'child', label: 'late' }),
      event('tool-workflow/agent-end', { runId: 'missing', seq: 1, outcome: 'completed' }),
      event('tool-workflow/run-end', { runId: 'missing', stopReason: 'completed' })]) {
      const next = definition.apply(state, trigger)
      expect(next).toBe(state)
      state = next
    }
  })

  it('keeps settled agents and clears interruption only when the exact late outcome arrives', () => {
    let state = replay([
      event('tool-workflow/run-start', { runId: 'r', name: 'r' }),
      event('tool-workflow/agent-start', { runId: 'r', seq: 1, childId: 'child', label: 'a', phase: 'p' }),
      event('tool-workflow/agent-start', { runId: 'r', seq: 2, childId: 'child', label: 'b', phase: 'p' }),
      event('tool-workflow/agent-end', { runId: 'r', seq: 2, outcome: 'completed' }),
      event('tool-workflow/run-start', { runId: 'done', name: 'done' }),
      event('tool-workflow/run-end', { runId: 'done', stopReason: 'completed' }),
      event('turn/end', { reason: { kind: 'interrupted' } }, 20),
    ])
    expect(state.runs[0]!.phasesSeen).toEqual(['p'])
    expect(state.runs[0]!.agents).toMatchObject([{ seq: 1, interrupted: true }, { seq: 2, outcome: 'completed' }])
    expect(definition.apply(state, event('session/end-seed', {}, 21))).toBe(state)
    state = definition.apply(state, event('tool-workflow/agent-end', { runId: 'r', seq: 1, outcome: 'cancelled' }))
    state = definition.apply(state, event('tool-workflow/run-end', { runId: 'r', stopReason: 'cancelled' }, 22))
    expect(state.runs[0]!.interrupted).toBeUndefined()
    expect(state.runs[0]!.agents.every(agent => agent.interrupted === undefined)).toBe(true)
  })
})

describe('native Workflow live catalog', () => {
  it('tracks phases and exact child attribution, protects settled outcomes and retires only this parent', async () => {
    const { ctx, parent, foreign, child, catalog } = await harness()
    const notices: (string | undefined)[] = []
    const off = catalog.subscribe(id => { notices.push(id) })
    const warning = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const offThrow = catalog.subscribe(() => { throw new Error('consumer failed') })
    ctx.emit('workflow/phase', info('r'), 'plan')
    ctx.emit('workflow/phase', info('r'), 'plan')
    ctx.emit('workflow/agent-start', info('r'), { seq: 2, childId: child.id, label: 'b', phase: 'build' } as never)
    ctx.emit('workflow/agent-start', info('r'), { seq: 1, childId: child.id, label: 'a' } as never)
    ctx.emit('workflow/agent-start', info('r'), { seq: 1, childId: SessionId('not-resident'), label: 'replacement', phase: 'build' } as never)
    ctx.emit('workflow/agent-end', info('r'), { seq: 2, childId: child.id, outcome: 'completed' } as never)
    ctx.emit('workflow/agent-end', info('r'), { seq: 99, childId: SessionId('not-resident'), outcome: 'failed' } as never)
    ctx.emit('workflow/start', info('unattributed'))
    ctx.emit('workflow/agent-start', info('unattributed'), { seq: 1, childId: SessionId('unknown'), label: 'external' } as never)
    ctx.emit('workflow/start', info('settled'))
    parent.append('tool-workflow/run-start', { runId: 'settled' as never, name: 'settled' })
    ctx.emit('workflow/end', info('settled'), { stopReason: 'completed', agentsStarted: 0 } as never)
    parent.append('tool-workflow/run-end', { runId: 'settled' as never, stopReason: 'completed' })
    foreign.append('turn/end', { turn: 0, reason: { kind: 'interrupted' } })
    expect(catalog.snapshot(ctx, parent).runs.find(run => run.id === 'r')!.interrupted).toBeUndefined()
    parent.append('turn/end', { turn: 0, reason: { kind: 'completed' } } as never)
    parent.append('turn/end', { turn: 0, reason: { kind: 'forked' } })
    parent.append('session/end-seed', {} as never)
    const run = catalog.snapshot(ctx, parent).runs.find(row => row.id === 'r')!
    expect(run).toMatchObject({ phasesSeen: ['plan', 'build'], currentPhase: 'build', interrupted: true, endedAt: expect.any(Number) })
    expect(run.agents).toEqual([{ seq: 1, childId: 'not-resident', label: 'replacement', phase: 'build', interrupted: true }, { seq: 2, childId: 'child', label: 'b', phase: 'build', outcome: 'completed' }])
    expect(catalog.snapshot(ctx, parent).runs.some(row => row.id === 'unattributed')).toBe(false)
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('consumer failed'))
    offThrow()
    off()
    const count = notices.length
    parent.append('turn/start', { turn: 1 })
    expect(catalog.snapshot(ctx, parent).runs).toEqual([])
    expect(notices).toHaveLength(count)
  })

  it('attributes durable agent and end events and merges baselines with live outcomes and metadata', async () => {
    const { ctx, parent, child, catalog } = await harness()
    parent.append('tool-workflow/run-start', { runId: 'r' as never, name: 'durable' })
    parent.append('tool-workflow/agent-start', { runId: 'r' as never, seq: 1, label: 'a', childId: child.id, phase: 'initial' })
    parent.append('tool-workflow/agent-start', { runId: 'r' as never, seq: 3, label: 'c', childId: child.id })
    parent.append('tool-workflow/agent-end', { runId: 'r' as never, seq: 3, outcome: 'failed' })
    ctx.emit('workflow/start', info('r', [{ title: 'initial' }, { title: 'finish' }]))
    ctx.emit('workflow/agent-start', info('r'), { seq: 1, childId: child.id, label: 'live a' } as never)
    ctx.emit('workflow/agent-start', info('r'), { seq: 2, childId: child.id, label: 'live b' } as never)
    ctx.emit('workflow/agent-start', info('r'), { seq: 3, childId: child.id, label: 'live c' } as never)
    expect(catalog.snapshot(ctx, parent).runs[0]!.currentPhase).toBe('initial')
    ctx.emit('workflow/agent-end', info('r'), { seq: 1, childId: child.id, outcome: 'completed' } as never)
    ctx.emit('workflow/phase', info('r'), 'finish')
    parent.append('turn/end', { turn: 0, reason: { kind: 'interrupted' } })
    const merged = catalog.snapshot(ctx, parent).runs[0]!
    expect(merged).toMatchObject({ name: 'durable', phases: [{ title: 'initial' }, { title: 'finish' }], phasesSeen: ['initial', 'finish'], currentPhase: 'finish' })
    expect(merged.agents).toMatchObject([{ seq: 1, outcome: 'completed' }, { seq: 2, interrupted: true }, { seq: 3, outcome: 'failed' }])
    expect(merged.agents[0]!.interrupted).toBeUndefined()
    expect(merged.agents[2]!.interrupted).toBeUndefined()
    ctx.emit('workflow/end', info('r'), { stopReason: 'cancelled', agentsStarted: 3 } as never)
    parent.append('tool-workflow/run-end', { runId: 'r' as never, stopReason: 'completed' })
    const settled = catalog.snapshot(ctx, parent).runs[0]!
    expect(settled).toMatchObject({ stopReason: 'completed', agentsStarted: 3 })
    expect(settled.interrupted).toBeUndefined()
    parent.append('tool-workflow/agent-end', { runId: 'late-agent' as never, seq: 1, outcome: 'failed' })
    parent.append('tool-workflow/agent-start', { runId: 'late-start' as never, seq: 1, label: 'late', childId: child.id })
    parent.append('tool-workflow/run-end', { runId: 'late-end' as never, stopReason: 'error' })
    expect(catalog.affects(ctx, parent, 'late-agent')).toBe(true)
    expect(catalog.affects(ctx, parent, 'late-start')).toBe(true)
    expect(catalog.affects(ctx, parent, 'late-end')).toBe(true)
    const restoredCatalog = new WorkflowLiveCatalog(ctx)
    expect(restoredCatalog.affects(ctx, parent, 'r')).toBe(true)
    expect(restoredCatalog.affects(ctx, parent, 'missing')).toBe(false)
  })
})

describe('native Workflow replacement stream', () => {
  it('detaches native phase metadata before enqueue without freezing the producer', async () => {
    const { ctx, parent, catalog } = await harness()
    parent.append('tool-workflow/run-start', { runId: 'r' as never, name: 'r' })
    const iterator = followWorkflow(ctx, catalog, parent.id, new AbortController().signal)[Symbol.asyncIterator]()
    await iterator.next()
    const phases = [{ title: 'initial' }]
    ctx.emit('workflow/start', info('r', phases))
    expect(Object.isFrozen(phases)).toBe(false)
    expect(Object.isFrozen(phases[0])).toBe(false)
    phases[0]!.title = 'native producer changed after enqueue'
    phases.push({ title: 'late phase' })
    const replacement = (await iterator.next()).value
    expect(replacement).toMatchObject({ type: 'replacement', value: { runs: [{ phases: [{ title: 'initial' }] }] } })
    expectFrozenJson(replacement)
    await iterator.return?.(undefined as never)
  })

  it('filters foreign changes, deduplicates equal snapshots and cleans listeners on caller abort', async () => {
    const { ctx, parent, foreign, child, catalog, agent } = await harness()
    const control = new AbortController()
    const iterator = followWorkflow(ctx, catalog, parent.id, control.signal)[Symbol.asyncIterator]()
    const baseline = (await iterator.next()).value
    expect(baseline).toMatchObject({ type: 'baseline', value: { runs: [] } })
    expectFrozenJson(baseline)
    ctx.emit('workflow/start', info('unrelated'))
    foreign.append('tool-workflow/run-start', { runId: 'foreign' as never, name: 'foreign' })
    ctx.emit('agent/disposed', { agent: { ...agent } } as never)
    ctx.emit('session/event', parent, event('user/message', {}))
    const pending = iterator.next()
    parent.append('tool-workflow/run-start', { runId: 'r' as never, name: 'r' })
    const replacement = (await pending).value
    expect(replacement).toMatchObject({ type: 'replacement', value: { runs: [{ id: 'r' }] } })
    expectFrozenJson(replacement)
    parent.append('turn/start', { turn: 1 })
    const native = { seq: 1, childId: child.id, label: 'a' }
    ctx.emit('workflow/agent-start', info('r'), native as never)
    native.label = 'mutated after enqueue'
    const agentFrame = (await iterator.next()).value
    expect(agentFrame).toMatchObject({ type: 'replacement', value: { runs: [{ agents: [{ seq: 1, label: 'a' }] }] } })
    expectFrozenJson(agentFrame)
    expect(Object.isFrozen(native)).toBe(false)
    const waiting = iterator.next()
    control.abort(new Error('caller closed'))
    await expect(waiting).rejects.toThrow('caller closed')
    const snapshot = vi.spyOn(catalog, 'snapshot')
    ctx.emit('workflow/phase', info('r'), 'after close')
    parent.append('tool-workflow/run-end', { runId: 'r' as never, stopReason: 'completed' })
    expect(snapshot).not.toHaveBeenCalled()
  })

  it('fails stale when a replacement Agent appears before the next live update', async () => {
    const { ctx, parent, catalog, replaceAgent } = await harness()
    const iterator = followWorkflow(ctx, catalog, parent.id, new AbortController().signal)[Symbol.asyncIterator]()
    await iterator.next()
    replaceAgent()
    parent.append('tool-workflow/run-start', { runId: 'r' as never, name: 'r' })
    await expect(iterator.next()).rejects.toMatchObject({ code: 'mayflyHost/session-stale' })
  })
})
