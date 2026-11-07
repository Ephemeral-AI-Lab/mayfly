/** Frontend-local browser, clipboard and loopback transport lifetimes at native Node boundaries. @module */
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostClient } from '../../src/client/types.ts'
import { RemoteAccountNodeIO } from '../../src/app/features/configuration-account.ts'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), copy: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('../../src/app/local/clipboard.ts', () => ({ copyLocalText: mocks.copy }))

const nativePlatform = process.platform
const platform = (value: NodeJS.Platform) => { Object.defineProperty(process, 'platform', { configurable: true, value }) }
afterEach(() => { platform(nativePlatform); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); mocks.spawn.mockReset(); mocks.copy.mockReset() })
const client = (origin: string) => ({ origin }) as HostClient
function child() {
  const process = Object.assign(new EventEmitter(), { unref: vi.fn() })
  mocks.spawn.mockReturnValueOnce(process)
  return process
}

describe('frontend account Node I/O', () => {
  it('offers callback origins only for explicit positive local HTTP listeners', () => {
    const io = new RemoteAccountNodeIO()
    for (const origin of ['http://localhost:8234/some/path', 'http://127.0.0.1:8234', 'http://[::1]:8234']) expect(io.callbackOrigin(client(origin))).toBe('http://localhost:8234')
    for (const origin of ['broken', 'https://localhost:8234', 'http://remote.example:8234', 'http://localhost', 'http://localhost:80', 'http://localhost:0', 'http://localhost:65536']) expect(io.callbackOrigin(client(origin))).toBeUndefined()
    expect(io.callbackOrigin(client('http://localhost:65535'))).toBe('http://localhost:65535')
    io.dispose()
  })

  it('opens platform-native browser commands without a shell and settles within the owned grace window', async () => {
    vi.useFakeTimers()
    for (const [os, command, args] of [
      ['darwin', 'open', ['https://login.example/callback?code=literal;$HOME']],
      ['win32', 'cmd', ['/c', 'start', '', 'https://login.example/callback?code=literal;$HOME']],
      ['linux', 'xdg-open', ['https://login.example/callback?code=literal;$HOME']],
    ] as const) {
      platform(os)
      vi.stubEnv('DISPLAY', ':0')
      const openedChild = child()
      const io = new RemoteAccountNodeIO()
      const opened = io.openBrowser('https://login.example/callback?code=literal;$HOME')
      expect(mocks.spawn).toHaveBeenLastCalledWith(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
      expect(openedChild.unref).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1500)
      expect(await opened).toBe(true)
      openedChild.emit('error', new Error('late opener error'))
      io.dispose()
    }
  })

  it('refuses a headless Linux browser, handles startup errors, and retires pending opens on disposal', async () => {
    vi.useFakeTimers()
    platform('linux')
    vi.stubEnv('DISPLAY', undefined); vi.stubEnv('WAYLAND_DISPLAY', undefined)
    const io = new RemoteAccountNodeIO()
    expect(await io.openBrowser('https://login.example')).toBe(false)
    expect(mocks.spawn).not.toHaveBeenCalled()
    vi.stubEnv('WAYLAND_DISPLAY', 'wayland-0')
    const failed = child(); const failure = io.openBrowser('https://login.example')
    failed.emit('error', new Error('missing browser'))
    expect(await failure).toBe(false)
    mocks.spawn.mockImplementationOnce(() => { throw new Error('spawn refused') })
    expect(await io.openBrowser('https://login.example')).toBe(false)
    child(); const pending = io.openBrowser('https://login.example')
    io.dispose(); expect(await pending).toBe(false)
    expect(await io.openBrowser('https://login.example')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses the injected clipboard or the real local clipboard boundary with its mount signal', async () => {
    const injected = vi.fn(async (_text: string) => {})
    const custom = new RemoteAccountNodeIO(injected)
    await custom.copy('one-time code'); expect(injected).toHaveBeenCalledExactlyOnceWith('one-time code'); expect(mocks.copy).not.toHaveBeenCalled()
    const native = new RemoteAccountNodeIO()
    await native.copy('native callback')
    expect(mocks.copy).toHaveBeenCalledWith('native callback', expect.any(AbortSignal))
    const signal = mocks.copy.mock.calls[0]![1] as AbortSignal
    expect(signal.aborted).toBe(false); native.dispose(); expect(signal.aborted).toBe(true)
    custom.dispose()
  })

  it('posts callbacks to the exact URL with redirect refusal and caller/mount cancellation', async () => {
    const cancel = vi.fn(async () => {})
    const fetch = vi.fn(async (_url: URL, _options: RequestInit) => ({ status: 204, body: { cancel } }))
    vi.stubGlobal('fetch', fetch)
    const io = new RemoteAccountNodeIO(), caller = new AbortController()
    const url = new URL('http://localhost:8234/callback?code=secret')
    expect(await io.deliverCallback(url, caller.signal)).toEqual({ status: 204 })
    expect(fetch.mock.calls[0]![0]).toBe(url)
    expect(fetch.mock.calls[0]![1].redirect).toBe('manual'); expect(cancel).toHaveBeenCalledOnce()
    const signal = fetch.mock.calls[0]![1].signal!
    expect(signal.aborted).toBe(false); caller.abort(); expect(signal.aborted).toBe(true)
    cancel.mockRejectedValueOnce(new Error('body already closed'))
    expect(await io.deliverCallback(url, new AbortController().signal)).toEqual({ status: 204 })
    fetch.mockResolvedValueOnce({ status: 302, body: undefined } as never)
    expect(await io.deliverCallback(url, new AbortController().signal)).toEqual({ status: 302 })
    const mountSignal = fetch.mock.calls[2]![1].signal!
    io.dispose(); expect(mountSignal.aborted).toBe(true)
  })
})
