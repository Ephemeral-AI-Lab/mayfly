/** BTW command access metadata, inherited history floor, and exact-generation cleanup. @module */
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it, vi } from 'vitest'
import { HostKey, type HostClient } from '../../src/client/types.ts'
import type { RemoteFeatureSelection } from '../../src/remote/features.ts'
import { RemoteFeatureCommandRegistry } from '../../src/remote/features/commands.ts'
import { mountRemoteBtwOperations } from '../../src/remote/operations/btw.ts'
import { RemotePresentSlot, type RemoteOperationsContext } from '../../src/remote/operations/support.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function fixture(floor: number | null = 25) {
  const ref = { host: HostKey('one'), sessionId: SessionId('lead') }
  const child = { ...ref, sessionId: SessionId('btw') }
  const topology = new Set<() => void>()
  const connections = new Set<() => void>()
  const subscribe = (listeners: Set<() => void>) => (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  let generation = 1
  const client = { key: ref.host, state: { getSnapshot: () => ({ generation }), subscribe: subscribe(connections) } } as unknown as HostClient
  let current: RemoteFeatureSelection | undefined = { ref, client, binding: {} as SessionBinding }
  let attached: readonly HostClient[] = [client]
  const hosts = { current: () => current, list: () => attached, subscribe: subscribe(topology) }
  const locale = { register: vi.fn(), subscribe: vi.fn(() => () => {}), translate: vi.fn((_namespace: string, key: string) => key) }
  const effect = (fn: () => unknown) => { fn(); return () => {} }
  const ctx = { effect, mayflyLocale: locale, get: (name: string) => name === 'mayflyLocale' ? locale : undefined, inject: (_names: readonly string[], callback: (scope: unknown) => void) => { callback({ mayflyLocale: locale, effect }) } }
  const binding = {} as SessionBinding
  const session = { parent: ref, child, view: { ready: Promise.resolve(binding) }, selection: { ref: child, cwd: '/host/repo', ...floor === null ? {} : { historyFloorSeq: floor } } }
  const ask = vi.fn(async () => ({ ok: true as const, value: session }))
  const active = vi.fn(() => ({ parent: ref, child }))
  const close = vi.fn()
  const present = vi.fn()
  const closePresent = vi.fn()
  const slot = new RemotePresentSlot({ present, closePresent })
  const notice = { set: vi.fn() }
  const commands = new RemoteFeatureCommandRegistry()
  const context = { base: { ctx, hosts, notice, commands }, options: { btw: { ask, current: active, close } }, presentSlot: slot } as unknown as RemoteOperationsContext
  const unmount = mountRemoteBtwOperations(context)
  const command = commands.list()[0]!
  return { ref, child, client, binding, session, ask, active, close, present, closePresent, slot, notice, commands, command, unmount, topology, connections,
    execute: (text: string, signal = new AbortController().signal) => command.execute(text, signal),
    reconnect() { generation += 1; for (const listener of connections) listener() },
    select(next: RemoteFeatureSelection | undefined) { current = next; for (const listener of topology) listener() },
    detach() { attached = []; current = undefined; for (const listener of topology) listener() },
  }
}

describe('native BTW command composition', () => {
  it('presents the exact BTW binding with inherited history and closes only that view', async () => {
    const f = fixture()
    await expect(f.execute(' ')).rejects.toThrow('Usage: /btw')
    await f.execute(' explain this ')
    expect(f.ask).toHaveBeenCalledWith(f.ref, 'explain this', { signal: expect.any(AbortSignal) })
    expect(f.present).toHaveBeenCalledWith(f.child, f.binding, { kind: 'btw', access: 'interactive', label: 'btw', cwd: '/host/repo', historyFloorSeq: 25 })
    expect(f.notice.set).toHaveBeenLastCalledWith('BTW question shown in the side view')
    await f.execute('close')
    expect(f.closePresent).toHaveBeenCalledWith(f.child)
    expect(f.close).toHaveBeenCalledOnce()
    expect(f.notice.set).toHaveBeenLastCalledWith('BTW view closed; the side session keeps running')
    f.unmount()
    expect(f.commands.list()).toEqual([])
    expect(f.topology.size + f.connections.size).toBe(0)
    await f.execute('after unload')
    expect(f.ask).toHaveBeenCalledOnce()
  })

  it('preserves absence of a history floor and reports a current native failure', async () => {
    const f = fixture(null)
    await f.execute('question')
    expect(f.present.mock.calls[0]![2]).not.toHaveProperty('historyFloorSeq')
    f.ask.mockResolvedValueOnce({ ok: false, error: { code: 'fork-denied', message: 'fork denied' } } as never)
    await expect(f.execute('denied')).rejects.toMatchObject({ code: 'fork-denied' })
    f.select(undefined)
    await expect(f.execute('sessionless')).rejects.toThrow('No current session')
    f.unmount()
  })

  it('aborts pending work on reconnection and never presents a late BTW binding', async () => {
    const f = fixture()
    const ready = deferred<SessionBinding>()
    const asking = deferred<Awaited<ReturnType<typeof f.ask>>>()
    f.ask.mockReturnValueOnce(asking.promise)
    const pending = f.execute('late')
    f.reconnect()
    const capturedSignal = (f.ask.mock.calls[0] as unknown as readonly [unknown, unknown, { readonly signal: AbortSignal }])[2].signal
    expect(capturedSignal.aborted).toBe(true)
    asking.resolve({ ok: true, value: { ...f.session, view: { ready: ready.promise } } })
    ready.resolve(f.binding)
    await pending
    expect(f.present).not.toHaveBeenCalled()
    expect(f.close).toHaveBeenCalledOnce()
    expect(f.notice.set).not.toHaveBeenCalled()
    f.unmount()
  })

  it('keeps a newer native BTW active and suppresses failures after detach or unload', async () => {
    const f = fixture()
    const asking = deferred<Awaited<ReturnType<typeof f.ask>>>()
    f.ask.mockReturnValueOnce(asking.promise)
    const pending = f.execute('older')
    f.active.mockReturnValue({ parent: f.ref, child: { ...f.child, sessionId: SessionId('newer') } })
    f.select({ ref: f.ref, client: { ...f.client }, binding: {} as SessionBinding })
    asking.resolve({ ok: true, value: f.session })
    await pending
    expect(f.close).not.toHaveBeenCalled()
    const failed = deferred<Awaited<ReturnType<typeof f.ask>>>()
    f.select({ ref: f.ref, client: f.client, binding: {} as SessionBinding })
    f.ask.mockReturnValueOnce(failed.promise)
    const pendingFailure = f.execute('detached')
    f.detach()
    failed.reject(new Error('stale native failure'))
    await expect(pendingFailure).resolves.toBeUndefined()
    f.unmount()
  })

  it('rejects a pre-aborted generation before creating Host work and suppresses late failed results', async () => {
    const f = fixture()
    const signal = new AbortController(); signal.abort()
    await f.execute('already cancelled', signal.signal)
    expect(f.ask).not.toHaveBeenCalled()
    const asking = deferred<Awaited<ReturnType<typeof f.ask>>>()
    f.ask.mockReturnValueOnce(asking.promise)
    const pending = f.execute('unload')
    f.unmount()
    asking.resolve({ ok: false, error: { code: 'stale' } } as never)
    await expect(pending).resolves.toBeUndefined()
    expect(f.present).not.toHaveBeenCalled()
  })
})
