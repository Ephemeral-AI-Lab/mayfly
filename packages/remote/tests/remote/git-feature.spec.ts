/** Native Host Git status, directory replacement and exact connection generations. @module */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { MayflyGitStatus } from '@ephemeral-ai/mayfly-host/types'
import type { RemoteFeatureSelection } from '../../src/remote/features.ts'
import { mountGitFeature } from '../../src/remote/features/git.ts'
import { projection } from './approval-feature-fixture.ts'
import { taskFixture, good, bad } from './task-feature-fixture.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanups.splice(0).reverse()) await dispose(); vi.useRealTimers(); vi.restoreAllMocks() })
async function fixture(selected = true, access?: RemoteFeatureSelection['access']) {
  vi.useFakeTimers()
  const f = await taskFixture(selected)
  const directory = projection<unknown>('/work')
  const current = f.options.hosts.current()
  if (current !== undefined) {
    Object.assign(current, { access })
    Object.assign(current.binding.session, { projections: { faceOf: () => directory } })
  }
  const capabilities = vi.fn(async (..._args: unknown[]): Promise<unknown> => good({ features: ['gitStatus'] }))
  const gitStatus = vi.fn(async (..._args: unknown[]): Promise<RemoteResult<MayflyGitStatus | null>> => good({ branch: 'main', dirty: false, ahead: 0, behind: 0, diffAdded: 0, diffDeleted: 0 }))
  Object.assign(f.client.remote, { mayflyHost: { capabilities, gitStatus } })
  const stop = mountGitFeature(f.options)
  cleanups.push(async () => { stop(); await f.dispose() })
  const text = () => JSON.stringify(f.ctx.mayflyStatus.list().find(item => item.id === 'mayfly.status.git')?.node ?? null)
  return { ...f, current, directory, capabilities, gitStatus, stop, text,
    setAccess: (access: NonNullable<RemoteFeatureSelection['access']>, notify = true) => {
      Object.assign(f.options.hosts.current()!, { access })
      if (notify) for (const listener of f.topology) listener()
    },
  }
}

describe('Host Git badge owner', () => {
  it.each(['readonly', 'resumable'] as const)('keeps %s history passive without Agent-only Git reads or directory observers', async access => {
    const f = await fixture(true, access)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.capabilities).not.toHaveBeenCalled()
    expect(f.gitStatus).not.toHaveBeenCalled()
    expect(f.directory.listeners.size).toBe(0)
    expect(f.text()).toBe('null')
    f.reconnect(); await vi.advanceTimersByTimeAsync(0)
    expect(f.capabilities).not.toHaveBeenCalled()
    expect(f.gitStatus).not.toHaveBeenCalled()
  })

  it.each(['readonly', 'resumable'] as const)('releases live Git reads when access becomes %s and restarts only for interactive access', async access => {
    const f = await fixture(true, 'interactive'); await vi.advanceTimersByTimeAsync(0)
    const pending = Promise.withResolvers<RemoteResult<MayflyGitStatus | null>>()
    f.gitStatus.mockReturnValueOnce(pending.promise)
    f.directory.set('/pending'); await vi.advanceTimersByTimeAsync(0)
    const signal = f.gitStatus.mock.calls.at(-1)![1] as AbortSignal
    const queued = [...f.directory.listeners][0]!
    f.setAccess(access)
    expect(signal.aborted).toBe(true)
    expect(f.directory.listeners.size).toBe(0)
    expect(f.text()).toBe('null')
    queued()
    pending.resolve(good({ branch: 'stale', dirty: false, ahead: 0, behind: 0, diffAdded: 0, diffDeleted: 0 }))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.text()).toBe('null')
    expect(f.gitStatus).toHaveBeenCalledTimes(2)
    expect(f.capabilities).toHaveBeenCalledTimes(2)
    f.setAccess('interactive'); await vi.advanceTimersByTimeAsync(0)
    expect(f.directory.listeners.size).toBe(1)
    expect(f.gitStatus).toHaveBeenCalledTimes(3)
    expect(f.text()).toContain('main')
    f.gitStatus.mockResolvedValueOnce(bad('interactive Agent unavailable') as unknown as RemoteResult<MayflyGitStatus | null>)
    f.directory.set('/failed'); await vi.advanceTimersByTimeAsync(0)
    expect(f.text()).toContain('gitStatus failed')
    f.setAccess(access); await vi.advanceTimersByTimeAsync(0)
    expect(f.text()).toBe('null')
  })

  it('fences pending capability discovery and queued polls when access becomes cold', async () => {
    const f = await fixture(); await vi.advanceTimersByTimeAsync(0)
    const pending = Promise.withResolvers<unknown>()
    f.capabilities.mockReturnValueOnce(pending.promise)
    f.directory.set('/pending')
    f.setAccess('readonly')
    pending.resolve(good({ features: ['gitStatus'] })); await vi.advanceTimersByTimeAsync(0)
    expect(f.gitStatus).toHaveBeenCalledOnce()
    expect(f.text()).toBe('null')
    f.setAccess('interactive'); await vi.advanceTimersByTimeAsync(0)
    f.setAccess('resumable', false)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(f.gitStatus).toHaveBeenCalledTimes(2)
    expect(f.text()).toBe('null')
  })

  it('polls only a current exact Host and repaints native statuses through the shared badge', async () => {
    const empty = await fixture(false); await vi.advanceTimersByTimeAsync(0); expect(empty.gitStatus).not.toHaveBeenCalled(); expect(empty.text()).toBe('null')
    const f = await fixture(); await vi.advanceTimersByTimeAsync(0); expect(f.text()).toContain('main')
    expect(f.gitStatus).toHaveBeenCalledWith({ sessionId: 'session' }, expect.any(AbortSignal))
    f.gitStatus.mockResolvedValueOnce(good(null)); f.directory.set('/other'); await vi.advanceTimersByTimeAsync(0); expect(f.text()).toBe('null')
    f.gitStatus.mockResolvedValueOnce(bad('native refused') as unknown as RemoteResult<MayflyGitStatus | null>); f.directory.set('/third'); await vi.advanceTimersByTimeAsync(0); expect(f.text()).toContain('gitStatus failed')
    f.stop(); f.stop(); expect(f.ctx.mayflyStatus.list()).toEqual([])
  })

  it('clears and aborts an old working-copy probe before awaiting a new directory capability read', async () => {
    const f = await fixture(); await vi.advanceTimersByTimeAsync(0)
    const pending = Promise.withResolvers<RemoteResult<MayflyGitStatus | null>>()
    f.gitStatus.mockReturnValueOnce(pending.promise); f.directory.set('/old'); await vi.advanceTimersByTimeAsync(0)
    const oldSignal = f.gitStatus.mock.calls.at(-1)![1] as AbortSignal
    const capability = Promise.withResolvers<unknown>(); f.capabilities.mockReturnValueOnce(capability.promise)
    f.directory.set('/new'); expect(oldSignal.aborted).toBe(true); expect(f.text()).toBe('null')
    pending.resolve(good({ branch: 'stale', unknown: true })); await vi.advanceTimersByTimeAsync(0); expect(f.text()).toBe('null')
    capability.resolve(good({ features: ['gitStatus'] })); await vi.advanceTimersByTimeAsync(0); expect(f.text()).toContain('main')
  })

  it('contains unavailable and failed capabilities, ignores same cwd, and handles unknown directory projections', async () => {
    const f = await fixture(); await vi.advanceTimersByTimeAsync(0)
    const count = f.capabilities.mock.calls.length; f.directory.set('/work'); expect(f.capabilities).toHaveBeenCalledTimes(count)
    f.capabilities.mockResolvedValueOnce(good({ features: [] })); f.directory.set('/no-git'); await vi.advanceTimersByTimeAsync(0); expect(f.text()).toContain('gitStatus is unavailable')
    f.capabilities.mockResolvedValueOnce(bad('capability error')); f.directory.set(null); await vi.advanceTimersByTimeAsync(0); expect(f.text()).toContain('capability error')
    f.capabilities.mockRejectedValueOnce('opaque failure'); f.directory.set(12); await vi.advanceTimersByTimeAsync(0)
    // Both non-string values represent the same absent directory.
    expect(f.text()).toContain('capability error')
    f.directory.set('/opaque'); await vi.advanceTimersByTimeAsync(0); expect(f.text()).toContain('opaque failure')
  })

  it('fences obsolete capability responses and errors across directory, reconnect and unload', async () => {
    const f = await fixture(); await vi.advanceTimersByTimeAsync(0)
    const first = Promise.withResolvers<unknown>(); f.capabilities.mockReturnValueOnce(first.promise); f.directory.set('/first')
    const second = Promise.withResolvers<unknown>(); f.capabilities.mockReturnValueOnce(second.promise); f.directory.set('/second')
    first.resolve(good({ features: [] })); second.resolve(good({ features: ['gitStatus'] })); await vi.advanceTimersByTimeAsync(0); expect(f.text()).toContain('main')
    const failed = Promise.withResolvers<unknown>(); f.capabilities.mockReturnValueOnce(failed.promise); f.directory.set('/pending')
    f.reconnect(); failed.reject(new Error('old')); await vi.advanceTimersByTimeAsync(0); expect(f.text()).not.toContain('old')
    const late = Promise.withResolvers<unknown>(); f.capabilities.mockReturnValueOnce(late.promise); f.directory.set('/unload')
    f.stop(); late.resolve(good({ features: ['gitStatus'] })); await vi.advanceTimersByTimeAsync(0); expect(f.ctx.mayflyStatus.list()).toEqual([])
  })

  it('ignores queued directory callbacks after selection retirement and never borrows another selection for a queued poll', async () => {
    const f = await fixture(); await vi.advanceTimersByTimeAsync(0)
    const queued = [...f.directory.listeners][0]!
    f.select(false); queued(); await vi.advanceTimersByTimeAsync(0); expect(f.text()).toBe('null')
    const g = await fixture(); await vi.advanceTimersByTimeAsync(0)
    // The poll starts in a microtask, so a selection may disappear after admission.
    g.silentlyDeselect(); await vi.advanceTimersByTimeAsync(5000); expect(g.gitStatus).toHaveBeenCalledOnce()
    g.stop(); await vi.advanceTimersByTimeAsync(0)
  })
})
