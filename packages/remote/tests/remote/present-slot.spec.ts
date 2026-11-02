/** Shared presented-view ownership preserves native authority and fences pending leases. @module */
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it, vi } from 'vitest'
import { HostKey } from '../../src/client/types.ts'
import type { HostViewLease } from '../../src/frontend/host-registry.ts'
import { RemotePresentSlot, type RemotePresentedViewFacts } from '../../src/remote/operations/support.ts'

const ref = { host: HostKey('one'), sessionId: SessionId('child') }
const binding = { sessionId: ref.sessionId } as SessionBinding
const readonlyFacts: RemotePresentedViewFacts = { kind: 'subagent', access: 'readonly', label: 'worker' }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function lease(ready = Promise.resolve(binding)) {
  return { key: { ref, role: 'child' }, reference: {} as never, ready, release: vi.fn() } satisfies HostViewLease
}

describe('RemotePresentSlot', () => {
  it('retains different children and Hosts independently while replacing only the single BTW view', async () => {
    const present = vi.fn()
    const closePresent = vi.fn()
    const slot = new RemotePresentSlot({ present, closePresent })
    const first = lease()
    const second = lease()
    const otherHost = { ...ref, host: HostKey('two') }
    await slot.adopt(ref, first, () => readonlyFacts)
    await slot.adopt(otherHost, second, () => readonlyFacts)
    const btw = { ...ref, sessionId: SessionId('btw') }
    slot.present(btw, binding, { kind: 'btw', access: 'interactive' })
    expect(first.release).not.toHaveBeenCalled()
    expect(second.release).not.toHaveBeenCalled()
    const nextBtw = { ...btw, sessionId: SessionId('btw-next') }
    slot.present(nextBtw, binding, { kind: 'btw', access: 'interactive' })
    expect(closePresent).toHaveBeenLastCalledWith(btw)
    slot.closeBtw()
    expect(closePresent).toHaveBeenLastCalledWith(nextBtw)
    slot.closeBtw()
    slot.close(otherHost)
    expect(second.release).toHaveBeenCalledOnce()
    expect(first.release).not.toHaveBeenCalled()
    slot.close()
    expect(first.release).toHaveBeenCalledOnce()
    expect(closePresent).toHaveBeenLastCalledWith(undefined)
    slot.dispose()
    const afterDispose = lease()
    await slot.adopt(ref, afterDispose, () => readonlyFacts)
    slot.present(ref, binding, readonlyFacts)
    expect(afterDispose.release).toHaveBeenCalledOnce()
    expect(present).toHaveBeenCalledTimes(4)
  })

  it('shares one owned child view and propagates access while BTW remains externally owned', async () => {
    const present = vi.fn()
    const closePresent = vi.fn()
    const slot = new RemotePresentSlot({ present, closePresent })
    const first = lease()
    await slot.adopt(ref, first, () => readonlyFacts)
    expect(present).toHaveBeenCalledWith(ref, binding, readonlyFacts)
    const child = lease()
    const address = { parentSessionId: SessionId('lead'), childSessionId: ref.sessionId, mode: 'continuable' as const }
    await slot.adopt(ref, child, () => ({ kind: 'subagent', access: 'resumable', address }))
    expect(first.release).toHaveBeenCalledOnce()
    expect(present).toHaveBeenLastCalledWith(ref, binding, { kind: 'subagent', access: 'resumable', address })
    slot.present(ref, binding, { kind: 'btw', access: 'interactive', historyFloorSeq: 12 })
    expect(child.release).toHaveBeenCalledOnce()
    expect(present).toHaveBeenLastCalledWith(ref, binding, { kind: 'btw', access: 'interactive', historyFloorSeq: 12 })
    slot.close()
    expect(closePresent).toHaveBeenCalledOnce()
    slot.dispose()
  })

  it('releases a cancelled acquisition immediately and prevents late paint', async () => {
    const ready = deferred<SessionBinding>()
    const pending = lease(ready.promise)
    const present = vi.fn()
    const slot = new RemotePresentSlot({ present })
    const controller = new AbortController()
    const done = slot.adopt(ref, pending, () => readonlyFacts, { signal: controller.signal })
    controller.abort()
    expect(pending.release).toHaveBeenCalledOnce()
    ready.resolve(binding)
    await done
    expect(present).not.toHaveBeenCalled()
    const preaborted = lease()
    await slot.adopt(ref, preaborted, () => readonlyFacts, { signal: controller.signal })
    expect(preaborted.release).toHaveBeenCalledOnce()
  })

  it('rejects failed reads, ignores stale owners, and lets a newer side view win', async () => {
    const present = vi.fn()
    const slot = new RemotePresentSlot({ present })
    const ready = deferred<SessionBinding>()
    const old = lease(ready.promise)
    const done = slot.adopt(ref, old, () => readonlyFacts)
    slot.present(ref, binding, { kind: 'btw', access: 'interactive' })
    ready.resolve(binding)
    await done
    expect(old.release).toHaveBeenCalledOnce()
    expect(present).toHaveBeenCalledOnce()
    const failed = lease(Promise.reject(new Error('unavailable')))
    await expect(slot.adopt(ref, failed, () => readonlyFacts)).rejects.toThrow('unavailable')
    expect(failed.release).toHaveBeenCalledOnce()
    const stale = lease()
    await slot.adopt(ref, stale, () => readonlyFacts, { isCurrent: () => false })
    expect(stale.release).toHaveBeenCalledOnce()
    const afterDispose = deferred<SessionBinding>()
    const unload = lease(afterDispose.promise)
    const completion = slot.adopt(ref, unload, () => readonlyFacts)
    slot.dispose()
    afterDispose.resolve(binding)
    await completion
    expect(unload.release).toHaveBeenCalledOnce()
    const noPresenter = new RemotePresentSlot({})
    await noPresenter.adopt(ref, lease(), () => readonlyFacts)
    noPresenter.present(ref, binding, readonlyFacts)
    noPresenter.close()
  })

  it('releases replaced and closed pending reads immediately without touching an unrelated pending child', async () => {
    const slot = new RemotePresentSlot({})
    const firstReady = deferred<SessionBinding>()
    const first = lease(firstReady.promise)
    const firstDone = slot.adopt(ref, first, () => readonlyFacts)
    const secondReady = deferred<SessionBinding>()
    const second = lease(secondReady.promise)
    const next = { ...ref, sessionId: SessionId('next') }
    const secondDone = slot.adopt(next, second, () => readonlyFacts)
    expect(first.release).toHaveBeenCalledOnce()
    slot.close(ref)
    expect(second.release).not.toHaveBeenCalled()
    slot.close(next)
    expect(second.release).toHaveBeenCalledOnce()
    firstReady.resolve(binding); secondReady.resolve(binding)
    await Promise.all([firstDone, secondDone])
    expect(first.release).toHaveBeenCalledOnce()
    expect(second.release).toHaveBeenCalledOnce()
  })
})
