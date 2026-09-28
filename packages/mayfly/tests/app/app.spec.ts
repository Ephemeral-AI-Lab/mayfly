/** Direct-service Mayfly app coordinator tests.
 * @module @ephemeral-ai/mayfly/app/tests/app
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { apply, Config, internals } from '../../src/app/index.ts'
import { MayflyCurrentAgentService } from '../../src/app/current-agent.ts'
import { conversationId, MAX_SIDE_CONVERSATIONS, MayflyConversationsService } from '../../src/app/conversation-views.ts'
import { armExitEpitaph, armedEpitaph } from '../../src/app/exit-epitaph.ts'

const originalStderr = internals.stderr

afterEach(() => {
  internals.stderr = originalStderr
  armExitEpitaph(undefined)
  vi.restoreAllMocks()
})

interface FakeSession {
  readonly id: ReturnType<typeof SessionId>
  readonly events: unknown[]
  readonly seq: number
  snapshotEvents(): readonly unknown[]
  readonly header: { readonly cwd?: string }
  readonly surface: { readonly nodes: readonly number[] }
  requestHeader(): undefined
}

interface FakeAgent extends Agent {
  readonly session: FakeSession
  readonly followup: ReturnType<typeof vi.fn>
  readonly cancel: ReturnType<typeof vi.fn>
}

function fakeAgent(id: string, events: unknown[] = []): FakeAgent {
  const session: FakeSession = {
    id: SessionId(id),
    events,
    get seq() { return events.length },
    snapshotEvents: () => events,
    header: {},
    surface: { nodes: [] },
    requestHeader: () => undefined,
  }
  return {
    id: session.id,
    session,
    status: 'idle',
    options: {},
    followup: vi.fn(),
    cancel: vi.fn(),
  } as unknown as FakeAgent
}

interface Bench {
  readonly ctx: Context
  readonly live: Map<string, FakeAgent>
  readonly created: Array<{ cwd?: string }>
  readonly resolved: string[]
  readonly forked: Array<{ sessionId: unknown, atSeq?: number }>
  readonly exits: number[]
  readonly errors: () => string
  readonly controller: {
    create: ReturnType<typeof vi.fn>
    resolveAgent: ReturnType<typeof vi.fn>
    fork: ReturnType<typeof vi.fn>
  }
  failCreate(error: unknown): void
  failResolve(id: string, error: unknown): void
  failFork(error: unknown): void
}

function bench(config: Config = {}, options: {
  readonly resumeAgent?: FakeAgent
  readonly loader?: Promise<void>
  readonly appExit?: boolean
} = {}): Bench {
  const ctx = new Context()
  const live = new Map<string, FakeAgent>()
  const created: Array<{ cwd?: string }> = []
  const resolved: string[] = []
  const forked: Array<{ sessionId: unknown, atSeq?: number }> = []
  const exits: number[] = []
  const resolveErrors = new Map<string, unknown>()
  let createError: unknown
  let forkError: unknown
  let sequence = 0
  let errors = ''
  internals.stderr = { write(chunk: string) { errors += chunk; return true } }

  if (options.appExit !== false) ctx.provide('appExit', (code: number) => { exits.push(code) })
  if (options.loader !== undefined) ctx.provide('loader', { await: () => options.loader } as never)
  if (options.resumeAgent !== undefined) live.set(String(options.resumeAgent.id), options.resumeAgent)
  ctx.provide('agents', {
    get: (id: unknown) => live.get(String(id)),
    list: () => [...live.values()],
  } as never)
  ctx.provide('subagents', { interrupt: vi.fn(), interruptByParent: vi.fn() } as never)

  const create = vi.fn(async (input: { cwd?: string }) => {
    if (createError !== undefined) throw createError
    created.push(input)
    const agent = fakeAgent(`created-${String(++sequence)}`)
    live.set(String(agent.id), agent)
    return { sessionId: agent.id }
  })
  const resolveAgent = vi.fn(async (id: unknown) => {
    const key = String(id)
    resolved.push(key)
    const error = resolveErrors.get(key)
    if (error !== undefined) return { error }
    const agent = live.get(key)
    return agent === undefined ? { error: new Error(`unknown session ${key}`) } : { agent }
  })
  const fork = vi.fn(async (input: { sessionId: unknown, atSeq?: number }) => {
    if (forkError !== undefined) throw forkError
    forked.push(input)
    const agent = fakeAgent(`forked-${String(++sequence)}`)
    live.set(String(agent.id), agent)
    return { sessionId: agent.id }
  })
  const controller = { create, resolveAgent, fork }
  ctx.provide('sessionController', controller as never)
  ctx.provide('mayflyScreen', {} as never)
  apply(ctx, config)
  return {
    ctx,
    live,
    created,
    resolved,
    forked,
    exits,
    errors: () => errors,
    controller,
    failCreate(error) { createError = error },
    failResolve(id, error) { resolveErrors.set(id, error) },
    failFork(error) { forkError = error },
  }
}

async function waitForAgent(test: Bench, id?: string): Promise<FakeAgent> {
  await vi.waitFor(() => {
    const current = test.ctx.mayflyCurrentAgent.current()
    expect(current).not.toBeNull()
    if (id !== undefined) expect(String(current?.id)).toBe(id)
  })
  return test.ctx.mayflyCurrentAgent.current() as FakeAgent
}

describe('mayfly app driver', () => {
  it('keeps launch config optional and rejects a missing appExit hook', () => {
    expect(Config({})).toEqual({})
    expect(() => bench({}, { appExit: false })).toThrow('must provide ctx.appExit')
  })

  it('waits for Loader, creates through sessionController, selects, and sends a task', async () => {
    const gate = Promise.withResolvers<void>()
    const test = bench({ task: 'fix the build' }, { loader: gate.promise })
    await Promise.resolve()
    expect(test.controller.create).not.toHaveBeenCalled()
    gate.resolve()
    const agent = await waitForAgent(test)
    expect(test.created).toEqual([{ cwd: process.cwd() }])
    expect(test.resolved).toEqual([String(agent.id)])
    expect(agent.followup).toHaveBeenCalledOnce()
    expect(agent.followup.mock.calls[0]?.[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'fix the build' }],
    })
    expect(test.ctx.mayflyRequests.active()).toMatchObject({ scope: 'main', sessionEpoch: 1 })
  })

  it('leaves followup idle when startup has no task', async () => {
    const test = bench()
    const agent = await waitForAgent(test)
    expect(agent.followup).not.toHaveBeenCalled()
  })

  it('resumes directly and exits loud for Error and non-Error startup failures', async () => {
    const resumed = fakeAgent('resume-me')
    const success = bench({ resume: 'resume-me' }, { resumeAgent: resumed })
    expect(await waitForAgent(success, 'resume-me')).toBe(resumed)
    expect(success.created).toEqual([])

    const failed = bench({ resume: 'missing' })
    failed.failResolve('missing', new Error('store offline'))
    await vi.waitFor(() => { expect(failed.exits).toEqual([1]) })
    expect(failed.errors()).toContain('dsh: store offline')

    const createFailed = bench()
    createFailed.failCreate('bare create failure')
    await vi.waitFor(() => { expect(createFailed.exits).toEqual([1]) })
    expect(createFailed.errors()).toContain('dsh: bare create failure')
  })

  it('maps current-session turn endings onto the active request lifecycle', async () => {
    const test = bench()
    const agent = await waitForAgent(test)
    const states: string[] = []
    test.ctx.on('mayfly/request-state-changed', lifecycle => { states.push(lifecycle.state) })
    for (const reason of ['completed', 'error', 'aborted', 'interrupted'] as const) {
      test.ctx.mayflyRequests.begin()
      test.ctx.emit('session/event', agent.session as never, {
        type: 'turn/end', seq: 1, time: 1, data: { turn: 0, reason: { kind: reason } },
      } as never)
    }
    expect(states).toEqual([
      'started', 'completed',
      'started', 'failed',
      'started', 'interrupted',
      'started', 'interrupted',
    ])

    const before = [...states]
    test.ctx.emit('session/event', fakeAgent('foreign').session as never, { type: 'turn/end', data: { reason: { kind: 'completed' } } } as never)
    test.ctx.emit('session/event', agent.session as never, {
      type: 'user/message',
      data: { source: { kind: 'user' } },
    } as never)
    test.ctx.emit('session/event', agent.session as never, { type: 'turn/end', data: { reason: { kind: 'completed' } } } as never)
    expect(states).toEqual(before)
  })

  it('retires the stop latch when the current session ends or its tree settles', async () => {
    const test = bench()
    const agent = await waitForAgent(test)
    const stops: boolean[] = []
    test.ctx.on('mayfly/request-stop-changed', pending => { stops.push(pending) })

    // A status edge with no latched stop never walks the tree.
    test.ctx.emit('agent/status', { agent, status: 'idle' })
    expect(stops).toEqual([])

    test.ctx.mayflyRequests.requestStop()
    expect(test.ctx.mayflyRequests.stopPending()).toBe(true)
    test.ctx.emit('session/event', agent.session as never, {
      type: 'turn/end', seq: 1, time: 1, data: { turn: 0, reason: { kind: 'interrupted' } },
    } as never)
    expect(test.ctx.mayflyRequests.stopPending()).toBe(false)

    // A descendant-only interrupt (the selected Agent already idle) settles
    // through the child's own status edge, not the selected session's.
    const child = fakeAgent('draining-child')
    ;(child.session as { header: { parentSession?: unknown } }).header.parentSession = agent.id
    ;(child as { status: string }).status = 'running'
    test.live.set(String(child.id), child)
    test.ctx.mayflyRequests.requestStop()
    expect(stops).toEqual([true, false, true])
    test.ctx.emit('agent/status', { agent: child, status: 'running' })
    expect(test.ctx.mayflyRequests.stopPending()).toBe(true)
    ;(child as { status: string }).status = 'idle'
    test.ctx.emit('agent/status', { agent: child, status: 'idle' })
    expect(test.ctx.mayflyRequests.stopPending()).toBe(false)
  })

  it('serializes resume and new navigation while keeping failures non-fatal', async () => {
    const target = fakeAgent('target')
    const test = bench({}, { resumeAgent: target })
    const initial = await waitForAgent(test)
    test.ctx.emit('mayfly/request-resume', 'target')
    expect(await waitForAgent(test, 'target')).toBe(target)

    test.failResolve('broken', 'raw resume failure')
    test.ctx.emit('mayfly/request-resume', 'broken')
    await vi.waitFor(() => { expect(test.errors()).toContain('could not resume session broken: raw resume failure') })
    expect(test.ctx.mayflyCurrentAgent.current()).toBe(target)

    test.ctx.emit('mayfly/request-new')
    await vi.waitFor(() => { expect(test.ctx.mayflyCurrentAgent.current()).not.toBe(target) })
    const fresh = test.ctx.mayflyCurrentAgent.current() as FakeAgent
    expect(fresh).not.toBe(initial)
    test.failCreate(new Error('create unavailable'))
    test.ctx.emit('mayfly/request-new')
    await vi.waitFor(() => { expect(test.errors()).toContain('could not start a new session: create unavailable') })
    expect(test.ctx.mayflyCurrentAgent.current()).toBe(fresh)
  })

  it('carries a requested agent preset into session.create', async () => {
    const test = bench()
    await waitForAgent(test)
    expect(test.created).toEqual([{ cwd: process.cwd() }])
    test.ctx.emit('mayfly/request-new', 'minimal')
    await vi.waitFor(() => { expect(test.created.length).toBe(2) })
    expect(test.created[1]).toEqual({ cwd: process.cwd(), agentPreset: 'minimal' })
  })

  it('forks and rewinds through the native controller and reports every guard', async () => {
    const test = bench()
    const parent = await waitForAgent(test)
    test.ctx.emit('mayfly/request-fork')
    await vi.waitFor(() => { expect(test.ctx.mayflyCurrentAgent.current()).not.toBe(parent) })
    const child = test.ctx.mayflyCurrentAgent.current() as FakeAgent
    expect(test.forked[0]).toEqual({ sessionId: parent.id })

    test.ctx.emit('mayfly/request-rewind', 'stale', 7)
    await vi.waitFor(() => { expect(test.errors()).toContain('rewind request is stale for session stale') })
    test.ctx.emit('mayfly/request-rewind', String(child.id), 7)
    await vi.waitFor(() => { expect(test.forked.at(-1)).toEqual({ sessionId: child.id, atSeq: 7 }) })
    expect(test.forked.at(-1)).toEqual({ sessionId: child.id, atSeq: 7 })

    test.failFork('fork service failed')
    const current = test.ctx.mayflyCurrentAgent.current()!
    test.ctx.emit('mayfly/request-fork')
    await vi.waitFor(() => { expect(test.errors()).toContain(`could not fork session ${String(current.id)}: fork service failed`) })
    test.ctx.emit('mayfly/request-rewind', String(current.id), 9)
    await vi.waitFor(() => { expect(test.errors()).toContain(`could not rewind session ${String(current.id)}: fork service failed`) })

    test.ctx.mayflyConversations.selectPrimary(null)
    test.ctx.emit('mayfly/request-fork')
    test.ctx.emit('mayfly/request-rewind', 'none', 1)
    await vi.waitFor(() => {
      expect(test.errors()).toContain('no live session to fork')
      expect(test.errors()).toContain('rewind request is stale for session none')
    })
  })

  it('contains an unexpected queued failure and continues later operations', async () => {
    const test = bench()
    await waitForAgent(test)
    const get = test.ctx.agents.get
    vi.spyOn(test.ctx.agents, 'get').mockImplementationOnce(() => { throw new Error('registry exploded') }).mockImplementation(get)
    test.ctx.emit('mayfly/request-fork')
    await vi.waitFor(() => { expect(test.errors()).toContain('dsh: registry exploded') })
    test.ctx.emit('mayfly/request-new')
    await vi.waitFor(() => { expect(test.created.length).toBeGreaterThan(1) })
  })

  it('arms the latest selected non-empty session on disposal', async () => {
    const test = bench()
    const agent = await waitForAgent(test)
    agent.session.events.push({ type: 'user/message' })
    await test.ctx.fiber.dispose()
    expect(armedEpitaph()).toContain(`--resume ${String(agent.id)}`)

    const empty = bench()
    await waitForAgent(empty)
    await empty.ctx.fiber.dispose()
    expect(armedEpitaph()).toBeUndefined()
  })

  it('routes retraction persistence diagnostics through the app error sink', async () => {
    const test = bench()
    const agent = await waitForAgent(test)
    Object.assign(agent, { status: 'running' })
    const events = agent.session.events as Array<Record<string, unknown>>
    events.push(
      { type: 'turn/start', seq: 0, data: { turn: 1 } },
      { type: 'user/message', seq: 1, data: { id: 'message-1', source: { kind: 'user' } } },
    )
    Object.defineProperty(agent.session, 'surface', { value: { nodes: [1] } })
    Object.defineProperty(agent.session, 'append', { value: () => { throw new Error('append unavailable') } })
    test.ctx.mayflyRequests.begin('main')
    expect(test.ctx.mayflyRetractions.tryRetract('message-1')).toBe(true)
    test.ctx.emit('session/event', agent.session as never, {
      type: 'turn/end', seq: 2, time: 1, data: { turn: 1, reason: { kind: 'aborted' } },
    } as never)
    await Promise.resolve()
    expect(test.errors()).toContain('could not persist message retraction: append unavailable')
  })

  it('routes retraction interrupt failures through the app error sink', async () => {
    const test = bench()
    const agent = await waitForAgent(test)
    Object.assign(agent, { status: 'running' })
    agent.session.events.push(
      { type: 'turn/start', seq: 0, data: { turn: 1 } },
      { type: 'user/message', seq: 1, data: { id: 'message-1', source: { kind: 'user' } } },
    )
    agent.cancel.mockImplementationOnce(() => { throw new Error('cancel refused') })
    test.ctx.mayflyRequests.begin('main')
    expect(test.ctx.mayflyRetractions.tryRetract('message-1')).toBe(true)
    expect(test.errors()).toContain('could not interrupt current Agent: cancel refused')
  })

  it('interrupts a retracted continuable subagent through its parent address', async () => {
    const test = bench()
    const parent = await waitForAgent(test)
    const child = fakeAgent('child', [
      { type: 'turn/start', seq: 0, data: { turn: 1 } },
      { type: 'user/message', seq: 1, data: { id: 'child-message', source: { kind: 'user' } } },
    ])
    Object.assign(child, { status: 'running' })
    ;(child.session.surface.nodes as number[]).push(1)
    test.live.set(String(child.id), child)
    test.ctx.mayflyConversations.open({
      kind: 'subagent',
      sessionId: String(child.id),
      parentSessionId: String(parent.id),
      label: 'worker',
      mode: 'continuable',
    })
    test.ctx.mayflyRequests.begin('subagent')
    expect(test.ctx.mayflyRetractions.tryRetract('child-message')).toBe(true)
    expect(test.ctx.subagents.interruptByParent).toHaveBeenCalledWith(child.id, parent.id, 'continuable')
    expect(child.cancel).not.toHaveBeenCalled()
  })
})

describe('MayflyConversationsService', () => {
  function registry(ids: readonly string[] = ['primary']) {
    const ctx = new Context()
    const agents = new Map(ids.map(id => [id, fakeAgent(id)] as const))
    ctx.provide('agents', { get: (id: unknown) => agents.get(String(id)) } as never)
    const conversations = new MayflyConversationsService(ctx)
    const current = new MayflyCurrentAgentService(ctx, conversations)
    return { ctx, agents, conversations, current, agent: (id: string) => agents.get(id)! }
  }
  const child = (sessionId: string, mode: 'one-shot' | 'continuable' = 'continuable') => ({
    kind: 'subagent' as const, sessionId, parentSessionId: 'primary', label: sessionId, mode,
  })

  it('selects an exact live primary, heals a stale one, and observes its disposal', () => {
    const { ctx, agents, conversations, current, agent } = registry(['exact'])
    const exact = agent('exact')
    const seen: Array<Agent | null> = []
    const off = current.subscribe(value => { seen.push(value) })
    conversations.selectPrimary(exact)
    conversations.selectPrimary(exact)
    expect(current.current()).toBe(exact)
    expect(current.primary()).toBe(exact)
    expect(current.revision()).toBe(1)
    expect(() => conversations.selectPrimary(fakeAgent('foreign'))).toThrow('cannot select non-live Agent')
    ctx.emit('agent/disposed', { agent: fakeAgent('other') } as never)
    agents.delete('exact')
    expect(current.current()).toBeNull()
    agents.set('exact', exact)
    conversations.selectPrimary(exact)
    ctx.emit('agent/disposed', { agent: exact } as never)
    expect(current.current()).toBeNull()
    expect(conversations.snapshot()).toMatchObject({ primaryId: null, displayedId: null, recent: [], views: [] })
    expect(conversations.displayed()).toBeNull()
    conversations.selectPrimary(null)
    off()
    expect(seen).toEqual([null, exact, null, exact, null])
  })

  it('keeps several side conversations, returns to the previous one, and closes by recency', () => {
    const { conversations, current, agent } = registry(['primary', 'worker', 'reviewer'])
    const primary = agent('primary')
    conversations.selectPrimary(primary)
    const revisions: number[] = []
    conversations.subscribe(snapshot => { revisions.push(snapshot.revision) })
    expect(conversations.back()).toBe(false)
    expect(conversations.close()).toBeNull()

    const worker = conversations.open(child('worker'))
    const reviewer = conversations.open(child('reviewer'))
    expect(worker).toBe(conversationId('worker'))
    expect(current.current()).toBe(agent('reviewer'))
    expect(conversations.snapshot()).toMatchObject({
      primaryId: 'session:primary',
      displayedId: 'session:reviewer',
      recent: ['session:reviewer', 'session:worker', 'session:primary'],
    })
    expect(conversations.snapshot().views.map(view => [view.id, view.residency])).toEqual([
      ['session:primary', 'retained'],
      ['session:worker', 'retained'],
      ['session:reviewer', 'displayed'],
    ])
    expect(conversations.back()).toBe(true)
    expect(current.current()).toBe(agent('worker'))
    expect(conversations.back()).toBe(true)
    expect(current.current()).toBe(agent('reviewer'))
    expect(conversations.display('session:primary')).toBe(true)
    expect(conversations.display('session:primary')).toBe(true)
    expect(conversations.display('session:missing')).toBe(false)
    expect(current.current()).toBe(primary)
    // From the primary, closing without an id closes the F7 counterpart.
    expect(conversations.close()).toMatchObject({ id: reviewer, residency: 'retained' })
    expect(conversations.close('session:missing')).toBeNull()
    expect(conversations.display(worker)).toBe(true)
    expect(conversations.close()).toMatchObject({ id: worker })
    expect(conversations.displayed()).toMatchObject({ kind: 'primary', access: 'interactive', residency: 'displayed' })
    conversations.open(child('worker'))
    conversations.closeSides()
    conversations.closeSides()
    expect(conversations.snapshot()).toMatchObject({ displayedId: 'session:primary', recent: ['session:primary'] })
    expect(new Set(revisions).size).toBe(revisions.length)
    expect(conversations.revision()).toBe(revisions.at(-1))
  })

  it('derives readonly, resumable, and interactive access and drives only interactive Agents', () => {
    const { ctx, agents, conversations, current, agent } = registry(['primary', 'once', 'child'])
    conversations.selectPrimary(agent('primary'))
    conversations.open(child('once', 'one-shot'))
    expect(current.current()).toBeNull()
    expect(conversations.displayed()).toMatchObject({ access: 'readonly' })
    // A one-shot child's own events never change its access.
    ctx.emit('agent/created', { agent: agent('once') } as never)
    ctx.emit('agent/disposed', { agent: agent('once') } as never)
    expect(conversations.displayed()).toMatchObject({ access: 'readonly' })

    conversations.open(child('child'))
    const live = agent('child')
    expect(current.current()).toBe(live)
    agents.delete('child')
    ctx.emit('agent/disposed', { agent: live } as never)
    expect(current.current()).toBeNull()
    expect(conversations.displayed()).toMatchObject({ access: 'resumable' })
    ctx.emit('agent/created', { agent: fakeAgent('unrelated') } as never)
    const resumed = fakeAgent('child')
    agents.set('child', resumed)
    ctx.emit('agent/created', { agent: resumed } as never)
    expect(current.current()).toBe(resumed)
    expect(conversations.displayed()).toMatchObject({ access: 'interactive' })
  })

  it('keeps one BTW with its history floor and closes it when its Agent disappears', () => {
    const { ctx, agents, conversations, current, agent } = registry(['primary', 'btw-1', 'btw-2', 'worker'])
    conversations.selectPrimary(agent('primary'))
    conversations.open(child('worker'))
    conversations.open({ kind: 'btw', sessionId: 'btw-1', parentSessionId: 'primary', label: 'first', historyFloorSeq: 41 })
    expect(conversations.displayed()).toMatchObject({ kind: 'btw', label: 'first', historyFloorSeq: 41, access: 'interactive' })
    conversations.open({ kind: 'btw', sessionId: 'btw-1', parentSessionId: 'primary', label: 'first again' })
    expect(conversations.displayed()).not.toHaveProperty('historyFloorSeq')
    conversations.open({ kind: 'btw', sessionId: 'btw-2', parentSessionId: 'primary', label: 'second' })
    expect(conversations.snapshot().views.map(view => view.id)).toEqual(['session:primary', 'session:worker', 'session:btw-2'])
    expect(current.current()).toBe(agent('btw-2'))

    agents.delete('btw-2')
    expect(conversations.displayed()).toMatchObject({ kind: 'btw', access: 'readonly' })
    expect(current.current()).toBeNull()
    ctx.emit('agent/disposed', { agent: agent('btw-1') } as never)
    ctx.emit('agent/disposed', { agent: fakeAgent('btw-2') } as never)
    expect(conversations.displayed()).toMatchObject({ id: 'session:worker' })
    ctx.emit('mayfly/request-close-conversation')
    expect(conversations.displayed()).toMatchObject({ kind: 'primary' })
  })

  it('rejects unsafe identities, freezes snapshots, and drops the least recent side past the cap', () => {
    const { ctx, conversations, agent } = registry(['primary'])
    expect(() => conversations.open(child('child'))).toThrow('without a live primary Agent')
    expect(conversations.display('session:primary')).toBe(false)
    conversations.selectPrimary(agent('primary'))
    expect(() => conversations.open(child('primary'))).toThrow('cannot open the primary Agent')
    expect(() => conversations.open({ kind: 'btw', sessionId: 'missing', parentSessionId: 'primary', label: 'missing' }))
      .toThrow('cannot open non-live BTW Agent')

    const admitted = { ...child('extra', 'one-shot'), access: 'interactive' }
    conversations.open(admitted)
    const snapshot = conversations.snapshot()
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.views)).toBe(true)
    expect(Object.isFrozen(snapshot.views[1])).toBe(true)
    expect(snapshot.views[1]).toMatchObject({ access: 'readonly' })

    for (let index = 0; index < MAX_SIDE_CONVERSATIONS; index += 1) conversations.open(child(`child-${String(index)}`, 'one-shot'))
    const ids = conversations.snapshot().views.map(view => view.id)
    expect(ids).toHaveLength(MAX_SIDE_CONVERSATIONS + 1)
    expect(ids).not.toContain('session:extra')
    expect(ids.at(-1)).toBe(`session:child-${String(MAX_SIDE_CONVERSATIONS - 1)}`)
    expect(conversations.snapshot().views.filter(view => view.residency === 'listed')).toHaveLength(MAX_SIDE_CONVERSATIONS - 2)
    ctx.emit('agent/disposed', { agent: agent('primary') } as never)
    expect(conversations.snapshot().views).toEqual([])
  })

  it('heals a stale primary before closing and clears every side with it', () => {
    const { agents, conversations, current, agent } = registry(['primary', 'child'])
    conversations.selectPrimary(agent('primary'))
    conversations.open(child('child'))
    agents.delete('primary')
    expect(conversations.close('session:child')).toBeNull()
    expect(current.primary()).toBeNull()
    expect(current.current()).toBeNull()
    expect(conversations.snapshot().views).toEqual([])
  })
})
