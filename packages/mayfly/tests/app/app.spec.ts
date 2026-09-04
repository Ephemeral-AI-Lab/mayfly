/** Direct-service Mayfly app coordinator tests.
 * @module @ephemeral-ai/mayfly/app/tests/app
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { apply, Config, internals } from '../../src/app/index.ts'
import { MayflyCurrentAgentService } from '../../src/app/current-agent.ts'
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
  ctx.provide('subagents', { interruptByParent: vi.fn() } as never)

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

    test.ctx.mayflyCurrentAgent.select(null)
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
    test.ctx.mayflyCurrentAgent.openAuxiliary({
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

describe('MayflyCurrentAgentService', () => {
  it('selects exact live registry members, invalidates stale members, and observes disposal', () => {
    const ctx = new Context()
    const agent = fakeAgent('exact')
    let live: FakeAgent | undefined = agent
    ctx.provide('agents', { get: () => live } as never)
    const service = new MayflyCurrentAgentService(ctx)
    const seen: Array<Agent | null> = []
    const off = service.subscribe(value => { seen.push(value) })
    service.select(agent)
    service.select(agent)
    expect(service.current()).toBe(agent)
    expect(service.revision()).toBe(1)
    expect(() => service.select(fakeAgent('foreign'))).toThrow('cannot select non-live Agent')
    ctx.emit('agent/disposed', { agent: fakeAgent('other') } as never)
    live = undefined
    expect(service.current()).toBeNull()
    live = agent
    service.select(agent)
    ctx.emit('agent/disposed', { agent } as never)
    expect(service.current()).toBeNull()
    off()
    expect(seen).toEqual([null, agent, null, agent, null])
  })

  it('toggles one live continuable auxiliary without replacing the primary', () => {
    const ctx = new Context()
    const primary = fakeAgent('primary')
    const child = fakeAgent('child')
    const agents = new Map([[String(primary.id), primary], [String(child.id), child]])
    ctx.provide('agents', { get: (id: unknown) => agents.get(String(id)) } as never)
    const service = new MayflyCurrentAgentService(ctx)
    const views: string[] = []
    service.subscribeView(view => { views.push(`${view.displayed}:${view.auxiliary?.access ?? 'none'}`) })
    service.select(primary)
    service.openAuxiliary({
      kind: 'subagent', sessionId: String(child.id), parentSessionId: String(primary.id), label: 'worker', mode: 'continuable',
    })
    expect(service.current()).toBe(child)
    expect(service.primary()).toBe(primary)
    expect(service.view()).toMatchObject({ displayed: 'auxiliary', auxiliary: { access: 'interactive' } })
    expect(service.toggleAuxiliary()).toBe(true)
    expect(service.current()).toBe(primary)
    expect(service.view().displayed).toBe('primary')
    expect(service.toggleAuxiliary()).toBe(true)
    expect(service.current()).toBe(child)
    expect(service.closeAuxiliary()).toMatchObject({ sessionId: String(child.id) })
    expect(service.current()).toBe(primary)
    expect(service.toggleAuxiliary()).toBe(false)
    expect(views).toEqual([
      'primary:none',
      'primary:none',
      'auxiliary:interactive',
      'primary:interactive',
      'auxiliary:interactive',
      'primary:none',
    ])
  })

  it('keeps one-shot and inactive continuable auxiliaries readonly', () => {
    const ctx = new Context()
    const primary = fakeAgent('primary')
    const oneShot = fakeAgent('one-shot')
    const agents = new Map([[String(primary.id), primary], [String(oneShot.id), oneShot]])
    ctx.provide('agents', { get: (id: unknown) => agents.get(String(id)) } as never)
    const service = new MayflyCurrentAgentService(ctx)
    service.select(primary)
    service.openAuxiliary({
      kind: 'subagent', sessionId: String(oneShot.id), parentSessionId: String(primary.id), label: 'once', mode: 'one-shot',
    })
    expect(service.current()).toBe(primary)
    expect(service.view()).toMatchObject({ displayed: 'auxiliary', auxiliary: { access: 'readonly' } })
    service.openAuxiliary({
      kind: 'subagent', sessionId: 'cold', parentSessionId: String(primary.id), label: 'cold', mode: 'continuable',
    })
    expect(service.current()).toBe(primary)
    expect(service.view()).toMatchObject({ displayed: 'auxiliary', auxiliary: { sessionId: 'cold', access: 'readonly' } })
  })

  it('downgrades a disposed continuable child and upgrades its next live identity', () => {
    const ctx = new Context()
    const primary = fakeAgent('primary')
    const child = fakeAgent('child')
    const agents = new Map([[String(primary.id), primary], [String(child.id), child]])
    ctx.provide('agents', { get: (id: unknown) => agents.get(String(id)) } as never)
    const service = new MayflyCurrentAgentService(ctx)
    service.select(primary)
    service.openAuxiliary({
      kind: 'subagent', sessionId: String(child.id), parentSessionId: String(primary.id), label: 'worker', mode: 'continuable',
    })
    agents.delete(String(child.id))
    ctx.emit('agent/disposed', { agent: child } as never)
    expect(service.current()).toBe(primary)
    expect(service.view()).toMatchObject({ displayed: 'auxiliary', auxiliary: { access: 'readonly' } })

    const resumed = fakeAgent('child')
    agents.set(String(resumed.id), resumed)
    ctx.emit('agent/created', { agent: resumed } as never)
    expect(service.current()).toBe(resumed)
    expect(service.view()).toMatchObject({ displayed: 'auxiliary', auxiliary: { access: 'interactive' } })
  })

  it('closes an owned BTW view when its exact Agent disappears', () => {
    const ctx = new Context()
    const primary = fakeAgent('primary')
    const btw = fakeAgent('btw')
    const agents = new Map([[String(primary.id), primary], [String(btw.id), btw]])
    ctx.provide('agents', { get: (id: unknown) => agents.get(String(id)) } as never)
    const service = new MayflyCurrentAgentService(ctx)
    service.select(primary)
    service.openAuxiliary({ kind: 'btw', sessionId: String(btw.id), parentSessionId: String(primary.id), label: 'side question' })
    agents.delete(String(btw.id))
    ctx.emit('agent/disposed', { agent: btw } as never)
    expect(service.current()).toBe(primary)
    expect(service.view()).toMatchObject({ displayed: 'primary', auxiliary: null })
  })

  it('rejects unsafe auxiliary identities and freezes published snapshots', () => {
    const ctx = new Context()
    const primary = fakeAgent('primary')
    const live = new Map([[String(primary.id), primary]])
    ctx.provide('agents', { get: (id: unknown) => live.get(String(id)) } as never)
    const service = new MayflyCurrentAgentService(ctx)
    expect(() => service.openAuxiliary({
      kind: 'subagent', sessionId: 'child', parentSessionId: 'primary', label: 'child', mode: 'continuable',
    })).toThrow('without a live primary Agent')
    service.select(primary)
    expect(() => service.openAuxiliary({
      kind: 'subagent', sessionId: 'primary', parentSessionId: 'primary', label: 'self', mode: 'continuable',
    })).toThrow('cannot open the primary Agent')
    expect(() => service.openAuxiliary({
      kind: 'btw', sessionId: 'missing', parentSessionId: 'primary', label: 'missing',
    })).toThrow('cannot open non-live BTW Agent')

    service.openAuxiliary({
      kind: 'subagent', sessionId: 'cold', parentSessionId: 'primary', label: 'cold', mode: 'one-shot',
    })
    const snapshot = service.view()
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.auxiliary)).toBe(true)
    ctx.emit('mayfly/request-close-agent-view')
    expect(service.view().auxiliary).toBeNull()
  })

  it('invalidates a stale primary lookup and clears auxiliaries with it', () => {
    const ctx = new Context()
    const primary = fakeAgent('primary')
    const child = fakeAgent('child')
    const live = new Map([[String(primary.id), primary], [String(child.id), child]])
    ctx.provide('agents', { get: (id: unknown) => live.get(String(id)) } as never)
    const service = new MayflyCurrentAgentService(ctx)
    service.select(primary)
    service.openAuxiliary({
      kind: 'subagent', sessionId: 'child', parentSessionId: 'primary', label: 'child', mode: 'continuable',
    })
    live.delete('primary')
    expect(service.primary()).toBeNull()
    expect(service.current()).toBeNull()
    expect(service.view().auxiliary).toBeNull()
  })

  it('ignores unrelated Agent creation and upgrades a hidden continuable child', () => {
    const ctx = new Context()
    const primary = fakeAgent('primary')
    const oneShot = fakeAgent('one-shot')
    const live = new Map([[String(primary.id), primary], [String(oneShot.id), oneShot]])
    ctx.provide('agents', { get: (id: unknown) => live.get(String(id)) } as never)
    const service = new MayflyCurrentAgentService(ctx)
    service.select(primary)
    ctx.emit('agent/created', { agent: fakeAgent('unrelated') } as never)
    service.openAuxiliary({
      kind: 'subagent', sessionId: 'one-shot', parentSessionId: 'primary', label: 'once', mode: 'one-shot',
    })
    ctx.emit('agent/created', { agent: oneShot } as never)
    service.openAuxiliary({
      kind: 'subagent', sessionId: 'cold', parentSessionId: 'primary', label: 'cold', mode: 'continuable',
    })
    ctx.emit('agent/created', { agent: fakeAgent('other') } as never)
    service.toggleAuxiliary()
    const resumed = fakeAgent('cold')
    live.set('cold', resumed)
    ctx.emit('agent/created', { agent: resumed } as never)
    expect(service.current()).toBe(primary)
    expect(service.view()).toMatchObject({ displayed: 'primary', auxiliary: { access: 'interactive' } })
  })
})
