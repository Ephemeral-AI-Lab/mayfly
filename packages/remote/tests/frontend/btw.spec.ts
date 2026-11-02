/** Independent side-view orchestration over real HostActions and HostRegistry ownership. @module mayfly-remote/tests/frontend/btw */
import { describe, expect, it, vi } from 'vitest'
import type { ISessions, SessionBinding, SessionFace, SessionReference, SessionTarget } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { HostKey, type HostClient, type SessionRef } from '../../src/client/types.ts'
import { RemoteBtwPreconditionError, RemoteBtwService, RemoteBtwSupersededError, RemoteColdSubagentResolutionError, RemoteSubagentAddressError } from '../../src/frontend/btw.ts'
import { HostActions } from '../../src/frontend/host-actions.ts'
import { HostRegistry } from '../../src/frontend/host-registry.ts'

const accepted = { ok: true as const, value: { accepted: true as const } }
const failure = { ok: false as const, error: new RemoteError('gateway/internal', 'Host declined', {}) }
const parentId = 'parent' as SessionId
const childId = 'child' as SessionId
const otherId = 'other' as SessionId
const ref = (host = 'one', sessionId = parentId): SessionRef => ({ host: HostKey(host), sessionId })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = async (): Promise<void> => { await new Promise<void>(resolve => setImmediate(resolve)) }

/** Wire fixtures provide only official Client operations; all orchestration and lease ownership are production classes. */
async function fixture() {
  const references: SessionReference[] = []
  const operations: string[] = []
  let model: unknown = { next: { provider: 'provider', model: 'model', reasoningEffort: 'high' } }
  let cwd: unknown = '/host/workspace'
  let history: Array<{ type: string, event: { type: string, seq: number } }> = [{ type: 'event', event: { type: 'turn/end', seq: 20 } }]
  let inbox: unknown = { 'next-turn': [{ id: 'old-turn' }], 'next-step': [{ id: 'old-step' }] }
  const prompt = vi.fn<SessionFace['prompt']>(async () => { operations.push('prompt'); return accepted })
  const cancel = vi.fn<SessionFace['cancel']>(async () => accepted)
  const queue = vi.fn<SessionFace['updateQueue']>(async id => { operations.push(`remove:${id}`); return accepted })
  const fork = vi.fn<ISessions['fork']>(async () => { operations.push('fork'); return childId })
  const selectModel = vi.fn(async (..._args: unknown[]) => { operations.push('model'); return { ok: true as const, value: {} } })
  const subagentPrompt = vi.fn(async (..._args: unknown[]) => accepted)
  const address = vi.fn<ISessions['subagentAddress']>(() => undefined)
  const retain: ISessions['retain'] = (target: SessionTarget): SessionReference => {
    const id = typeof target === 'string' ? target : target.childSessionId
    const session = Object.assign({} as SessionFace, {
      sessionId: id,
      beginSubmission: () => ({ requestId: `request-${references.length}` as SessionRequestId, abandon: vi.fn() }),
      prompt, cancel, updateQueue: queue,
      projections: { faceOf: (key: string) => ({ getSnapshot: () => key === 'modelSelection' ? model : key === 'workingDirectory' ? cwd : key === 'inbox' ? inbox : undefined }) },
    })
    const binding = { sessionId: id, session, eventSource: { getSnapshot: () => ({ entries: history }) } } as unknown as SessionBinding
    const reference: SessionReference = { sessionId: id, binding, ready: Promise.resolve(binding), release: vi.fn(), [Symbol.dispose]: () => { reference.release() } }
    references.push(reference)
    return reference
  }
  const using: ISessions['using'] = async (target, options, operation) => {
    const reference = retain(target, options)
    try { await reference.ready; return await operation(reference) } finally { reference.release() }
  }
  const client = Object.assign({} as HostClient, {
    key: HostKey('one'),
    sessions: {
      retain, using, fork, subagentAddress: address,
      list: { getSnapshot: () => ({ ids: [parentId], byId: { [parentId]: { cwd: '/catalog/workspace' } } }) },
    },
    remote: { session: { selectModel }, subagents: { prompt: subagentPrompt } },
    detach: vi.fn(async () => {}),
  })
  const registry = new HostRegistry(() => client)
  await registry.attach(client.key)
  const actions = new HostActions(registry)
  await actions.select(ref())
  const btw = new RemoteBtwService(actions, registry)
  return {
    btw, actions, registry, client, references, operations, prompt, cancel, queue, fork, selectModel, address, subagentPrompt,
    setModel: (value: unknown) => { model = value },
    setCwd: (value: unknown) => { cwd = value },
    setHistory: (value: typeof history) => { history = value },
    setInbox: (value: unknown) => { inbox = value },
  }
}

describe('RemoteBtwService', () => {
  it('forks once, restores exact model, removes inherited queue rows and prompts only the child', async () => {
    const f = await fixture()
    const result = await f.btw.ask(ref(), 'side question', { atSeq: 12 as SessionSeq, allowMigration: true })
    expect(result.ok).toBe(true)
    if (!result.ok) throw result.error
    expect(result.value.child).toEqual(ref('one', childId))
    expect(result.value.selection).toEqual({ ref: ref('one', childId), cwd: '/host/workspace', historyFloorSeq: 12 })
    expect(f.operations).toEqual(['fork', 'model', 'remove:old-turn', 'remove:old-step', 'prompt'])
    expect(f.fork).toHaveBeenCalledWith({ sessionId: parentId, atSeq: 12, allowMigration: true })
    expect(f.selectModel).toHaveBeenCalledWith(expect.objectContaining({ sessionId: childId, provider: 'provider', model: 'model', reasoningEffort: 'high' }))
    expect(f.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'side question' }], 'queue', expect.any(AbortSignal), expect.stringMatching(/^request-/u))
    expect(f.actions.current).toEqual(ref())
    expect(f.btw.current()).toEqual({ parent: ref(), child: ref('one', childId) })
    f.btw.close()
    expect(f.btw.current()).toBeUndefined()
    expect(f.cancel).not.toHaveBeenCalled()
    await f.btw.dispose()
    await f.registry.detach(HostKey('one'))
    for (const reference of f.references) expect(reference.release).toHaveBeenCalledOnce()
  })

  it('uses last completed history and model fallback, and Host catalog cwd when projection data is unavailable', async () => {
    const f = await fixture()
    f.setModel({ next: { invalid: true }, lastUsed: { provider: 'fallback', model: 'last' } })
    f.setCwd(null)
    f.setHistory([{ type: 'event', event: { type: 'turn/end', seq: 20 } }, { type: 'event', event: { type: 'user/message', seq: 25 } }])
    f.setInbox({ 'next-turn': null, 'next-step': false })
    const result = await f.btw.ask(ref(), 'side question')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.selection).toEqual({ ref: ref('one', childId), cwd: '/catalog/workspace', historyFloorSeq: 20 })
    expect(f.selectModel).toHaveBeenCalledWith(expect.objectContaining({ provider: 'fallback', model: 'last' }))
    expect(f.queue).not.toHaveBeenCalled()
    await f.btw.dispose()
    await f.registry.detach(HostKey('one'))
  })

  it('refuses missing official model data before mutating the Host', async () => {
    const f = await fixture()
    f.setModel([])
    await expect(f.btw.ask(ref(), 'side')).rejects.toMatchObject({ name: 'RemoteBtwPreconditionError', reason: 'model-unavailable' })
    expect(f.fork).not.toHaveBeenCalled()
    await f.btw.dispose()
    await f.registry.detach(HostKey('one'))
  })

  it('does not prompt a child without an official inherited history floor', async () => {
    const f = await fixture()
    f.setHistory([])
    await expect(f.btw.ask(ref(), 'side')).rejects.toBeInstanceOf(RemoteBtwPreconditionError)
    expect(f.prompt).not.toHaveBeenCalled()
    expect(f.btw.current()).toBeUndefined()
    await f.btw.dispose()
    await f.registry.detach(HostKey('one'))
  })

  it('preserves structured native fork failures without requiring cross-realm class identity', async () => {
    const f = await fixture()
    f.fork.mockRejectedValueOnce({ name: 'SessionForkError', rpcError: failure.error })
    expect(await f.btw.ask(ref(), 'side')).toEqual(failure)
    expect(f.selectModel).not.toHaveBeenCalled()
    f.fork.mockRejectedValueOnce(new Error('ordinary fork error'))
    await expect(f.btw.ask(ref(), 'side')).rejects.toThrow('ordinary fork error')
    f.fork.mockRejectedValueOnce({ name: 'SessionForkError', rpcError: null })
    await expect(f.btw.ask(ref(), 'side')).rejects.toEqual({ name: 'SessionForkError', rpcError: null })
    await f.btw.dispose()
    await f.registry.detach(HostKey('one'))
  })

  it('stops before prompting when model restoration or inherited queue mutation is refused', async () => {
    const f = await fixture()
    f.selectModel.mockResolvedValueOnce(failure as never)
    expect(await f.btw.ask(ref(), 'side')).toEqual(failure)
    expect(f.queue).not.toHaveBeenCalled()
    f.queue.mockResolvedValueOnce(failure)
    expect(await f.btw.ask(ref(), 'side again')).toEqual(failure)
    expect(f.prompt).not.toHaveBeenCalled()
    expect(f.btw.current()).toBeUndefined()
    await f.btw.dispose()
    await f.registry.detach(HostKey('one'))
  })

  it('rejects malformed inherited Inbox identities and never sends the new side question', async () => {
    const f = await fixture()
    f.setInbox({ 'next-turn': [{ missing: 'id' }], 'next-step': [] })
    await expect(f.btw.ask(ref(), 'side')).rejects.toThrow('Host Inbox row has no MessageId')
    expect(f.prompt).not.toHaveBeenCalled()
    f.setInbox(null)
    f.prompt.mockResolvedValueOnce(failure)
    expect(await f.btw.ask(ref(), 'side')).toEqual(failure)
    expect(f.btw.current()).toBeUndefined()
    await f.btw.dispose()
    await f.registry.detach(HostKey('one'))
  })

  it('supersedes a pending fork without replay and releases its parent lease before starting a newer question', async () => {
    const f = await fixture()
    const fork = deferred<SessionId>()
    f.fork.mockImplementationOnce(() => fork.promise)
    const first = f.btw.ask(ref(), 'old question')
    const retired = expect(first).rejects.toBeInstanceOf(RemoteBtwSupersededError)
    await flush()
    const next = f.btw.ask(ref(), 'new question')
    fork.resolve(otherId)
    await retired
    expect((await next).ok).toBe(true)
    expect(f.fork).toHaveBeenCalledTimes(2)
    expect(f.prompt).toHaveBeenCalledOnce()
    expect(f.prompt.mock.calls[0]![0]).toEqual([{ type: 'text', text: 'new question' }])
    expect(f.cancel).not.toHaveBeenCalled()
    await f.btw.dispose()
    await f.registry.detach(HostKey('one'))
  })

  it('close cancels only pending acquisition and ignores a late native fork result', async () => {
    const f = await fixture()
    const fork = deferred<SessionId>()
    f.fork.mockImplementationOnce(() => fork.promise)
    const asked = f.btw.ask(ref(), 'side')
    const cancelled = expect(asked).rejects.toBeInstanceOf(RemoteBtwSupersededError)
    await flush()
    f.btw.close()
    fork.resolve(childId)
    await cancelled
    expect(f.prompt).not.toHaveBeenCalled()
    expect(f.actions.current).toEqual(ref())
    expect(f.cancel).not.toHaveBeenCalled()
    await f.btw.dispose()
    await f.btw.dispose()
    await expect(f.btw.ask(ref(), 'later')).rejects.toBeInstanceOf(RemoteBtwSupersededError)
    await expect(f.btw.ask(ref(), '  ')).rejects.toThrow('BTW question must not be empty')
    await f.registry.detach(HostKey('one'))
  })

  it('respects an external abort while a Host mutation is pending and suppresses late presentation', async () => {
    const f = await fixture()
    const model = deferred<Awaited<ReturnType<typeof f.selectModel>>>()
    f.selectModel.mockImplementationOnce(() => model.promise)
    const controller = new AbortController()
    const asked = f.btw.ask(ref(), 'side', { signal: controller.signal })
    const aborted = expect(asked).rejects.toThrow('caller stopped')
    await flush()
    controller.abort(new Error('caller stopped'))
    model.resolve({ ok: true, value: {} })
    await aborted
    expect(f.prompt).not.toHaveBeenCalled()
    expect(f.btw.current()).toBeUndefined()
    await f.btw.dispose()
    await f.registry.detach(HostKey('one'))
  })

  it('addresses continuable children through the exact direct-parent native route with new request identities', async () => {
    const f = await fixture()
    f.address.mockReturnValue({ parentSessionId: parentId, childSessionId: childId, mode: 'continuable' })
    const signal = new AbortController().signal
    const content = [{ type: 'text' as const, text: 'continue' }]
    await f.btw.promptSubagent(ref(), ref('one', childId), { content, delivery: 'steer', clientTimeZone: 'Asia/Shanghai', signal })
    await f.btw.promptSubagent(ref(), ref('one', childId), { content, delivery: 'queue' })
    const first = f.subagentPrompt.mock.calls[0]!
    expect(first[0]).toMatchObject({ parentSessionId: parentId, childSessionId: childId, mode: 'continuable', delivery: 'steer', content, clientTimeZone: 'Asia/Shanghai' })
    expect(first[1]).toBe(signal)
    expect((first[0] as { requestId: string }).requestId).not.toBe((f.subagentPrompt.mock.calls[1]![0] as { requestId: string }).requestId)
    expect(f.prompt).not.toHaveBeenCalled()
    expect(() => f.btw.promptSubagent(ref(), ref('two', childId), { content, delivery: 'queue' })).toThrow('same Host')
    f.address.mockReturnValue({ parentSessionId: otherId, childSessionId: childId, mode: 'continuable' })
    expect(() => f.btw.promptSubagent(ref(), ref('one', childId), { content, delivery: 'queue' })).toThrow(RemoteSubagentAddressError)
    f.address.mockReturnValue(undefined)
    expect(() => f.btw.promptSubagent(ref(), ref('one', childId), { content, delivery: 'queue' })).toThrow(RemoteSubagentAddressError)
    expect(() => f.btw.promptSubagent(ref('missing'), ref('missing', childId), { content, delivery: 'queue' })).toThrow(RemoteSubagentAddressError)
    await f.btw.dispose()
    await f.registry.detach(HostKey('one'))
  })

  it('retains only officially resolved exact-parent cold views without borrowing the parent binding', async () => {
    const f = await fixture()
    expect(() => f.btw.retainColdSubagentView(ref(), ref('two', childId))).toThrow(RemoteColdSubagentResolutionError)
    expect(() => f.btw.retainColdSubagentView(ref(), ref('one', childId))).toThrow(RemoteColdSubagentResolutionError)
    f.address.mockReturnValue({ parentSessionId: otherId, childSessionId: childId, mode: 'continuable' })
    expect(() => f.btw.retainColdSubagentView(ref(), ref('one', childId))).toThrow(RemoteColdSubagentResolutionError)
    f.address.mockReturnValue({ parentSessionId: parentId, childSessionId: childId, mode: 'continuable' })
    const lease = f.btw.retainColdSubagentView(ref(), ref('one', childId))
    expect(lease.reference.sessionId).toBe(childId)
    expect(f.actions.current).toEqual(ref())
    lease.release()
    lease.release()
    expect(lease.reference.release).toHaveBeenCalledOnce()
    await f.btw.dispose()
    await f.registry.detach(HostKey('one'))
  })
})
