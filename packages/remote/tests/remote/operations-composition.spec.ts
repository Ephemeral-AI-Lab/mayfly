/** The native child browser and operation commands share one retained-view lease owner. @module */
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HostKey, type HostClient } from '../../src/client/types.ts'
import type { RemoteFeatureContext, RemoteFeatureSelection } from '../../src/remote/features.ts'
import { mountRemoteOperationsComposition } from '../../src/remote/operations-composition.ts'
import type { RemoteOperationsContext } from '../../src/remote/operations/support.ts'

const mounts = vi.hoisted(() => ({ mount: vi.fn(), disposers: Array.from({ length: 12 }, () => vi.fn()) }))
vi.mock('../../src/remote/operations/agents.ts', () => ({ mountRemoteAgentsOperations: mounts.mount }))
vi.mock('../../src/remote/operations/btw.ts', () => ({ mountRemoteBtwOperations: mounts.mount }))
vi.mock('../../src/remote/operations/retract.ts', () => ({ mountRemoteRetractOperations: mounts.mount }))
vi.mock('../../src/remote/operations/export.ts', () => ({ mountRemoteExportOperations: mounts.mount }))
vi.mock('../../src/remote/operations/trace.ts', () => ({ mountRemoteTraceOperations: mounts.mount }))
vi.mock('../../src/remote/operations/stats.ts', () => ({ mountRemoteStatsOperations: mounts.mount }))
vi.mock('../../src/remote/operations/plugins.ts', () => ({ mountRemotePluginOperations: mounts.mount }))
vi.mock('../../src/remote/operations/copy.ts', () => ({ mountRemoteCopyOperations: mounts.mount }))
vi.mock('../../src/remote/operations/files.ts', () => ({ mountRemoteFilesOperations: mounts.mount }))
vi.mock('../../src/remote/operations/presets.ts', () => ({ mountRemotePresetOperations: mounts.mount }))
vi.mock('../../src/remote/operations/providers.ts', () => ({ mountRemoteProviderOperations: mounts.mount }))
vi.mock('../../src/remote/operations/title.ts', () => ({ mountRemoteTitleOperations: mounts.mount }))

beforeEach(() => { mounts.mount.mockReset(); for (const dispose of mounts.disposers) dispose.mockClear(); mounts.mount.mockImplementation(() => mounts.disposers[(mounts.mount.mock.calls.length - 1) % 12]) })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function fixture(options: { readonly empty?: boolean, readonly noCallbacks?: boolean } = {}) {
  const ref = { host: HostKey('one'), sessionId: SessionId('lead') }
  const address: SubagentAddress = { parentSessionId: ref.sessionId, childSessionId: SessionId('child'), mode: 'continuable' }
  const binding = {} as SessionBinding
  const topology = new Set<() => void>()
  const connection = new Set<() => void>()
  const subscribe = (listeners: Set<() => void>) => (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  let generation = 1
  const subagentAddress = vi.fn((_id: ReturnType<typeof SessionId>): SubagentAddress | undefined => address)
  const refreshProjections = vi.fn(async (_id: ReturnType<typeof SessionId>) => {})
  const list = vi.fn(async (_request: object, _signal?: AbortSignal): ReturnType<HostClient['remote']['session']['list']> => ({ ok: true, value: { items: [{ sessionId: address.childSessionId, agentAvailable: false, blank: false, running: false, updatedAt: 1 }] } }))
  const client = { key: ref.host, state: { getSnapshot: () => ({ generation }), subscribe: subscribe(connection) }, remote: { session: { list } }, sessions: { subagentAddress, refreshProjections, list: { getSnapshot: () => ({ byId: options.empty ? {} : { child: { displayTitle: 'Worker', cwd: '/host/repo' } } }) } } } as unknown as HostClient
  let current: RemoteFeatureSelection | undefined = { client, ref, binding }
  let attached: readonly HostClient[] = [client]
  const base = { hosts: { current: () => current, list: () => attached, subscribe: subscribe(topology) }, commands: {} } as unknown as RemoteFeatureContext
  const leases: Array<{ ready: Promise<SessionBinding>, release: ReturnType<typeof vi.fn> }> = []
  const retain = vi.fn(() => {
    const lease = { ready: Promise.resolve(binding), release: vi.fn() }
    leases.push(lease)
    return lease
  })
  const activeBtw = vi.fn(() => undefined as { readonly child: typeof ref } | undefined)
  const retainBtw = vi.fn(retain)
  const closeBtw = vi.fn()
  const present = vi.fn()
  const closePresent = vi.fn()
  const copy = vi.fn(async () => {})
  const modelCatalog = vi.fn(() => undefined)
  const primary = () => current
  const showPrimary = vi.fn()
  const handle = mountRemoteOperationsComposition(base, { localCwd: '/local', btw: { retainColdSubagentView: retain, retainBtwView: retainBtw, current: activeBtw, close: closeBtw } as never, ...options.noCallbacks ? {} : { present, closePresent, copy, modelCatalog, primary, showPrimary } })
  const contexts = mounts.mount.mock.calls.map(call => call[0] as RemoteOperationsContext)
  return { base, ref, address, binding, client, list, subagentAddress, refreshProjections, retain, retainBtw, leases, activeBtw, closeBtw, present, closePresent, copy, modelCatalog, primary, showPrimary, handle, contexts,
    topology, connection,
    reconnect() { generation += 1; for (const listener of connection) listener() },
    select(next: typeof current) { current = next; for (const listener of topology) listener() },
    detach() { attached = []; for (const listener of topology) listener() },
  }
}

describe('retained child operation composition', () => {
  it('reads live access from the passive native whole list before presenting a continuable child', async () => {
    const f = fixture()
    f.list.mockResolvedValueOnce({ ok: true, value: { items: [
      { sessionId: SessionId('unrelated'), agentAvailable: true, blank: false, running: false, updatedAt: 1 },
      { sessionId: f.address.childSessionId, agentAvailable: true, blank: false, running: false, updatedAt: 1 },
    ] } })
    await f.handle.openChild(f.client, f.address, new AbortController().signal)
    expect(f.list).toHaveBeenCalledWith({}, expect.any(AbortSignal))
    expect(f.present.mock.calls[0]![2]).toMatchObject({ access: 'interactive', address: f.address })
    expect(f.refreshProjections).not.toHaveBeenCalled()
    f.handle.dispose()
  })

  it('keeps native availability refusal visible and never substitutes a guessed Agent or retains after retirement', async () => {
    const f = fixture()
    f.list.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'native list denied', {}) })
    await expect(f.handle.openChild(f.client, f.address, new AbortController().signal)).rejects.toThrow('native list denied')
    expect(f.retain).not.toHaveBeenCalled()
    for (const failure of [false, true]) {
      const gate = deferred<Awaited<ReturnType<typeof f.list>>>()
      f.list.mockReturnValueOnce(gate.promise)
      const pending = f.handle.openChild(f.client, f.address, new AbortController().signal)
      const signal = f.list.mock.calls.at(-1)![1]!
      f.reconnect()
      expect(signal.aborted).toBe(true)
      if (failure) gate.reject(new Error('retired list failure'))
      else gate.resolve({ ok: true, value: { items: [] } })
      await expect(pending).resolves.toBeUndefined()
    }
    expect(f.retain).not.toHaveBeenCalled()
    expect(f.present).not.toHaveBeenCalled()
    f.handle.dispose()
  })

  it('admits a replacement BTW before its old descriptor removal triggers residency updates', () => {
    const f = fixture()
    let retained: readonly typeof f.ref[] = []
    f.present.mockImplementation(ref => { retained = [ref]; f.handle.retainOnly(retained) })
    f.closePresent.mockImplementation(ref => { retained = retained.filter(item => item.sessionId !== ref?.sessionId); f.handle.retainOnly(retained) })
    const first = { ...f.ref, sessionId: SessionId('btw-first') }
    const next = { ...f.ref, sessionId: SessionId('btw-next') }
    const facts = { kind: 'btw' as const, access: 'interactive' as const }
    f.activeBtw.mockReturnValue({ child: first })
    f.contexts[0]!.presentSlot.present(first, f.binding, facts)
    f.activeBtw.mockReturnValue({ child: next })
    f.contexts[0]!.presentSlot.present(next, f.binding, facts)
    expect(f.closeBtw).not.toHaveBeenCalled()
    expect(retained).toEqual([next])
    f.activeBtw.mockReturnValue(undefined)
    f.handle.dispose()
  })

  it('parks listed child and BTW bindings, preserving descriptors and reacquiring the ordinary fork', async () => {
    const f = fixture()
    await f.handle.openChild(f.client, f.address, new AbortController().signal)
    const child = { host: f.ref.host, sessionId: f.address.childSessionId }
    const btw = { ...child, sessionId: SessionId('btw') }
    const facts = { kind: 'btw' as const, access: 'interactive' as const, label: 'side question', historyFloorSeq: 8 }
    f.contexts[0]!.presentSlot.present(btw, f.binding, facts)
    f.activeBtw.mockReturnValue({ child: btw })
    f.handle.retainOnly([child, btw])
    expect(f.closeBtw).not.toHaveBeenCalled()
    expect(f.leases[0]!.release).not.toHaveBeenCalled()
    f.handle.retainOnly([child])
    expect(f.closeBtw).toHaveBeenCalledOnce()
    expect(f.closePresent).not.toHaveBeenCalled()
    await f.handle.openBtw(f.client, btw, facts, new AbortController().signal)
    expect(f.retainBtw).toHaveBeenCalledWith(btw, 'remote-btw-retained')
    expect(f.present).toHaveBeenLastCalledWith(btw, f.binding, facts)
    f.handle.retainOnly([btw])
    expect(f.leases[0]!.release).toHaveBeenCalledOnce()
    expect(f.leases[1]!.release).not.toHaveBeenCalled()
    f.handle.dispose()
    expect(f.leases[1]!.release).toHaveBeenCalledOnce()
  })

  it('fences ordinary BTW reacquisition against cancellation, other Hosts, lost selection, and unload', async () => {
    const f = fixture()
    const btw = { ...f.ref, sessionId: SessionId('btw') }
    const facts = { kind: 'btw' as const, access: 'interactive' as const }
    const aborted = new AbortController(); aborted.abort()
    await f.handle.openBtw(f.client, btw, facts, aborted.signal)
    await f.handle.openBtw({ ...f.client }, btw, facts, new AbortController().signal)
    await f.handle.openBtw(f.client, { ...btw, host: HostKey('other') }, facts, new AbortController().signal)
    f.detach()
    await f.handle.openBtw(f.client, btw, facts, new AbortController().signal)
    expect(f.retainBtw).not.toHaveBeenCalled()
    f.handle.dispose()
    await f.handle.openBtw(f.client, btw, facts, new AbortController().signal)
    expect(f.retainBtw).not.toHaveBeenCalled()
  })

  it('immediately releases in-flight BTW leases on reconnection, selection, detach, or composition unload', async () => {
    for (const retire of ['reconnect', 'select', 'detach', 'dispose'] as const) {
      const f = fixture()
      const ready = deferred<SessionBinding>()
      const release = vi.fn()
      f.retainBtw.mockReturnValueOnce({ ready: ready.promise, release })
      const pending = f.handle.openBtw(f.client, { ...f.ref, sessionId: SessionId('btw') }, { kind: 'btw', access: 'interactive' }, new AbortController().signal)
      if (retire === 'dispose') f.handle.dispose()
      else if (retire === 'select') f.select(undefined)
      else f[retire]()
      expect(release, retire).toHaveBeenCalledOnce()
      ready.reject(new Error('released native binding'))
      await expect(pending).resolves.toBeUndefined()
      expect(f.present).not.toHaveBeenCalled()
      expect(f.topology.size + f.connection.size).toBe(0)
      f.handle.dispose()
    }
  })

  it('uses the shared owner, resolves unknown native mode, and retains different children independently', async () => {
    const f = fixture()
    expect(f.contexts).toHaveLength(12)
    expect(f.contexts.every(context => context === f.contexts[0])).toBe(true)
    expect(f.contexts[0]!.options.primary?.()).toEqual(f.primary())
    f.contexts[0]!.options.showPrimary?.()
    expect(f.showPrimary).toHaveBeenCalledOnce()
    await f.handle.openChild(f.client, { ...f.address, mode: 'unknown' }, new AbortController().signal)
    expect(f.refreshProjections).toHaveBeenCalledWith('lead')
    expect(f.retain).toHaveBeenCalledWith(f.ref, { host: 'one', sessionId: 'child' }, 'remote-agents-cold')
    expect(f.present).toHaveBeenLastCalledWith({ host: 'one', sessionId: 'child' }, f.binding, { kind: 'subagent', access: 'resumable', label: 'Worker', cwd: '/host/repo', address: f.address })
    const second = { ...f.address, childSessionId: SessionId('second'), mode: 'one-shot' as const }
    f.subagentAddress.mockReturnValue(second)
    await f.handle.openChild(f.client, second, new AbortController().signal)
    expect(f.present.mock.calls[1]![2]).toMatchObject({ access: 'readonly', address: second })
    expect(f.leases[0]!.release).not.toHaveBeenCalled()
    f.handle.closeChild({ host: f.ref.host, sessionId: f.address.childSessionId })
    expect(f.leases[0]!.release).toHaveBeenCalledOnce()
    expect(f.leases[1]!.release).not.toHaveBeenCalled()
    const btw = { ...f.ref, sessionId: SessionId('btw') }
    f.activeBtw.mockReturnValue({ child: btw })
    f.handle.closeChild(btw)
    expect(f.closeBtw).toHaveBeenCalledOnce()
    f.contexts[0]!.options.present?.(btw, f.binding, { kind: 'btw', access: 'interactive' })
    f.contexts[0]!.options.closePresent?.(btw)
    expect(f.closePresent).toHaveBeenLastCalledWith(btw)
    f.handle.dispose(); f.handle.dispose()
    expect(f.leases[1]!.release).toHaveBeenCalledOnce()
    expect(mounts.disposers.every(dispose => dispose.mock.calls.length === 1)).toBe(true)
  })

  it('fences native reads on cancellation, exact binding changes, reconnection, detach, and unload', async () => {
    const f = fixture({ empty: true })
    const signal = new AbortController()
    signal.abort()
    await f.handle.openChild(f.client, f.address, signal.signal)
    await f.handle.openChild({ ...f.client }, f.address, new AbortController().signal)
    expect(f.retain).not.toHaveBeenCalled()
    const projected = deferred<void>()
    f.refreshProjections.mockReturnValueOnce(projected.promise)
    const stale = f.handle.openChild(f.client, { ...f.address, mode: 'unknown' }, new AbortController().signal)
    f.reconnect(); projected.resolve(); await stale
    expect(f.retain).not.toHaveBeenCalled()
    const ready = deferred<SessionBinding>()
    const release = vi.fn()
    f.retain.mockReturnValueOnce({ ready: ready.promise, release })
    const controller = new AbortController()
    const pending = f.handle.openChild(f.client, f.address, controller.signal)
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()
    expect(release).toHaveBeenCalledOnce()
    ready.resolve(f.binding); await pending
    expect(f.present).not.toHaveBeenCalled()
    f.detach()
    await f.handle.openChild(f.client, f.address, new AbortController().signal)
    expect(f.retain).toHaveBeenCalledOnce()
    f.handle.dispose()
    await f.handle.openChild(f.client, f.address, new AbortController().signal)
    expect(f.retain).toHaveBeenCalledOnce()
  })

  it('uses readonly native fallbacks, releases failed bindings, and accepts an optional display integration', async () => {
    const f = fixture({ empty: true, noCallbacks: true })
    f.subagentAddress.mockReturnValue(undefined)
    await f.handle.openChild(f.client, f.address, new AbortController().signal)
    f.handle.closeChild({ host: f.ref.host, sessionId: f.address.childSessionId })
    expect(f.leases[0]!.release).toHaveBeenCalledOnce()
    const release = vi.fn()
    f.retain.mockReturnValueOnce({ ready: Promise.reject(new Error('read failed')), release })
    await expect(f.handle.openChild(f.client, f.address, new AbortController().signal)).rejects.toThrow('read failed')
    expect(release).toHaveBeenCalledOnce()
    f.handle.dispose()
  })

  it('shares the readonly model catalog and preserves failures of a current BTW admission', async () => {
    const f = fixture()
    expect(f.contexts[0]!.options.modelCatalog).toBe(f.modelCatalog)
    const ready = deferred<SessionBinding>()
    const release = vi.fn()
    f.retainBtw.mockReturnValueOnce({ ready: ready.promise, release })
    const pending = f.handle.openBtw(f.client, { ...f.ref, sessionId: SessionId('btw') }, { kind: 'btw', access: 'interactive' }, new AbortController().signal)
    // A native connection notification with the same generation keeps this admission alive.
    for (const listener of f.connection) listener()
    ready.reject(new Error('native binding refused'))
    await expect(pending).rejects.toThrow('native binding refused')
    expect(release).toHaveBeenCalledOnce()
    const child = deferred<SessionBinding>()
    f.retain.mockReturnValueOnce({ ready: child.promise, release: vi.fn() })
    const old = f.handle.openChild(f.client, f.address, new AbortController().signal)
    await Promise.resolve()
    await Promise.resolve()
    f.reconnect()
    child.reject(new Error('retired native binding'))
    await expect(old).resolves.toBeUndefined()
    f.handle.dispose()
  })

  it('unwinds only completed mounts when composition registration fails', () => {
    mounts.mount.mockImplementationOnce(() => mounts.disposers[0]).mockImplementationOnce(() => { throw new Error('failed mount') })
    expect(() => fixture()).toThrow('failed mount')
    expect(mounts.disposers[0]).toHaveBeenCalledOnce()
    expect(mounts.disposers[1]).not.toHaveBeenCalled()
  })
})
