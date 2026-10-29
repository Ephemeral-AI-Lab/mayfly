import { describe, expect, it, vi } from 'vitest'
import type {
  ISessions, SessionBinding, SessionReference,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { HostKey, type HostClient, type SessionRef } from '../../src/client/types.ts'
import {
  HostNotAttachedError, HostOperationSupersededError, HostRegistry,
} from '../../src/frontend/host-registry.ts'

function deferred<T>(): PromiseWithResolvers<T> {
  return Promise.withResolvers<T>()
}

function sessionId(value: string): SessionId {
  return value as SessionId
}

function sessionRef(host: HostKey, id = 'shared'): SessionRef {
  return { host, sessionId: sessionId(id) }
}

function makeReference(id: SessionId, ready?: Promise<SessionBinding>): SessionReference {
  const binding = { sessionId: id } as SessionBinding
  const readiness = Promise.withResolvers<SessionBinding>()
  if (ready === undefined) readiness.resolve(binding)
  else void ready.then(readiness.resolve, readiness.reject)
  let released = false
  const reference: SessionReference = {
    sessionId: id,
    get binding() {
      if (released) throw new Error(`Session reference "${id}" is released`)
      return binding
    },
    ready: readiness.promise,
    release: vi.fn(() => {
      if (released) return
      released = true
      // The official reference rejects its readiness when released, which is
      // how detach unblocks an in-flight commitSelection await.
      readiness.reject(new Error(`Session reference "${id}" is released`))
    }),
    [Symbol.dispose]: () => { reference.release() },
  }
  return reference
}

function makeHost(
  key: HostKey,
  retain: ISessions['retain'] = () => { throw new Error('Unexpected retain') },
): { readonly client: HostClient, readonly detach: ReturnType<typeof vi.fn> } {
  const detach = vi.fn(async () => {})
  const sessions = { retain } as ISessions
  return {
    client: {
      key,
      connection: {} as HostClient['connection'],
      remote: {} as HostClient['remote'],
      fileUpload: {} as HostClient['fileUpload'],
      origin: 'http://127.0.0.1:3080',
      state: {} as HostClient['state'],
      sessions,
      workspaces: {} as HostClient['workspaces'],
      detach,
    },
    detach,
  }
}

describe('HostRegistry', () => {
  it('shares same-key attaches and lists only committed Host generations', async () => {
    const key = HostKey('one')
    const produced = deferred<HostClient>()
    const factory = vi.fn(() => produced.promise)
    const registry = new HostRegistry(factory)
    const first = registry.attach(key)
    const second = registry.attach(key)

    expect(second).toBe(first)
    expect(factory).toHaveBeenCalledOnce()
    expect(registry.list()).toEqual([])
    expect(registry.get(key)).toBeUndefined()

    const { client } = makeHost(key)
    produced.resolve(client)
    await expect(first).resolves.toBe(client)
    await expect(registry.attach(key)).resolves.toBe(client)
    expect(factory).toHaveBeenCalledOnce()
    expect(registry.list()).toEqual([client])
    expect(registry.get(key)).toBe(client)
    expect(registry.current).toBeUndefined()
    expect(registry.currentReference).toBeUndefined()
  })

  it('allows retries after synchronous and asynchronous factory failures', async () => {
    const key = HostKey('retry')
    const synchronous = new Error('sync failure')
    const asynchronous = new Error('async failure')
    const { client } = makeHost(key)
    let attempt = 0
    const factory = vi.fn(() => {
      attempt += 1
      if (attempt === 1) throw synchronous
      if (attempt === 2) return Promise.reject(asynchronous)
      return Promise.resolve(client)
    })
    const registry = new HostRegistry(factory)

    await expect(registry.attach(key)).rejects.toBe(synchronous)
    expect(registry.list()).toEqual([])
    await expect(registry.attach(key)).rejects.toBe(asynchronous)
    expect(registry.list()).toEqual([])
    await expect(registry.attach(key)).resolves.toBe(client)
    expect(factory).toHaveBeenCalledTimes(3)
  })

  it('releases a stale attach without replacing its newer generation', async () => {
    const key = HostKey('stale-attach')
    const oldProduced = deferred<HostClient>()
    const newProduced = deferred<HostClient>()
    const factory = vi.fn()
      .mockImplementationOnce(() => oldProduced.promise)
      .mockImplementationOnce(() => newProduced.promise)
    const registry = new HostRegistry(factory)
    const oldAttach = registry.attach(key)
    const detached = registry.detach(key)
    const newAttach = registry.attach(key)
    const oldHost = makeHost(key)
    const newHost = makeHost(key)

    newProduced.resolve(newHost.client)
    await expect(newAttach).resolves.toBe(newHost.client)
    const oldRejection = expect(oldAttach).rejects.toBeInstanceOf(HostOperationSupersededError)
    oldProduced.resolve(oldHost.client)
    await oldRejection
    await detached

    expect(oldHost.detach).toHaveBeenCalledOnce()
    expect(newHost.detach).not.toHaveBeenCalled()
    expect(registry.get(key)).toBe(newHost.client)
    expect(registry.list()).toEqual([newHost.client])
  })

  it('surfaces stale Client cleanup failure while preserving the replacement', async () => {
    const key = HostKey('stale-cleanup')
    const oldProduced = deferred<HostClient>()
    const registry = new HostRegistry(() => oldProduced.promise)
    const oldAttach = registry.attach(key)
    const detached = registry.detach(key)
    const oldHost = makeHost(key)
    const cleanupFailure = new Error('cleanup failed')
    oldHost.detach.mockRejectedValue(cleanupFailure)
    const oldRejection = expect(oldAttach).rejects.toBeInstanceOf(AggregateError)

    oldProduced.resolve(oldHost.client)
    await oldRejection
    await expect(detached).rejects.toBe(cleanupFailure)
    expect(registry.get(key)).toBeUndefined()
    expect(oldHost.detach).toHaveBeenCalledOnce()

    const mismatched = makeHost(HostKey('other'))
    const wrongRegistry = new HostRegistry(() => mismatched.client)
    await expect(wrongRegistry.attach(HostKey('requested'))).rejects.toThrow('returned Client')
    expect(mismatched.detach).toHaveBeenCalledOnce()
  })

  it('commits only the newest selection and releases stale and replaced references', async () => {
    const hostA = HostKey('host-a')
    const hostB = HostKey('host-b')
    const initial = makeReference(sessionId('initial'))
    const late = deferred<SessionBinding>()
    const lateReference = makeReference(sessionId('shared'), late.promise)
    const selected = makeReference(sessionId('shared'))
    const aReferences = [initial, lateReference]
    const bReferences = [selected]
    const retainA = vi.fn(() => aReferences.shift()!)
    const retainB = vi.fn(() => bReferences.shift()!)
    const a = makeHost(hostA, retainA)
    const b = makeHost(hostB, retainB)
    const clients = new Map([[hostA, a.client], [hostB, b.client]])
    const registry = new HostRegistry(key => clients.get(key)!)
    await Promise.all([registry.attach(hostA), registry.attach(hostB)])

    await registry.select(sessionRef(hostA, 'initial'))
    const lateSelect = registry.select(sessionRef(hostA))
    await vi.waitFor(() => { expect(retainA).toHaveBeenCalledTimes(2) })
    const committing = registry.select(sessionRef(hostB))

    const lateRejection = expect(lateSelect).rejects.toMatchObject({
      name: 'HostOperationSupersededError', operation: 'select', host: hostA,
    })
    late.resolve({ sessionId: sessionId('shared') } as SessionBinding)
    await lateRejection
    expect(lateReference.release).toHaveBeenCalledOnce()
    expect(selected.release).not.toHaveBeenCalled()

    const selectedRef = await committing
    expect(selectedRef).toEqual(sessionRef(hostB))
    expect(registry.current).toBe(selectedRef)
    expect(registry.currentReference).toBe(selected)
    expect(initial.release).toHaveBeenCalledOnce()

    await expect(registry.select(sessionRef(hostB))).resolves.toBe(selectedRef)
    expect(retainB).toHaveBeenCalledOnce()
    expect(retainA).toHaveBeenCalledTimes(2)
    expect(retainA).toHaveBeenLastCalledWith(sessionId('shared'), expect.objectContaining({ source: 'mayflyFrontend' }))
    expect(retainB).toHaveBeenCalledWith(sessionId('shared'), expect.objectContaining({ source: 'mayflyFrontend' }))
  })

  it('tracks concurrent selections on one Host without allowing a late result to commit', async () => {
    const host = HostKey('same-host-select')
    const firstReady = deferred<SessionBinding>()
    const secondReady = deferred<SessionBinding>()
    const firstReference = makeReference(sessionId('first'), firstReady.promise)
    const secondReference = makeReference(sessionId('second'), secondReady.promise)
    const references = [firstReference, secondReference]
    const retain = vi.fn(() => references.shift()!)
    const client = makeHost(host, retain)
    const registry = new HostRegistry(() => client.client)
    await registry.attach(host)

    const first = registry.select(sessionRef(host, 'first'))
    await vi.waitFor(() => { expect(retain).toHaveBeenCalledOnce() })
    const second = registry.select(sessionRef(host, 'second'))
    secondReady.resolve(secondReference.binding)
    firstReady.resolve(firstReference.binding)
    const firstRejection = expect(first).rejects.toBeInstanceOf(HostOperationSupersededError)
    await firstRejection
    await expect(second).resolves.toEqual(sessionRef(host, 'second'))

    expect(firstReference.release).toHaveBeenCalledOnce()
    expect(secondReference.release).not.toHaveBeenCalled()
    expect(registry.currentReference).toBe(secondReference)
  })

  it('keeps the previous selection through acquisition failure and synchronous retain failure', async () => {
    const hostA = HostKey('current')
    const hostB = HostKey('failing')
    const currentReference = makeReference(sessionId('current'))
    const failedOpen = deferred<SessionBinding>()
    const failedReference = makeReference(sessionId('failed'), failedOpen.promise)
    const retainFailure = new Error('retain failed')
    const retainB = vi.fn()
      .mockImplementationOnce(() => failedReference)
      .mockImplementationOnce(() => { throw retainFailure })
    const registry = new HostRegistry(key => key === hostA
      ? makeHost(hostA, () => currentReference).client
      : makeHost(hostB, retainB).client)
    await registry.attach(hostA)
    await registry.attach(hostB)
    await registry.select(sessionRef(hostA, 'current'))

    const selection = registry.select(sessionRef(hostB, 'failed'))
    const openFailure = new Error('open failed')
    failedOpen.reject(openFailure)
    await expect(selection).rejects.toBe(openFailure)
    expect(failedReference.release).toHaveBeenCalledOnce()
    expect(registry.currentReference).toBe(currentReference)
    expect(currentReference.release).not.toHaveBeenCalled()

    await expect(registry.select(sessionRef(hostB, 'failed'))).rejects.toBe(retainFailure)
    expect(registry.currentReference).toBe(currentReference)
    await expect(registry.select(sessionRef(HostKey('missing')))).rejects.toBeInstanceOf(HostNotAttachedError)
    expect(registry.currentReference).toBe(currentReference)
  })

  it('detach releases only its Host and late cleanup cannot clear another selection', async () => {
    const hostA = HostKey('detach-a')
    const hostB = HostKey('detach-b')
    const referenceA = makeReference(sessionId('shared'))
    const readyB = deferred<SessionBinding>()
    const referenceB = makeReference(sessionId('shared'), readyB.promise)
    const detachA = deferred<void>()
    const a = makeHost(hostA, () => referenceA)
    const b = makeHost(hostB, () => referenceB)
    a.detach.mockReturnValue(detachA.promise)
    const clients = new Map([[hostA, a.client], [hostB, b.client]])
    const registry = new HostRegistry(key => clients.get(key)!)
    await Promise.all([registry.attach(hostA), registry.attach(hostB)])
    await registry.select(sessionRef(hostA))

    const detached = registry.detach(hostA)
    expect(referenceA.release).toHaveBeenCalledOnce()
    expect(registry.current).toBeUndefined()
    expect(registry.get(hostA)).toBeUndefined()
    expect(registry.get(hostB)).toBe(b.client)
    expect(b.detach).not.toHaveBeenCalled()

    const selectingB = registry.select(sessionRef(hostB))
    readyB.resolve({ sessionId: sessionId('shared') } as SessionBinding)
    await selectingB
    detachA.resolve()
    await detached
    expect(registry.currentReference).toBe(referenceB)
    expect(referenceB.release).not.toHaveBeenCalled()

    await registry.detach(hostB)
    expect(referenceB.release).toHaveBeenCalledOnce()
    expect(b.detach).toHaveBeenCalledOnce()
    expect(registry.current).toBeUndefined()
    expect(registry.list()).toEqual([])
    await registry.detach(HostKey('absent'))
  })

  it('detach releases pending acquisition only on the target Host', async () => {
    const hostA = HostKey('pending-a')
    const hostB = HostKey('pending-b')
    const readyA = deferred<SessionBinding>()
    const readyB = deferred<SessionBinding>()
    const referenceA = makeReference(sessionId('shared'), readyA.promise)
    const referenceB = makeReference(sessionId('shared'), readyB.promise)
    const retainA = vi.fn(() => referenceA)
    const retainB = vi.fn(() => referenceB)
    const a = makeHost(hostA, retainA)
    const b = makeHost(hostB, retainB)
    const clients = new Map([[hostA, a.client], [hostB, b.client]])
    const registry = new HostRegistry(key => clients.get(key)!)
    await Promise.all([registry.attach(hostA), registry.attach(hostB)])

    const selectingA = registry.select(sessionRef(hostA))
    await vi.waitFor(() => { expect(retainA).toHaveBeenCalledOnce() })
    const selectingB = registry.select(sessionRef(hostB))
    const detachedA = registry.detach(hostA)
    expect(referenceA.release).toHaveBeenCalledOnce()
    expect(referenceB.release).not.toHaveBeenCalled()
    const staleA = expect(selectingA).rejects.toThrow('released')
    readyB.resolve(referenceB.binding)
    await expect(selectingB).resolves.toEqual(sessionRef(hostB))
    await staleA
    await detachedA

    expect(registry.currentReference).toBe(referenceB)
    expect(referenceB.release).not.toHaveBeenCalled()
    expect(b.detach).not.toHaveBeenCalled()
  })

  it('settles an older detach without deleting a newer same-key cleanup record', async () => {
    const key = HostKey('detach-success-race')
    const oldHost = makeHost(key)
    const newHost = makeHost(key)
    const hosts = [oldHost.client, newHost.client]
    const oldCleanup = deferred<void>()
    oldHost.detach.mockReturnValue(oldCleanup.promise)
    const registry = new HostRegistry(() => hosts.shift()!)
    await registry.attach(key)

    const first = registry.detach(key)
    await registry.attach(key)
    const second = registry.detach(key)
    oldCleanup.resolve()
    await first
    await second

    expect(oldHost.detach).toHaveBeenCalledOnce()
    expect(newHost.detach).toHaveBeenCalledOnce()
    expect(registry.get(key)).toBeUndefined()
  })

  it('chains repeated detach cleanup and reports independent failures together', async () => {
    const key = HostKey('detach-errors')
    const oldHost = makeHost(key)
    const newHost = makeHost(key)
    const hosts = [oldHost.client, newHost.client]
    const registry = new HostRegistry(() => hosts.shift()!)
    await registry.attach(key)
    const oldFailure = new Error('old cleanup')
    const newFailure = new Error('new cleanup')
    oldHost.detach.mockRejectedValue(oldFailure)
    newHost.detach.mockRejectedValue(newFailure)

    const first = registry.detach(key)
    const firstRejection = expect(first).rejects.toBe(oldFailure)
    await registry.attach(key)
    const second = registry.detach(key)
    await firstRejection
    await expect(second).rejects.toBeInstanceOf(AggregateError)
    expect(oldHost.detach).toHaveBeenCalledOnce()
    expect(newHost.detach).toHaveBeenCalledOnce()
    expect(registry.get(key)).toBeUndefined()
  })
})
