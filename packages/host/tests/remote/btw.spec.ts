/** Whole-tail BTW admission uses native Session commands and exact-source lifetime fences. @module */
import { symbols, type Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { btwFork } from '../../src/remote/btw.ts'

const sessionId = SessionId('parent')
const childId = SessionId('child')
const request = { sessionId }
const signal = () => new AbortController().signal
const flush = async () => { await new Promise<void>(resolve => setImmediate(resolve)) }

function fixture(cursor = 37, preset: string | undefined = 'creative') {
  const session = { id: sessionId, header: { cwd: '/parent', agentPreset: preset } }
  const agent = { id: sessionId, session }
  const dispose = vi.fn()
  const observation = { cursor, header: session.header, [Symbol.dispose]: dispose }
  const observeSession = vi.fn(async (..._args: unknown[]) => observation)
  const fork = vi.fn(async (..._args: unknown[]) => ({ sessionId: childId }))
  const create = vi.fn(async (..._args: unknown[]) => ({ sessionId: childId }))
  const source = { observeSession }
  const controller = { fork, create }
  const services = { sessionQuery: source, sessionController: controller } as Record<string, unknown>
  const agents = { get: vi.fn(() => agent) }
  const sessions = { get: vi.fn(() => session) }
  const ctx = { agents, sessions, sessionQuery: source, sessionController: controller, get: (name: string) => services[name], sessionProjections: { snapshot: () => ({ values: { workingDirectory: '/effective' } }) } } as unknown as Context
  return { ctx, session, agent, observation, dispose, observeSession, fork, create, source, controller, services, agents, sessions }
}

describe('native whole-tail BTW fork', () => {
  it('captures the complete native cursor rather than a completed-turn or Client page boundary', async () => {
    const f = fixture()
    const s = signal()
    const value = await btwFork(f.ctx, request, s)
    expect(value).toEqual({ sessionId: childId, historyFloorSeq: 37 })
    expect(Object.isFrozen(value)).toBe(true)
    expect(f.observeSession).toHaveBeenCalledWith(sessionId, { signal: s, projectionMode: 'none' })
    expect(f.fork).toHaveBeenCalledWith({ sessionId, atSeq: 37 })
    expect(f.create).not.toHaveBeenCalled()
    expect(f.dispose).toHaveBeenCalledOnce()
  })

  it('supports an unfinished first turn and preserves an explicit inclusive event zero', async () => {
    const f = fixture(8)
    expect(await btwFork(f.ctx, request, signal())).toEqual({ sessionId: childId, historyFloorSeq: 8 })
    expect(await btwFork(f.ctx, { ...request, atSeq: 0, allowMigration: false }, signal())).toEqual({ sessionId: childId, historyFloorSeq: 0 })
    expect(f.fork).toHaveBeenLastCalledWith({ sessionId, atSeq: 0, allowMigration: false })
    await btwFork(f.ctx, { ...request, atSeq: 4, allowMigration: true }, signal())
    expect(f.fork).toHaveBeenLastCalledWith({ sessionId, atSeq: 4, allowMigration: true })
  })

  it.each(['creative', undefined])('uses native creation for an entirely empty source with preset %s', async preset => {
    const f = fixture(-1, preset)
    // Explicit undefined selects the fixture's default parameter; remove the header field for this case.
    if (preset === undefined) Reflect.deleteProperty(f.session.header, 'agentPreset')
    expect(await btwFork(f.ctx, request, signal())).toEqual({ sessionId: childId })
    expect(f.create).toHaveBeenCalledWith({ cwd: '/effective', ...preset === undefined ? {} : { agentPreset: preset } })
    expect(f.fork).not.toHaveBeenCalled()
    expect(f.dispose).toHaveBeenCalledOnce()
  })

  it('does not reinterpret a caller-supplied invalid negative cut as an empty-source create', async () => {
    const f = fixture(-1)
    const error = new Error('atSeq must be a non-negative safe integer')
    f.fork.mockRejectedValueOnce(error)
    await expect(btwFork(f.ctx, { ...request, atSeq: -1 }, signal())).rejects.toBe(error)
    expect(f.create).not.toHaveBeenCalled()
    expect(f.dispose).toHaveBeenCalledOnce()
  })

  it('accepts native service proxy identities rather than object-wrapper identity', async () => {
    const f = fixture()
    const sourceIdentity = {}
    const controllerIdentity = {}
    Reflect.set(f.source, symbols.original, sourceIdentity)
    Reflect.set(f.controller, symbols.original, controllerIdentity)
    f.services['sessionQuery'] = { [symbols.original]: sourceIdentity }
    f.services['sessionController'] = { [symbols.original]: controllerIdentity }
    expect(await btwFork(f.ctx, request, signal())).toEqual({ sessionId: childId, historyFloorSeq: 37 })
  })

  it('never starts an observation or creates a child after a pre-abort or exact-Agent refusal', async () => {
    const f = fixture()
    await expect(btwFork(f.ctx, request, AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' })
    f.sessions.get.mockReturnValueOnce({ ...f.session })
    await expect(btwFork(f.ctx, request, signal())).rejects.toMatchObject({ code: 'mayflyHost/session-stale' })
    expect(f.observeSession).not.toHaveBeenCalled()
    expect(f.fork).not.toHaveBeenCalled()
  })

  it.each(['sessionQuery', 'sessionController'])('rejects replaced %s and releases its pending observation', async name => {
    for (const replacement of [{}, undefined]) {
      const f = fixture()
      const pending = Promise.withResolvers<typeof f.observation>()
      f.observeSession.mockReturnValueOnce(pending.promise)
      const operation = btwFork(f.ctx, request, signal())
      await flush()
      f.services[name] = replacement
      pending.resolve(f.observation)
      await expect(operation).rejects.toMatchObject({ code: 'mayflyHost/session-stale' })
      expect(f.fork).not.toHaveBeenCalled()
      expect(f.dispose).toHaveBeenCalledOnce()
    }
  })

  it('releases a late observation after cancellation and never starts the native write', async () => {
    const f = fixture()
    const pending = Promise.withResolvers<typeof f.observation>()
    f.observeSession.mockReturnValueOnce(pending.promise)
    const owner = new AbortController()
    const operation = btwFork(f.ctx, request, owner.signal)
    await flush()
    owner.abort()
    pending.resolve(f.observation)
    await expect(operation).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.dispose).toHaveBeenCalledOnce()
    expect(f.fork).not.toHaveBeenCalled()
  })

  it('rejects late creation or fork results after cancellation without cancelling native Host work', async () => {
    for (const cursor of [-1, 37]) {
      const f = fixture(cursor)
      const pending = Promise.withResolvers<{ sessionId: typeof childId }>()
      const command = cursor === -1 ? f.create : f.fork
      command.mockReturnValueOnce(pending.promise)
      const owner = new AbortController()
      const operation = btwFork(f.ctx, request, owner.signal)
      await flush()
      owner.abort()
      pending.resolve({ sessionId: childId })
      await expect(operation).rejects.toMatchObject({ name: 'AbortError' })
      expect(f.dispose).toHaveBeenCalledOnce()
    }
  })

  it('refuses a same-id parent Agent replacement after native forking', async () => {
    const f = fixture()
    const pending = Promise.withResolvers<{ sessionId: typeof childId }>()
    f.fork.mockReturnValueOnce(pending.promise)
    const operation = btwFork(f.ctx, request, signal())
    await flush()
    f.agents.get.mockReturnValue({ ...f.agent })
    pending.resolve({ sessionId: childId })
    await expect(operation).rejects.toMatchObject({ code: 'mayflyHost/session-stale' })
    expect(f.dispose).toHaveBeenCalledOnce()
  })

  it('preserves native observation, fork, and empty-create failures and releases acquired leases', async () => {
    const error = new Error('native refusal')
    const read = fixture()
    read.observeSession.mockRejectedValueOnce(error)
    await expect(btwFork(read.ctx, request, signal())).rejects.toBe(error)
    expect(read.dispose).not.toHaveBeenCalled()
    for (const cursor of [-1, 37]) {
      const f = fixture(cursor)
      const command = cursor === -1 ? f.create : f.fork
      command.mockRejectedValueOnce(error)
      await expect(btwFork(f.ctx, request, signal())).rejects.toBe(error)
      expect(f.dispose).toHaveBeenCalledOnce()
    }
  })
})
