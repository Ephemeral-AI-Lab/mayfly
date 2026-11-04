/** Independent side-view orchestration over real HostActions and HostRegistry ownership. @module mayfly-remote/tests/frontend/btw */
import { describe, expect, it, vi } from 'vitest'
import type { ISessions, SessionBinding, SessionFace, SessionReference, SessionTarget } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { HostKey, type HostClient, type SessionRef } from '../../src/client/types.ts'
import { RemoteBtwService, RemoteBtwSupersededError, RemoteColdSubagentResolutionError, RemoteSubagentAddressError } from '../../src/frontend/btw.ts'
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
  const readiness = new Map<SessionId, Promise<SessionBinding>>()
  const operations: string[] = []
  let model: unknown = { next: { provider: 'provider', model: 'model', reasoningEffort: 'high' } }
  let cwd: unknown = '/host/workspace'
  let catalogCwd: string | undefined = '/catalog/workspace'
  let history: Array<{ type: string, event: { type: string, seq: number } }> = [{ type: 'event', event: { type: 'turn/end', seq: 20 } }]
  let inbox: unknown = { 'next-turn': [{ id: 'old-turn' }], 'next-step': [{ id: 'old-step' }] }
  let childCatalogued = false
  const prompt = vi.fn<SessionFace['prompt']>(async () => { operations.push('prompt'); return accepted })
  const cancel = vi.fn<SessionFace['cancel']>(async () => accepted)
  const queue = vi.fn<SessionFace['updateQueue']>(async id => { operations.push(`remove:${id}`); return accepted })
  const fork = vi.fn(async (request: { readonly sessionId: SessionId, readonly atSeq?: number, readonly allowMigration?: boolean }, _signal?: AbortSignal) => { operations.push('fork'); return { ok: true as const, value: { sessionId: childId, historyFloorSeq: request.atSeq ?? 37 } } })
  const defaultModel = vi.fn(async (..._args: unknown[]) => ({ ok: true as const, value: { provider: 'default-provider', model: 'default-model' } }))
  let generation = 1
  const selectModel = vi.fn(async (..._args: unknown[]) => { operations.push('model'); return { ok: true as const, value: {} } })
  const subagentPrompt = vi.fn(async (..._args: unknown[]) => accepted)
  const address = vi.fn<ISessions['subagentAddress']>(() => undefined)
  const refresh = vi.fn<ISessions['refresh']>(async () => { operations.push('catalog'); childCatalogued = true })
  const retain: ISessions['retain'] = (target: SessionTarget): SessionReference => {
    const id = typeof target === 'string' ? target : target.childSessionId
    if (id === childId && !childCatalogued && typeof target === 'string') throw new Error('sessions.retain: unknown session child')
    const session = Object.assign({} as SessionFace, {
      sessionId: id,
      beginSubmission: () => ({ requestId: `request-${references.length}` as SessionRequestId, abandon: vi.fn() }),
      prompt, cancel, updateQueue: queue,
      projections: { faceOf: (key: string) => ({ getSnapshot: () => key === 'modelSelection' ? model : key === 'workingDirectory' ? cwd : key === 'inbox' ? inbox : undefined }) },
    })
    const binding = { sessionId: id, session, eventSource: { getSnapshot: () => ({ entries: history }) } } as unknown as SessionBinding
    const reference: SessionReference = { sessionId: id, binding, ready: readiness.get(id) ?? Promise.resolve(binding), release: vi.fn(), [Symbol.dispose]: () => { reference.release() } }
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
      retain, using, fork, refresh, subagentAddress: address,
      list: { getSnapshot: () => ({ ids: [parentId, ...childCatalogued ? [childId] : []], byId: { ...catalogCwd === undefined ? {} : { [parentId]: { cwd: catalogCwd } }, ...childCatalogued ? { [childId]: {} } : {} } }) },
    },
    remote: { session: { selectModel }, subagents: { prompt: subagentPrompt }, mayflyHost: { btwFork: fork, defaultModel } },
    state: { getSnapshot: () => ({ status: 'connected', generation }) },
    detach: vi.fn(async () => {}),
  })
  const registry = new HostRegistry(() => client)
  await registry.attach(client.key)
  const actions = new HostActions(registry)
  await actions.select(ref())
  const btw = new RemoteBtwService(actions, registry)
  return {
    btw, actions, registry, client, references, operations, prompt, cancel, queue, fork, refresh, defaultModel, selectModel, address, subagentPrompt,
    setReady: (id: SessionId, ready: Promise<SessionBinding> | undefined) => { if (ready === undefined) readiness.delete(id); else readiness.set(id, ready) },
    setChildCatalogued: (value: boolean) => { childCatalogued = value },
    setGeneration: (value: number) => { generation = value },
    setModel: (value: unknown) => { model = value },
    setCwd: (value: unknown) => { cwd = value },
    setCatalogCwd: (value: string | undefined) => { catalogCwd = value },
    setHistory: (value: typeof history) => { history = value },
    setInbox: (value: unknown) => { inbox = value },
  }
}

describe('RemoteBtwService', () => {
  it.each(['parent', 'child'] as const)('retires a never-ready %s acquisition immediately for close, replacement, caller abort and dispose', async phase => {
    for (const action of ['close', 'replacement', 'caller', 'dispose'] as const) {
      const f = await fixture()
      const ready = deferred<SessionBinding>()
      if (phase === 'parent') f.setReady(parentId, ready.promise)
      else f.selectModel.mockImplementationOnce(async () => { f.setReady(childId, ready.promise); return { ok: true, value: {} } })
      const caller = new AbortController()
      const asked = f.btw.ask(ref(), 'stalled question', { signal: caller.signal })
      const retired = expect(asked).rejects.toBeInstanceOf(action === 'caller' ? DOMException : RemoteBtwSupersededError)
      await flush()
      const held = f.references.at(-1)!
      expect(held.sessionId).toBe(phase === 'parent' ? parentId : childId)
      const parent = f.references[1]!
      f.setReady(parentId, undefined)
      f.setReady(childId, undefined)
      let second: ReturnType<typeof f.btw.ask> | undefined
      if (action === 'close') f.btw.close()
      if (action === 'replacement') second = f.btw.ask(ref(), 'new question')
      if (action === 'caller') caller.abort()
      const disposal = action === 'dispose' ? f.btw.dispose() : undefined
      expect(parent.release).toHaveBeenCalledOnce()
      expect(held.release).toHaveBeenCalledOnce()
      await retired
      await disposal
      if (second !== undefined) expect((await second).ok).toBe(true)
      else expect(f.prompt).not.toHaveBeenCalled()
      // The ready promise has not settled: retirement and newer work are already complete.
      expect(f.actions.current).toEqual(ref())
      expect(f.cancel).not.toHaveBeenCalled()
      if (action === 'close' || action === 'replacement') ready.resolve(held.binding)
      else ready.reject(new Error('late acquisition refusal'))
      await flush()
      expect(held.release).toHaveBeenCalledOnce()
      await f.btw.dispose()
      await f.registry.detach(HostKey('one'))
    }
  })

  it.each(['parent', 'child'] as const)('releases only its refcount for a shared pending %s lease', async phase => {
    const f = await fixture()
    const ready = deferred<SessionBinding>()
    let shared: ReturnType<typeof f.actions.retainView>
    if (phase === 'parent') {
      f.setReady(parentId, ready.promise)
      shared = f.actions.retainView(ref(), 'btw-parent')
    } else {
      f.setChildCatalogued(true)
      f.selectModel.mockImplementationOnce(async () => {
        f.setReady(childId, ready.promise)
        shared = f.actions.retainView(ref('one', childId), 'btw')
        return { ok: true, value: {} }
      })
    }
    const asked = f.btw.ask(ref(), 'pending shared view')
    const retired = expect(asked).rejects.toBeInstanceOf(RemoteBtwSupersededError)
    await flush()
    f.btw.close()
    await retired
    expect(shared!.reference.release).not.toHaveBeenCalled()
    expect(f.registry.viewKeys()).toEqual([shared!.key])
    shared!.release()
    expect(shared!.reference.release).toHaveBeenCalledOnce()
    ready.reject(new Error('late shared readiness failure'))
    await flush()
    await f.btw.dispose()
    await f.registry.detach(HostKey('one'))
  })

  it('retains independent listed BTW views with their default or explicit view role', async () => {
    const f = await fixture()
    f.setChildCatalogued(true)
    const child = ref('one', childId)
    const first = f.btw.retainBtwView(child)
    const second = f.btw.retainBtwView(child, 'listed-child')
    expect(first.key).toEqual({ ref: child, role: 'btw-retained' })
    expect(second.key).toEqual({ ref: child, role: 'listed-child' })
    first.release()
    second.release()
    expect(f.actions.current).toEqual(ref())
    await f.btw.dispose()
    await f.registry.detach(HostKey('one'))
  })

  it('releases an acquisition whose native readiness refuses before retirement', async () => {
    const f = await fixture()
    const ready = deferred<SessionBinding>()
    f.setReady(parentId, ready.promise)
    const asked = f.btw.ask(ref(), 'unavailable parent')
    const failed = expect(asked).rejects.toThrow('native ready failed')
    await flush()
    ready.reject(new Error('native ready failed'))
    await failed
    expect(f.references.at(-1)!.release).toHaveBeenCalledOnce()
    expect(f.registry.viewKeys()).toEqual([])
    await f.btw.dispose()
    await f.registry.detach(HostKey('one'))
  })

  it('handles abort during synchronous acquisition before beginning the ready wait', async () => {
    const f = await fixture()
    const caller = new AbortController()
    const retain = f.actions.retainView.bind(f.actions)
    vi.spyOn(f.actions, 'retainView').mockImplementationOnce((...args) => {
      const lease = retain(...args)
      caller.abort()
      return lease
    })
    await expect(f.btw.ask(ref(), 'retired acquisition', { signal: caller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.references.at(-1)!.release).toHaveBeenCalledOnce()
    expect(f.fork).not.toHaveBeenCalled()
    await f.btw.dispose()
    await f.registry.detach(HostKey('one'))
  })

  it('forks once, restores exact model, removes inherited queue rows and prompts only the child', async () => {
    const f = await fixture()
    const result = await f.btw.ask(ref(), 'side question', { atSeq: 12 as SessionSeq, allowMigration: true })
    expect(result.ok).toBe(true)
    if (!result.ok) throw result.error
    expect(result.value.child).toEqual(ref('one', childId))
    expect(result.value.selection).toEqual({ ref: ref('one', childId), cwd: '/host/workspace', historyFloorSeq: 12 })
    expect(f.operations).toEqual(['fork', 'catalog', 'model', 'remove:old-turn', 'remove:old-step', 'prompt'])
    expect(f.fork).toHaveBeenCalledWith({ sessionId: parentId, atSeq: 12, allowMigration: true }, expect.any(AbortSignal))
    expect(f.selectModel).toHaveBeenCalledWith(expect.objectContaining({ sessionId: childId, provider: 'provider', model: 'model', reasoningEffort: 'high' }))
    expect(f.defaultModel).not.toHaveBeenCalled()
    expect(f.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'side question' }], 'queue', expect.any(AbortSignal), expect.stringMatching(/^request-/u))
    expect(f.actions.current).toEqual(ref())
    expect(f.btw.current()).toEqual({ parent: ref(), child: ref('one', childId) })
    expect(f.btw.close()).toBe(true)
    expect(f.btw.current()).toBeUndefined()
    expect(f.btw.close()).toBe(false)
    expect(f.cancel).not.toHaveBeenCalled()
    await f.btw.dispose()
    await f.registry.detach(HostKey('one'))
    for (const reference of f.references) expect(reference.release).toHaveBeenCalledOnce()
  })

  it('uses the Host whole-tail boundary independently of incomplete Client history, with model and cwd fallbacks', async () => {
    const f = await fixture()
    f.setModel({ next: { invalid: true }, lastUsed: { provider: 'fallback', model: 'last' } })
    f.setCwd(null)
    f.setHistory([{ type: 'event', event: { type: 'turn/end', seq: 20 } }, { type: 'event', event: { type: 'user/message', seq: 25 } }])
    f.setInbox({ 'next-turn': null, 'next-step': false })
    const result = await f.btw.ask(ref(), 'side question')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.selection).toEqual({ ref: ref('one', childId), cwd: '/catalog/workspace', historyFloorSeq: 37 })
    expect(f.selectModel).toHaveBeenCalledWith(expect.objectContaining({ provider: 'fallback', model: 'last' }))
    expect(f.queue).not.toHaveBeenCalled()
    await f.btw.dispose()
    await f.registry.detach(HostKey('one'))
  })

  it('discovers the focused Host fork through the official catalog before retaining or changing the child', async () => {
    const f = await fixture()
    const catalog = deferred<void>()
    f.refresh.mockImplementationOnce(() => catalog.promise)
    const asked = f.btw.ask(ref(), 'side')
    await flush()
    expect(f.fork).toHaveBeenCalledOnce()
    expect(f.selectModel).not.toHaveBeenCalled()
    expect(f.references.some(reference => reference.sessionId === childId)).toBe(false)
    f.setChildCatalogued(true)
    catalog.resolve()
    expect((await asked).ok).toBe(true)
    expect(f.refresh).toHaveBeenCalledOnce()
    await f.btw.dispose()
    await f.registry.detach(HostKey('one'))
  })

  it('performs one fresh catalog read after joining a pull that predates the fork, without repeating the fork', async () => {
    const f = await fixture()
    f.refresh.mockResolvedValueOnce(undefined)
    expect((await f.btw.ask(ref(), 'side')).ok).toBe(true)
    expect(f.refresh).toHaveBeenCalledTimes(2)
    expect(f.fork).toHaveBeenCalledOnce()
    expect(f.selectModel).toHaveBeenCalledOnce()
    await f.btw.dispose()
    await f.registry.detach(HostKey('one'))
  })

  it('refuses a still-absent child or a failed catalog read before model and prompt admission', async () => {
    const f = await fixture()
    f.refresh.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)
    await expect(f.btw.ask(ref(), 'side')).rejects.toThrow('BTW child "child" is absent from the official Session catalog')
    expect(f.refresh).toHaveBeenCalledTimes(2)
    f.refresh.mockRejectedValueOnce(new Error('catalog unavailable'))
    await expect(f.btw.ask(ref(), 'side again')).rejects.toThrow('catalog unavailable')
    expect(f.fork).toHaveBeenCalledTimes(2)
    expect(f.selectModel).not.toHaveBeenCalled()
    expect(f.prompt).not.toHaveBeenCalled()
    expect(f.btw.current()).toBeUndefined()
    await f.btw.dispose()
    await f.registry.detach(HostKey('one'))
  })

  it.each(['generation', 'binding', 'detach', 'abort', 'retry'])('retires catalog discovery after %s before any child write', async replacement => {
    const f = await fixture()
    const catalog = deferred<void>()
    if (replacement === 'retry') f.refresh.mockResolvedValueOnce(undefined)
    f.refresh.mockImplementationOnce(() => catalog.promise)
    const owner = new AbortController()
    const asked = f.btw.ask(ref(), 'side', { signal: owner.signal })
    const retired = expect(asked).rejects.toBeInstanceOf(replacement === 'abort' ? DOMException : RemoteBtwSupersededError)
    await flush()
    if (replacement === 'generation' || replacement === 'retry') f.setGeneration(2)
    else if (replacement === 'binding') {
      const parent = f.references.at(-1)!
      Reflect.set(parent, 'binding', { ...parent.binding })
    } else if (replacement === 'detach') await f.registry.detach(HostKey('one'))
    else owner.abort()
    f.setChildCatalogued(true)
    catalog.resolve()
    await retired
    expect(f.selectModel).not.toHaveBeenCalled()
    expect(f.prompt).not.toHaveBeenCalled()
    expect(f.cancel).not.toHaveBeenCalled()
    await f.btw.dispose()
    await f.registry.detach(HostKey('one'))
  })

  it('refuses missing projection and native default model data before mutating the Host', async () => {
    const f = await fixture()
    f.setModel([])
    f.defaultModel.mockResolvedValueOnce({ ok: true, value: {} } as never)
    await expect(f.btw.ask(ref(), 'side')).rejects.toMatchObject({ name: 'RemoteBtwPreconditionError', reason: 'model-unavailable' })
    expect(f.fork).not.toHaveBeenCalled()
    await f.btw.dispose()
    await f.registry.detach(HostKey('one'))
  })

  it('uses the native default for a blank three-event Session without inventing a recorded selection or effort pin', async () => {
    const f = await fixture()
    f.setModel({ next: null, lastUsed: null })
    f.setHistory(['permission/preset', 'sandbox/mode', 'approval/policy'].map((type, seq) => ({ type: 'event', event: { type, seq } })))
    f.fork.mockResolvedValueOnce({ ok: true, value: { sessionId: childId, historyFloorSeq: 2 } })
    const result = await f.btw.ask(ref(), 'blank side question')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.selection.historyFloorSeq).toBe(2)
    expect(f.defaultModel).toHaveBeenCalledWith({ operation: 'read' }, expect.any(AbortSignal))
    expect(f.selectModel).toHaveBeenCalledOnce()
    expect(f.selectModel).toHaveBeenCalledWith({ sessionId: childId, provider: 'default-provider', model: 'default-model' })
    expect(f.prompt).toHaveBeenCalledOnce()
    await f.btw.dispose()
    await f.registry.detach(HostKey('one'))
  })

  it('keeps a failed native default read structured and does not start a fork', async () => {
    const f = await fixture()
    f.setModel(undefined)
    f.defaultModel.mockResolvedValueOnce(failure as never)
    expect(await f.btw.ask(ref(), 'side')).toEqual(failure)
    expect(f.fork).not.toHaveBeenCalled()
    expect(f.selectModel).not.toHaveBeenCalled()
    await f.btw.dispose()
    await f.registry.detach(HostKey('one'))
  })

  it.each(['generation', 'binding', 'detach', 'abort'])('retires a default-route read after %s without admitting a fork', async replacement => {
    const f = await fixture()
    f.setModel(undefined)
    const fallback = deferred<Awaited<ReturnType<typeof f.defaultModel>>>()
    f.defaultModel.mockImplementationOnce(() => fallback.promise)
    const owner = new AbortController()
    const asked = f.btw.ask(ref(), 'side', { signal: owner.signal })
    const retired = expect(asked).rejects.toBeInstanceOf(replacement === 'abort' ? DOMException : RemoteBtwSupersededError)
    await flush()
    if (replacement === 'generation') f.setGeneration(2)
    else if (replacement === 'binding') {
      const parent = f.references.at(-1)!
      Reflect.set(parent, 'binding', { ...parent.binding })
    } else if (replacement === 'detach') await f.registry.detach(HostKey('one'))
    else owner.abort()
    // Even a structured late refusal belongs to the retired owner.
    fallback.resolve(failure as never)
    await retired
    expect(f.fork).not.toHaveBeenCalled()
    expect(f.prompt).not.toHaveBeenCalled()
    await f.btw.dispose()
    await f.registry.detach(HostKey('one'))
  })

  it('keeps an absent cwd explicit when neither native projection nor catalog supplies one', async () => {
    const f = await fixture()
    f.setCwd(undefined)
    f.setCatalogCwd(undefined)
    const result = await f.btw.ask(ref(), 'side question')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.selection.cwd).toBe('')
    await f.btw.dispose()
    await f.registry.detach(HostKey('one'))
  })

  it('accepts native empty-source creation without an invented history floor', async () => {
    const f = await fixture()
    f.setHistory([])
    f.fork.mockResolvedValueOnce({ ok: true, value: { sessionId: childId } } as never)
    const result = await f.btw.ask(ref(), 'side')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.selection).not.toHaveProperty('historyFloorSeq')
    expect(f.prompt).toHaveBeenCalledOnce()
    await f.btw.dispose()
    await f.registry.detach(HostKey('one'))
  })

  it('preserves structured native fork refusal and does not replay a failed mutation', async () => {
    const f = await fixture()
    f.fork.mockResolvedValueOnce(failure as never)
    expect(await f.btw.ask(ref(), 'side')).toEqual(failure)
    expect(f.selectModel).not.toHaveBeenCalled()
    f.fork.mockRejectedValueOnce(new Error('ordinary fork error'))
    await expect(f.btw.ask(ref(), 'side')).rejects.toThrow('ordinary fork error')
    expect(f.fork).toHaveBeenCalledTimes(2)
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
    const fork = deferred<Awaited<ReturnType<typeof f.fork>>>()
    f.fork.mockImplementationOnce(() => fork.promise)
    const first = f.btw.ask(ref(), 'old question')
    const retired = expect(first).rejects.toBeInstanceOf(RemoteBtwSupersededError)
    await flush()
    const next = f.btw.ask(ref(), 'new question')
    fork.resolve({ ok: true, value: { sessionId: otherId, historyFloorSeq: 37 } })
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
    const fork = deferred<Awaited<ReturnType<typeof f.fork>>>()
    f.fork.mockImplementationOnce(() => fork.promise)
    const asked = f.btw.ask(ref(), 'side')
    const cancelled = expect(asked).rejects.toBeInstanceOf(RemoteBtwSupersededError)
    await flush()
    expect(f.btw.close()).toBe(true)
    expect(f.btw.close()).toBe(false)
    fork.resolve({ ok: true, value: { sessionId: childId, historyFloorSeq: 37 } })
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

  it('reports no open view without changing the primary or cancelling Host work', async () => {
    const f = await fixture()
    expect(f.btw.close()).toBe(false)
    expect(f.btw.close()).toBe(false)
    expect(f.actions.current).toEqual(ref())
    expect(f.cancel).not.toHaveBeenCalled()
    await f.btw.dispose()
    expect(f.btw.close()).toBe(false)
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

  it.each(['generation', 'binding', 'detach'])('rejects a late fork after parent %s replacement without touching the child', async replacement => {
    const f = await fixture()
    const fork = deferred<Awaited<ReturnType<typeof f.fork>>>()
    f.fork.mockImplementationOnce(() => fork.promise)
    const asked = f.btw.ask(ref(), 'side')
    const retired = expect(asked).rejects.toBeInstanceOf(RemoteBtwSupersededError)
    await flush()
    if (replacement === 'generation') f.setGeneration(2)
    else if (replacement === 'binding') {
      const parent = f.references.at(-1)!
      Reflect.set(parent, 'binding', { ...parent.binding })
    } else await f.registry.detach(HostKey('one'))
    fork.resolve({ ok: true, value: { sessionId: childId, historyFloorSeq: 37 } })
    await retired
    expect(f.selectModel).not.toHaveBeenCalled()
    expect(f.prompt).not.toHaveBeenCalled()
    expect(f.cancel).not.toHaveBeenCalled()
    await f.btw.dispose()
    await f.registry.detach(HostKey('one'))
  })

  it('does not acquire a parent or call the Host for a pre-aborted invocation', async () => {
    const f = await fixture()
    const retained = f.references.length
    await expect(f.btw.ask(ref(), 'side', { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.references).toHaveLength(retained)
    expect(f.fork).not.toHaveBeenCalled()
    await f.btw.dispose()
    await f.registry.detach(HostKey('one'))
  })

  it('keeps the current view and pending question intact when a newer invocation is already aborted', async () => {
    const f = await fixture()
    const opened = await f.btw.ask(ref(), 'existing')
    if (!opened.ok) throw opened.error
    const active = opened.value.view.reference
    await expect(f.btw.ask(ref(), 'cancelled', { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.btw.current()).toEqual({ parent: ref(), child: ref('one', childId) })
    expect(active.release).not.toHaveBeenCalled()
    expect(f.fork).toHaveBeenCalledOnce()
    const fork = deferred<Awaited<ReturnType<typeof f.fork>>>()
    f.fork.mockImplementationOnce(() => fork.promise)
    const pending = f.btw.ask(ref(), 'pending')
    await flush()
    await expect(f.btw.ask(ref(), 'also cancelled', { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' })
    fork.resolve({ ok: true, value: { sessionId: childId, historyFloorSeq: 37 } })
    expect((await pending).ok).toBe(true)
    expect(f.prompt).toHaveBeenCalledTimes(2)
    expect(f.cancel).not.toHaveBeenCalled()
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
