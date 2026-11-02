/** Host-only Git polling, bounded cadence, exact identities and retirement. @module */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteGitPoller, createMayflyGitRead } from '../../src/frontend/git.ts'
import { HostKey, type HostClient } from '../../src/client/types.ts'

const ref = (host = 'one') => ({ host: HostKey(host), sessionId: SessionId('same') })
const result = (value = 'main') => ({ ok: true as const, value })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('native Host Git polling', () => {
  it('requires a positive finite interval and stays idle without a selection', async () => {
    for (const interval of [0, -1, NaN, Infinity]) expect(() => new RemoteGitPoller(vi.fn(), interval)).toThrow('positive and finite')
    const read = vi.fn(async () => result())
    const poller = new RemoteGitPoller(read, 5000)
    expect(poller.snapshot()).toMatchObject({ generation: 0, pending: false, ref: undefined })
    await poller.refresh(); expect(read).not.toHaveBeenCalled()
    poller.attach(null); await poller.dispose(); await poller.dispose()
    poller.attach(ref()); await poller.refresh(); expect(read).not.toHaveBeenCalled()
  })

  it('shares only the active read and waits a full interval after its settlement', async () => {
    vi.useFakeTimers()
    const pending = Promise.withResolvers<ReturnType<typeof result>>()
    const read = vi.fn(async (..._args: unknown[]) => pending.promise)
    const poller = new RemoteGitPoller(read, 5000)
    const listener = vi.fn(); const off = poller.subscribe(listener)
    const selection = ref(); poller.attach(selection)
    const first = poller.refresh(); expect(poller.refresh()).toBe(first)
    expect(poller.snapshot()).toMatchObject({ ref: selection, pending: true })
    await vi.advanceTimersByTimeAsync(10_000); expect(read).toHaveBeenCalledOnce()
    pending.resolve(result()); await first
    expect(poller.snapshot()).toMatchObject({ result: result(), pending: false })
    await vi.advanceTimersByTimeAsync(4999); expect(read).toHaveBeenCalledOnce()
    read.mockResolvedValueOnce(result('next')); await vi.advanceTimersByTimeAsync(1)
    expect(read).toHaveBeenCalledTimes(2); expect(poller.snapshot().result).toEqual(result('next'))
    off(); const calls = listener.mock.calls.length
    poller.attach(null); expect(listener).toHaveBeenCalledTimes(calls)
    await poller.dispose(); expect(vi.getTimerCount()).toBe(0)
  })

  it('contains native refusal and thrown errors and refreshes manually without a second scheduled timer', async () => {
    vi.useFakeTimers()
    const read = vi.fn(async (): Promise<{ ok: true, value: string } | { ok: false, error: { code: string, message: string } }> => ({ ok: false, error: { code: 'git-failed', message: 'no repository' } }))
    const poller = new RemoteGitPoller(read, 5000); poller.attach(ref()); await poller.refresh()
    expect(poller.snapshot().result).toEqual({ ok: false, error: { code: 'git-failed', message: 'no repository' } })
    read.mockRejectedValueOnce(new Error('offline')); await poller.refresh()
    expect(poller.snapshot()).toMatchObject({ pending: false, result: undefined, error: { message: 'offline' } })
    expect(vi.getTimerCount()).toBe(1)
    await poller.dispose(); expect(vi.getTimerCount()).toBe(0)
  })

  it('fences same-SessionId results across Hosts, generation replacement and local disposal', async () => {
    const a = Promise.withResolvers<ReturnType<typeof result>>()
    const b = Promise.withResolvers<ReturnType<typeof result>>()
    const read = vi.fn(async (..._args: unknown[]) => result()).mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)
    const poller = new RemoteGitPoller(read, 5000)
    poller.attach(ref('one')); const first = poller.refresh(); await Promise.resolve()
    const signal = read.mock.calls[0]![1] as AbortSignal
    poller.attach(ref('two')); const second = poller.refresh(); await Promise.resolve()
    expect(signal.aborted).toBe(true)
    a.reject(new Error('old Host failed')); await first
    expect(poller.snapshot().pending).toBe(true)
    const stopping = poller.dispose(); b.resolve(result('late')); await stopping; await second
    expect(poller.snapshot().result).toBeUndefined()
    const c = Promise.withResolvers<ReturnType<typeof result>>()
    const another = new RemoteGitPoller(vi.fn(() => c.promise), 5000)
    another.attach(ref()); const late = another.refresh(); another.attach(null); c.resolve(result('old')); await late
    expect(another.snapshot().ref).toBeUndefined(); expect(another.snapshot().result).toBeUndefined()
    await another.dispose()
  })

  it('ignores a timer callback already queued for a retired selection', async () => {
    vi.useFakeTimers()
    const timer = vi.spyOn(globalThis, 'setTimeout')
    const read = vi.fn(async () => result())
    const poller = new RemoteGitPoller(read, 5000); poller.attach(ref()); await poller.refresh()
    const queued = timer.mock.calls.at(-1)![0] as () => void
    poller.attach(null); queued(); expect(read).toHaveBeenCalledOnce()
    await poller.dispose()
  })

  it('addresses the generated Host Git method only through a matching HostKey', async () => {
    const selection = ref(); const gitStatus = vi.fn(async (..._args: unknown[]) => result(null as unknown as string))
    const client = { key: selection.host, remote: { mayflyHost: { gitStatus } } } as unknown as HostClient
    const read = createMayflyGitRead(client); const signal = new AbortController().signal
    await read(selection, signal)
    expect(gitStatus).toHaveBeenCalledWith({ sessionId: selection.sessionId }, signal)
    expect(() => read(ref('other'), signal)).toThrow('same Host')
  })
})
