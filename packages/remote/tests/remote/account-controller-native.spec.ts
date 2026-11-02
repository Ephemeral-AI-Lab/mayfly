/** Account callback admission and local panel ownership at the shared browser boundary. @module */
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { MayflyUiActionEvent, MayflyUiEventContext } from '@ephemeral-ai/mayfly-ui'
import type { RemoteBrowserOptions } from '../../src/remote/panels/browser.ts'
import { accountFixture, accountView } from './account-feature-fixture.ts'

const mocks = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('../../src/remote/panels/browser.ts', () => ({ openRemoteBrowser: mocks.open }))
const fixtures: Awaited<ReturnType<typeof accountFixture>>[] = []
afterEach(async () => { for (const fixture of fixtures.splice(0).reverse()) await fixture.cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })
async function fixture() {
  const f = await accountFixture()
  fixtures.push(f)
  const opened: { readonly options: RemoteBrowserOptions, readonly close: Mock<() => void>, readonly refresh: Mock<() => void> }[] = []
  mocks.open.mockImplementation((_context: unknown, options: RemoteBrowserOptions) => {
    let closed = false
    const close = vi.fn(() => { if (closed) return; closed = true; options.onClosed?.() })
    const refresh = vi.fn()
    opened.push({ options, close, refresh })
    return { get closed() { return closed }, close, refresh }
  })
  const browser = () => opened[opened.length - 1]!.options
  const act = (event: Record<string, unknown>, signal = new AbortController().signal) => browser().action!(event as unknown as MayflyUiActionEvent, { signal } as MayflyUiEventContext)
  return { ...f, opened, browser, act }
}
const callback = (forms: readonly unknown[]) => ({ kind: 'submit', submission: { actionId: 'deliver-callback', forms } })
const forms = [{ formId: 'callback-paste', fields: [{ id: 'callback-url', value: 'http://127.0.0.1:6789/oauth/callback?code=fixture' }] }]

describe('RemoteAccountController native action retirement', () => {
  it('does not focus, read or watch for pre-cancelled account opens and retires pending state reads', async () => {
    const f = await fixture()
    const focus = vi.spyOn(f.ctx.mayflyOverlays, 'focus')
    const cancelled = new AbortController(); cancelled.abort()
    await f.accounts.open(f.client, cancelled.signal)
    expect(await f.accounts.createSignInFlow(f.client, vi.fn(), cancelled.signal)).toBeUndefined()
    expect(focus).not.toHaveBeenCalled()
    expect(f.account.getState).not.toHaveBeenCalled()
    const caller = new AbortController()
    const gate = Promise.withResolvers<Awaited<ReturnType<typeof f.account.getState>>>()
    f.account.getState.mockReturnValueOnce(gate.promise)
    const pending = f.accounts.open(f.client, caller.signal)
    caller.abort(); gate.resolve({ ok: true, value: accountView() })
    await pending
    expect(f.opened).toHaveLength(0)
    expect(f.account.watch).not.toHaveBeenCalled()
    expect(f.notice.set).not.toHaveBeenCalled()
  })

  it('keeps a focused account under its original caller and aborts its local watch on caller cancellation', async () => {
    const f = await fixture()
    const caller = new AbortController()
    await f.accounts.open(f.client, caller.signal)
    const first = f.opened[0]!
    vi.spyOn(f.ctx.mayflyOverlays, 'focus').mockReturnValueOnce(true)
    const second = new AbortController()
    await f.accounts.open(f.client, second.signal)
    second.abort()
    expect(first.close).not.toHaveBeenCalled()
    expect(f.account.getState).toHaveBeenCalledOnce()
    caller.abort()
    expect(first.close).toHaveBeenCalledOnce()
    expect(f.browser().isCurrent()).toBe(false)
    expect(await f.act({ kind: 'activate', actionId: 'sign-out' })).toEqual({ kind: 'cancelled' })
    expect(f.account.signOut).not.toHaveBeenCalled()
  })

  it('opens no panel or native watch for absent, disposed, or failed Host reads', async () => {
    const absent = await fixture()
    absent.detach(); await absent.accounts.open()
    expect(absent.account.getState).not.toHaveBeenCalled()
    const f = await fixture()
    f.account.getState.mockRejectedValueOnce(new Error('account state unavailable'))
    await f.accounts.open()
    expect(f.notice.set).toHaveBeenCalledExactlyOnceWith('account state unavailable')
    const response = Promise.withResolvers<Awaited<ReturnType<typeof f.account.getState>>>()
    f.account.getState.mockReturnValueOnce(response.promise)
    const opening = f.accounts.open()
    f.accounts.dispose(); response.reject(new Error('retired account state failed'))
    await opening
    await f.accounts.open(f.client)
    expect(f.notice.set).toHaveBeenCalledOnce()
    expect(f.opened).toEqual([])
  })

  it('validates cancelled and unrelated callback actions before any Host write', async () => {
    const f = await fixture()
    await f.accounts.open()
    expect(f.browser().isCurrent!()).toBe(true)
    const cancelled = new AbortController(); cancelled.abort()
    expect(await f.act({ kind: 'activate', actionId: 'sign-out' }, cancelled.signal)).toEqual({ kind: 'cancelled' })
    expect(f.account.signOut).not.toHaveBeenCalled()
    expect(await f.act({ kind: 'activate', actionId: 'unknown' })).toEqual({ kind: 'completed' })
    expect(await f.act({ kind: 'submit', submission: { actionId: 'other' } })).toEqual({ kind: 'completed' })
    expect(await f.act({ kind: 'dismiss' })).toEqual({ kind: 'completed' })
    for (const fields of [[], [{ formId: 'other', fields: [] }], [{ formId: 'callback-paste', fields: [] }], [{ formId: 'callback-paste', fields: [{ id: 'callback-url', value: 3 }] }]]) {
      expect(await f.act(callback(fields))).toMatchObject({ kind: 'invalid' })
    }
    expect(f.io.deliverCallback).not.toHaveBeenCalled()
    f.opened[0]!.close()
    expect(f.browser().isCurrent!()).toBe(false)
  })

  it('returns cancellation when link copying settles after its Host retires', async () => {
    const f = await fixture()
    f.account.getState.mockResolvedValueOnce({ ok: true, value: accountView('waiting-browser') })
    await f.accounts.open()
    const response = Promise.withResolvers<void>()
    f.io.copy.mockReturnValueOnce(response.promise)
    const copying = f.act({ kind: 'activate', actionId: 'copy-link' })
    f.reconnect(); response.resolve()
    expect(await copying).toEqual({ kind: 'cancelled' })
    expect(f.opened[0]!.close).toHaveBeenCalledOnce()
  })

  it.each([false, true])('fences callback completion and errors after owner replacement (reject=%s)', async rejected => {
    const f = await fixture()
    await f.accounts.open()
    const response = Promise.withResolvers<{ status: number }>()
    f.io.deliverCallback.mockReturnValueOnce(response.promise)
    const delivering = f.act(callback(forms))
    f.reconnect()
    if (rejected) response.reject(new Error('obsolete callback failed'))
    else response.resolve({ status: 200 })
    expect(await delivering).toEqual({ kind: 'cancelled' })
  })

  it('does not apply a late sign-out result and keeps a current native sign-out failure visible', async () => {
    const f = await fixture()
    await f.accounts.open()
    f.account.signOut.mockRejectedValueOnce(new Error('native sign-out failed'))
    expect(await f.act({ kind: 'activate', actionId: 'sign-out' })).toEqual({ kind: 'failed', message: 'native sign-out failed' })
    const response = Promise.withResolvers<Awaited<ReturnType<typeof f.account.signOut>>>()
    f.account.signOut.mockReturnValueOnce(response.promise)
    const signingOut = f.act({ kind: 'activate', actionId: 'sign-out' })
    f.reconnect(); response.resolve({ ok: true, value: accountView() })
    expect(await signingOut).toEqual({ kind: 'cancelled' })
  })

  it('keeps countdown ownership with one attempt and makes a queued interval inert after disposal', async () => {
    const f = await fixture()
    vi.useFakeTimers()
    const intervals = vi.spyOn(globalThis, 'setInterval')
    f.account.getState.mockResolvedValueOnce({ ok: true, value: accountView('waiting-browser') })
    await f.accounts.open()
    const view = JSON.stringify(f.browser().view())
    expect(view).toContain('Waiting for you to sign in in your browser')
    f.browser().view()
    const interval = intervals.mock.calls[0]![0] as () => void
    interval()
    expect(f.opened[0]!.refresh).not.toHaveBeenCalled()
    await f.act({ kind: 'activate', actionId: 'sign-in' })
    interval()
    expect(f.opened[0]!.refresh).toHaveBeenCalled()
    f.opened[0]!.close()
    const count = f.opened[0]!.refresh.mock.calls.length
    interval()
    expect(f.opened[0]!.refresh).toHaveBeenCalledTimes(count)
    expect(vi.getTimerCount()).toBe(0)
  })
})
