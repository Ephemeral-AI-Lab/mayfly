/** The native child browser and operation commands share one retained-view lease owner. @module */
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HostKey, type HostClient } from '../../src/client/types.ts'
import type { RemoteFeatureContext, RemoteFeatureSelection } from '../../src/remote/features.ts'
import { mountRemoteOperationsComposition } from '../../src/remote/operations-composition.ts'
import type { RemoteOperationsContext } from '../../src/remote/operations/support.ts'

const mounts = vi.hoisted(() => ({ mount: vi.fn(), disposers: Array.from({ length: 13 }, () => vi.fn()) }))
vi.mock('../../src/remote/operations/agents.ts', () => ({ mountRemoteAgentsOperations: mounts.mount }))
vi.mock('../../src/remote/operations/btw.ts', () => ({ mountRemoteBtwOperations: mounts.mount }))
vi.mock('../../src/remote/operations/retract.ts', () => ({ mountRemoteRetractOperations: mounts.mount }))
vi.mock('../../src/remote/operations/changes.ts', () => ({ mountRemoteChangesOperations: mounts.mount }))
vi.mock('../../src/remote/operations/export.ts', () => ({ mountRemoteExportOperations: mounts.mount }))
vi.mock('../../src/remote/operations/trace.ts', () => ({ mountRemoteTraceOperations: mounts.mount }))
vi.mock('../../src/remote/operations/stats.ts', () => ({ mountRemoteStatsOperations: mounts.mount }))
vi.mock('../../src/remote/operations/plugins.ts', () => ({ mountRemotePluginOperations: mounts.mount }))
vi.mock('../../src/remote/operations/copy.ts', () => ({ mountRemoteCopyOperations: mounts.mount }))
vi.mock('../../src/remote/operations/files.ts', () => ({ mountRemoteFilesOperations: mounts.mount }))
vi.mock('../../src/remote/operations/presets.ts', () => ({ mountRemotePresetOperations: mounts.mount }))
vi.mock('../../src/remote/operations/providers.ts', () => ({ mountRemoteProviderOperations: mounts.mount }))
vi.mock('../../src/remote/operations/title.ts', () => ({ mountRemoteTitleOperations: mounts.mount }))

beforeEach(() => { mounts.mount.mockReset(); for (const dispose of mounts.disposers) dispose.mockClear(); mounts.mount.mockImplementation(() => mounts.disposers[(mounts.mount.mock.calls.length - 1) % 13]) })

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
  let generation = 1
  const subagentAddress = vi.fn((_id: ReturnType<typeof SessionId>): SubagentAddress | undefined => address)
  const refreshProjections = vi.fn(async (_id: ReturnType<typeof SessionId>) => {})
  const client = { key: ref.host, state: { getSnapshot: () => ({ generation }) }, sessions: { subagentAddress, refreshProjections, list: { getSnapshot: () => ({ byId: options.empty ? {} : { child: { displayTitle: 'Worker', cwd: '/host/repo' } } }) } } } as unknown as HostClient
  let current: RemoteFeatureSelection | undefined = { client, ref, binding }
  let attached: readonly HostClient[] = [client]
  const base = { hosts: { current: () => current, list: () => attached }, commands: {} } as unknown as RemoteFeatureContext
  const leases: Array<{ ready: Promise<SessionBinding>, release: ReturnType<typeof vi.fn> }> = []
  const retain = vi.fn(() => {
    const lease = { ready: Promise.resolve(binding), release: vi.fn() }
    leases.push(lease)
    return lease
  })
  const activeBtw = vi.fn(() => undefined as { readonly child: typeof ref } | undefined)
  const closeBtw = vi.fn()
  const present = vi.fn()
  const closePresent = vi.fn()
  const copy = vi.fn(async () => {})
  const handle = mountRemoteOperationsComposition(base, { localCwd: '/local', btw: { retainColdSubagentView: retain, current: activeBtw, close: closeBtw } as never, ...options.noCallbacks ? {} : { present, closePresent, copy } })
  const contexts = mounts.mount.mock.calls.map(call => call[0] as RemoteOperationsContext)
  return { base, ref, address, binding, client, subagentAddress, refreshProjections, retain, leases, activeBtw, closeBtw, present, closePresent, copy, handle, contexts,
    reconnect() { generation += 1 },
    select(next: typeof current) { current = next },
    detach() { attached = [] },
  }
}

describe('retained child operation composition', () => {
  it('uses the shared owner, resolves unknown native mode, and retains different children independently', async () => {
    const f = fixture()
    expect(f.contexts).toHaveLength(13)
    expect(f.contexts.every(context => context === f.contexts[0])).toBe(true)
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

  it('unwinds only completed mounts when composition registration fails', () => {
    mounts.mount.mockImplementationOnce(() => mounts.disposers[0]).mockImplementationOnce(() => { throw new Error('failed mount') })
    expect(() => fixture()).toThrow('failed mount')
    expect(mounts.disposers[0]).toHaveBeenCalledOnce()
    expect(mounts.disposers[1]).not.toHaveBeenCalled()
  })
})
