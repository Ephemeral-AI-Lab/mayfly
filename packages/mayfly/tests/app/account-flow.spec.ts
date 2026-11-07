/** Native account orchestration, exact callback delivery, and local-only disposal evidence. @module */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  remoteAccountAttemptTerminal, remoteAccountCallbackLocation, remoteAccountCallbackOrigin,
  remoteAccountMetadata,
} from '../../src/app/features/account.ts'
import { accountFixture, accountView } from './account-feature-fixture.ts'

const fixtures: Awaited<ReturnType<typeof accountFixture>>[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) await fixture.cleanup()
  vi.useRealTimers()
})
async function fixture() {
  const value = await accountFixture()
  fixtures.push(value)
  return value
}

describe('official account callback admission', () => {
  it.each([
    ['http://localhost:6789', 'http://localhost:6789', 6789],
    ['http://127.0.0.1:6789/', 'http://127.0.0.1:6789', 6789],
    ['http://[::1]:6789', 'http://[::1]:6789', 6789],
    ['http://localhost:80', 'http://localhost:80', 80],
  ])('admits only an explicit-port loopback origin %s', (raw, origin, port) => {
    expect(remoteAccountCallbackOrigin(raw)).toEqual({ origin, port })
  })
  it.each([undefined, '', 'not a url', 'https://localhost:6789', 'http://localhost', 'http://localhost:0',
    'http://localhost:65536', 'http://example.test:6789', 'http://127.1:6789', 'http://localhost:6789/path',
    'http://localhost:6789?x=1', 'http://localhost:6789/#hash', 'http://user@localhost:6789',
  ])('refuses a non-exact browser callback origin %s', raw => {
    expect(remoteAccountCallbackOrigin(raw)).toBeUndefined()
  })
  it('keeps origin, port, and OAuth path exact while preserving callback parameters', () => {
    const origin = 'http://127.0.0.1:6789'
    expect(remoteAccountCallbackLocation(`  ${origin}/oauth/callback?code=fixture&state=state  `, origin)?.searchParams.get('code')).toBe('fixture')
    for (const raw of ['invalid', 'http://localhost:6789/oauth/callback', 'http://127.0.0.1:6790/oauth/callback',
      `${origin}/oauth/callback/`, `${origin}/other`, 'http://user@127.0.0.1:6789/oauth/callback']) {
      expect(remoteAccountCallbackLocation(raw, origin)).toBeUndefined()
    }
  })
  it('admits an explicitly configured default HTTP port consistently with URL origin normalization', () => {
    const callback = remoteAccountCallbackOrigin('http://localhost:80')!
    expect(remoteAccountCallbackLocation('http://localhost:80/oauth/callback?code=fixture', callback.origin)?.searchParams.get('code')).toBe('fixture')
  })
  it('uses display-safe metadata and recognizes only native terminal phases', async () => {
    const f = await fixture()
    f.presentation.snapshot.locale = 'zh-CN'
    expect(remoteAccountMetadata(f.context, '0.1.4-rc.2')).toEqual({ version: '0.1.4-rc.2', locale: 'zh', timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 })
    expect(() => remoteAccountMetadata(f.context, '')).toThrow('must not be empty')
    for (const phase of ['succeeded', 'cancelled', 'expired', 'failed'] as const) expect(remoteAccountAttemptTerminal(accountView(phase).attempt)).toBe(true)
    expect(remoteAccountAttemptTerminal(null)).toBe(false)
    expect(remoteAccountAttemptTerminal(accountView('waiting-browser').attempt)).toBe(false)
  })
})

describe('RemoteAccountSignInFlow native lifecycle', () => {
  it('starts once with exact metadata and callback origin, opens the supplied link, then observes native completion', async () => {
    const f = await fixture()
    const changed = vi.fn()
    const flow = (await f.accounts.createSignInFlow(f.client, changed))!
    expect(f.stream.listeners.size).toBe(1)
    await flow.start()
    expect(f.account.startSignIn).toHaveBeenCalledExactlyOnceWith({ version: '0.1.4-rc.2', locale: 'en', timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 }, 'http://127.0.0.1:6789', 'desktop')
    expect(f.io.openBrowser).toHaveBeenCalledExactlyOnceWith('https://platform.example/sign-in/attempt-1')
    expect(flow.snapshot).toMatchObject({ stage: 'waiting', browser: 'opened', transport: 'loopback', callbackPort: 6789 })
    f.stream.emit(accountView('exchanging'))
    await vi.waitFor(() => { expect(flow.snapshot.stage).toBe('finishing') })
    f.stream.emit(accountView('succeeded'))
    await expect(flow.connected).resolves.toBe(true)
    expect(flow.snapshot).toMatchObject({ stage: 'connected', delivering: false })
    expect(changed).toHaveBeenCalled()
    expect(f.account.cancelSignIn).not.toHaveBeenCalled()
  })
  it('joins an initializing attempt and opens only the authorize link delivered by the native watch', async () => {
    const f = await fixture()
    f.account.startSignIn.mockResolvedValueOnce({ ok: true, value: accountView('initializing', false) })
    const flow = (await f.accounts.createSignInFlow(f.client, vi.fn()))!
    const starting = flow.start()
    await vi.waitFor(() => { expect(flow.snapshot.stage).toBe('starting') })
    expect(f.io.openBrowser).not.toHaveBeenCalled()
    f.stream.emit(accountView('waiting-browser'))
    await starting
    expect(f.io.openBrowser).toHaveBeenCalledOnce()
    expect(flow.snapshot.stage).toBe('waiting')
  })
  it('ends link waiting on native terminal state, without opening a browser or retrying a write', async () => {
    const f = await fixture()
    f.account.startSignIn.mockResolvedValueOnce({ ok: true, value: accountView('initializing', false) })
    const flow = (await f.accounts.createSignInFlow(f.client, vi.fn()))!
    const starting = flow.start()
    await vi.waitFor(() => { expect(flow.snapshot.stage).toBe('starting') })
    f.stream.emit(accountView('expired', false))
    await starting
    await expect(flow.connected).resolves.toBe(false)
    expect(f.io.openBrowser).not.toHaveBeenCalled()
    expect(f.account.startSignIn).toHaveBeenCalledOnce()
  })
  it('times out the local link wait after 15s without cancelling the Host attempt', async () => {
    const f = await fixture()
    vi.useFakeTimers()
    f.account.startSignIn.mockResolvedValueOnce({ ok: true, value: accountView('initializing', false) })
    const flow = (await f.accounts.createSignInFlow(f.client, vi.fn()))!
    const starting = flow.start()
    await vi.advanceTimersByTimeAsync(15_000)
    await starting
    expect(f.io.openBrowser).not.toHaveBeenCalled()
    expect(f.account.cancelSignIn).not.toHaveBeenCalled()
  })
  it('marks failed browser opening and copies only the current safe authorize link', async () => {
    const f = await fixture()
    f.io.openBrowser.mockResolvedValueOnce(false)
    const flow = (await f.accounts.createSignInFlow(f.client, vi.fn()))!
    await expect(flow.copy()).rejects.toThrow('No sign-in link')
    await flow.start()
    expect(flow.snapshot.browser).toBe('failed')
    flow.setManual(true)
    await flow.copy()
    expect(f.io.copy).toHaveBeenCalledExactlyOnceWith('https://platform.example/sign-in/attempt-1')
    expect(flow.snapshot.manual).toBe(true)
  })
  it('refuses unsupported callback setup before making a native write', async () => {
    const f = await fixture()
    f.io.callbackOrigin.mockReturnValue('https://host.example')
    const flow = (await f.accounts.createSignInFlow(f.client, vi.fn()))!
    await expect(flow.start()).rejects.toThrow('explicit port')
    expect(flow.snapshot.stage).toBe('ended')
    expect(f.account.startSignIn).not.toHaveBeenCalled()
  })
  it('delivers only the exact callback using the flow signal, keeping native watch as completion authority', async () => {
    const f = await fixture()
    const flow = (await f.accounts.createSignInFlow(f.client, vi.fn()))!
    await flow.start()
    expect(await flow.deliver('http://localhost:6789/oauth/callback?code=fixture')).toBe('invalid')
    expect(f.io.deliverCallback).not.toHaveBeenCalled()
    expect(await flow.deliver('http://127.0.0.1:6789/oauth/callback?code=fixture')).toBe('delivered')
    const [url, signal] = f.io.deliverCallback.mock.calls[0]!
    expect(url.searchParams.get('code')).toBe('fixture')
    expect(signal).toBe(f.stream.signals[0])
    expect(flow.snapshot).toMatchObject({ stage: 'waiting', delivering: true })
    f.io.deliverCallback.mockResolvedValueOnce({ status: 400 })
    expect(await flow.deliver(url.href)).toBe('rejected')
    expect(flow.snapshot.delivering).toBe(false)
    f.io.deliverCallback.mockRejectedValueOnce(new Error('callback transport closed'))
    await expect(flow.deliver(url.href)).rejects.toThrow('callback transport closed')
    expect(flow.snapshot.delivering).toBe(false)
  })
  it('only explicit cancel and restart cancel the exact displayed attempt', async () => {
    const f = await fixture()
    const flow = (await f.accounts.createSignInFlow(f.client, vi.fn()))!
    await flow.cancel()
    expect(f.account.cancelSignIn).not.toHaveBeenCalled()
    await flow.start()
    await flow.restart()
    expect(f.account.cancelSignIn).toHaveBeenCalledExactlyOnceWith('attempt-1')
    expect(f.account.startSignIn).toHaveBeenCalledTimes(2)
    flow.applyExternal(accountView('failed'))
    await flow.cancel()
    expect(f.account.cancelSignIn).toHaveBeenCalledOnce()
  })
  it('does not begin a replacement attempt if restart cancellation settles after Host retirement', async () => {
    const f = await fixture()
    const flow = (await f.accounts.createSignInFlow(f.client, vi.fn()))!
    await flow.start()
    const cancelled = Promise.withResolvers<Awaited<ReturnType<typeof f.account.cancelSignIn>>>()
    f.account.cancelSignIn.mockReturnValueOnce(cancelled.promise)
    const restarting = flow.restart()
    f.reconnect()
    cancelled.resolve({ ok: true, value: accountView('cancelled') })
    await restarting
    expect(f.account.cancelSignIn).toHaveBeenCalledOnce()
    expect(f.account.startSignIn).toHaveBeenCalledOnce()
    expect(f.io.openBrowser).toHaveBeenCalledOnce()
  })
  it.each(['dispose', 'detach', 'reconnect', 'switchHost'] as const)('fences late start results after %s and never cancels remote work', async reason => {
    const f = await fixture()
    const started = Promise.withResolvers<Awaited<ReturnType<typeof f.account.startSignIn>>>()
    f.account.startSignIn.mockReturnValueOnce(started.promise)
    const changed = vi.fn()
    const flow = (await f.accounts.createSignInFlow(f.client, changed))!
    const starting = flow.start()
    if (reason === 'dispose') flow.dispose()
    else f[reason]()
    const calls = changed.mock.calls.length
    started.resolve({ ok: true, value: accountView('waiting-browser') })
    await starting
    await expect(flow.connected).resolves.toBe(false)
    expect(flow.valid()).toBe(false)
    expect(f.io.openBrowser).not.toHaveBeenCalled()
    expect(f.account.cancelSignIn).not.toHaveBeenCalled()
    expect(changed).toHaveBeenCalledTimes(calls)
    expect(f.stream.signals[0]!.aborted).toBe(true)
  })
  it('unblocks a waiting link and aborts a pending callback on local disposal', async () => {
    const f = await fixture()
    f.account.startSignIn.mockResolvedValueOnce({ ok: true, value: accountView('initializing', false) })
    const flow = (await f.accounts.createSignInFlow(f.client, vi.fn()))!
    const starting = flow.start()
    await vi.waitFor(() => { expect(flow.snapshot.stage).toBe('starting') })
    const delivered = Promise.withResolvers<{ status: number }>()
    f.io.deliverCallback.mockReturnValueOnce(delivered.promise)
    const delivering = flow.deliver('http://127.0.0.1:6789/oauth/callback?code=fixture')
    flow.dispose()
    delivered.resolve({ status: 200 })
    await expect(delivering).resolves.toBe('rejected')
    await starting
    expect(f.stream.signals[0]!.aborted).toBe(true)
    expect(f.account.cancelSignIn).not.toHaveBeenCalled()
    expect(f.io.openBrowser).not.toHaveBeenCalled()
  })

  it('keeps initial linked accounts and terminal watches owned by the exact native flow', async () => {
    const f = await fixture()
    f.account.getState.mockResolvedValueOnce({ ok: true, value: accountView('succeeded') })
    const connected = (await f.accounts.createSignInFlow(f.client, vi.fn()))!
    expect(connected.snapshot.stage).toBe('connected')
    await expect(connected.connected).resolves.toBe(true)
    connected.dispose()
    f.account.getState.mockResolvedValueOnce({ ok: true, value: { ...accountView(), status: 'credential-stored' } })
    const stored = (await f.accounts.createSignInFlow(f.client, vi.fn()))!
    expect(stored.snapshot.stage).toBe('connected')
    stored.applyExternal(accountView())
    expect(stored.snapshot.stage).toBe('idle')
    stored.dispose()
    await expect(stored.connected).resolves.toBe(false)
  })

  it('refuses writes and clipboard/delivery work after local retirement', async () => {
    const f = await fixture()
    f.io.callbackOrigin.mockReturnValue(undefined)
    const flow = (await f.accounts.createSignInFlow(f.client, vi.fn()))!
    expect(await flow.deliver('http://127.0.0.1:6789/oauth/callback')).toBe('invalid')
    flow.dispose()
    await flow.start(); await flow.cancel(); await flow.copy(); await flow.restart()
    expect(await flow.deliver('http://127.0.0.1:6789/oauth/callback')).toBe('rejected')
    expect(f.account.startSignIn).not.toHaveBeenCalled()
    expect(f.account.cancelSignIn).not.toHaveBeenCalled()
    expect(f.io.copy).not.toHaveBeenCalled()
    expect(f.io.deliverCallback).not.toHaveBeenCalled()
  })

  it('retires a browser result when the native attempt changes while opening', async () => {
    const f = await fixture()
    const opened = Promise.withResolvers<boolean>()
    f.io.openBrowser.mockReturnValueOnce(opened.promise)
    const flow = (await f.accounts.createSignInFlow(f.client, vi.fn()))!
    const starting = flow.start()
    await vi.waitFor(() => { expect(f.io.openBrowser).toHaveBeenCalledOnce() })
    f.stream.emit(accountView('waiting-browser', true, 'replacement-attempt'))
    await vi.waitFor(() => { expect(flow.snapshot.view.attempt?.id).toBe('replacement-attempt') })
    opened.resolve(true); await starting
    expect(flow.snapshot.browser).toBe('pending')
    flow.applyExternal(accountView('committing', false, 'replacement-attempt'))
    expect(flow.snapshot.stage).toBe('finishing')
    flow.applyExternal(accountView('failed', false, 'replacement-attempt'))
    expect(flow.snapshot.stage).toBe('ended')
  })

  it.each([false, true])('surfaces native start errors without late local state (retired=%s)', async retired => {
    const f = await fixture()
    const response = Promise.withResolvers<Awaited<ReturnType<typeof f.account.startSignIn>>>()
    f.account.startSignIn.mockReturnValueOnce(response.promise)
    const flow = (await f.accounts.createSignInFlow(f.client, vi.fn()))!
    const starting = flow.start()
    const rejection = expect(starting).rejects.toThrow('native sign-in failed')
    if (retired) flow.dispose()
    response.reject(new Error('native sign-in failed'))
    await rejection
    if (retired) expect(flow.snapshot.error).toBeUndefined()
    else expect(flow.snapshot).toMatchObject({ stage: 'ended', error: 'native sign-in failed' })
  })

  it('shares one pending link waiter and handles a start response without an attempt', async () => {
    const f = await fixture()
    f.account.startSignIn.mockResolvedValue({ ok: true, value: accountView('initializing', false) })
    const flow = (await f.accounts.createSignInFlow(f.client, vi.fn()))!
    const first = flow.start()
    await vi.waitFor(() => { expect(flow.snapshot.stage).toBe('starting') })
    await flow.start()
    expect(f.io.openBrowser).not.toHaveBeenCalled()
    f.stream.emit(accountView('waiting-browser'))
    await first
    expect(f.io.openBrowser).toHaveBeenCalledOnce()
    flow.dispose()
    f.account.startSignIn.mockResolvedValueOnce({ ok: true, value: accountView() })
    const absent = (await f.accounts.createSignInFlow(f.client, vi.fn()))!
    const starting = absent.start()
    await vi.waitFor(() => { expect(absent.snapshot.stage).toBe('starting') })
    absent.dispose(); await starting
    expect(f.io.openBrowser).toHaveBeenCalledOnce()
  })

  it('ignores a native watch item already queued when its owner disconnects', async () => {
    const f = await fixture()
    const response = Promise.withResolvers<ReturnType<typeof accountView>>()
    f.account.watch.mockImplementationOnce(() => ({ async *[Symbol.asyncIterator]() { yield await response.promise } }))
    const changed = vi.fn()
    const flow = (await f.accounts.createSignInFlow(f.client, changed))!
    f.reconnect()
    response.resolve(accountView('succeeded'))
    await Promise.resolve(); await Promise.resolve()
    await expect(flow.connected).resolves.toBe(false)
    expect(changed).not.toHaveBeenCalled()
    expect(flow.snapshot.stage).toBe('idle')
  })

  it('leaves a retired callback transport failure to its caller without publishing stale feedback', async () => {
    const f = await fixture()
    const flow = (await f.accounts.createSignInFlow(f.client, vi.fn()))!
    await flow.start()
    const response = Promise.withResolvers<{ status: number }>()
    f.io.deliverCallback.mockReturnValueOnce(response.promise)
    const delivering = flow.deliver('http://127.0.0.1:6789/oauth/callback')
    const failure = expect(delivering).rejects.toThrow('callback failed after detach')
    flow.dispose(); response.reject(new Error('callback failed after detach'))
    await failure
    expect(f.account.cancelSignIn).not.toHaveBeenCalled()
  })

  it('releases an actually pending link timer and tolerates its already queued callback after disposal', async () => {
    const f = await fixture()
    vi.useFakeTimers()
    const timers = vi.spyOn(globalThis, 'setTimeout')
    f.remote.$host.isLoopback = false
    f.account.startSignIn.mockResolvedValueOnce({ ok: true, value: accountView('initializing', false) })
    const changed = vi.fn()
    const flow = (await f.accounts.createSignInFlow(f.client, changed))!
    expect(flow.snapshot.transport).toBe('forwarded')
    const starting = flow.start()
    await vi.advanceTimersByTimeAsync(0)
    const timeout = timers.mock.calls.find(call => call[1] === 15_000)![0] as () => void
    expect(vi.getTimerCount()).toBe(1)
    flow.dispose()
    await starting
    expect(vi.getTimerCount()).toBe(0)
    timeout()
    const retired = flow.snapshot
    const notifications = changed.mock.calls.length
    flow.setManual(true)
    flow.applyExternal(accountView('succeeded'))
    expect(flow.snapshot).toBe(retired)
    expect(changed).toHaveBeenCalledTimes(notifications)
    expect(f.io.openBrowser).not.toHaveBeenCalled()
    timers.mockRestore()

    f.account.startSignIn.mockResolvedValueOnce({ ok: true, value: accountView() })
    const empty = (await f.accounts.createSignInFlow(f.client, vi.fn()))!
    const opening = empty.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(empty.snapshot.stage).toBe('starting')
    expect(empty.snapshot.view.attempt).toBeNull()
    empty.dispose(); await opening
    expect(vi.getTimerCount()).toBe(0)
  })
})
