/** Account panel exercises the real browser, UI provider, event admission, and native account flow. @module */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildAccountPanel } from '@ephemeral-ai/mayfly/configuration-panels'
import type { MayflyUiActionEvent } from '@ephemeral-ai/mayfly-ui'
import { accountFixture, accountView } from './account-feature-fixture.ts'

const fixtures: Awaited<ReturnType<typeof accountFixture>>[] = []
afterEach(async () => { for (const fixture of fixtures.splice(0).reverse()) await fixture.cleanup(); vi.useRealTimers() })
async function fixture() { const value = await accountFixture(); fixtures.push(value); return value }
const callback = (raw: string): MayflyUiActionEvent => ({
  kind: 'submit', controlId: 'callback-paste', pagePath: [],
  submission: { actionId: 'deliver-callback', draftRevision: 1, source: [{ resourceId: 'mayfly.provider-account.deepseek-account', revision: 1 }], forms: [{ formId: 'callback-paste', pagePath: [], draftRevision: 1, fields: [{ id: 'callback-url', change: 'set', value: raw }] }] },
})

describe('RemoteAccountController shared browser lifecycle', () => {
  it('mounts exactly the shared rc.2 account model with native facts', async () => {
    const f = await fixture()
    await f.accounts.open()
    const entry = f.current()
    expect(entry.id).toBe('mayfly.provider-account.deepseek-account')
    expect(entry.definition).toMatchObject({ presentation: 'editor', capturing: true, dismissal: 'discard', scope: { kind: 'app', targetId: 'account/deepseek-account' } })
    expect(entry.node).toEqual(buildAccountPanel(accountView(), f.context.t, true, 6789, { now: Date.now(), launching: true, focusPaste: false, pasteOpen: false, delivering: false }))
    expect(f.stream.listeners.size).toBe(1)
    expect(f.localeListeners.size).toBe(1)
  })
  it('closing the panel aborts only native observation and removes every local subscription', async () => {
    const f = await fixture()
    await f.accounts.open()
    await f.activate('sign-in')
    await f.dismiss()
    expect(f.ctx.mayflyOverlays.list()).toEqual([])
    expect(f.stream.signals[0]!.aborted).toBe(true)
    await vi.waitFor(() => { expect(f.stream.listeners.size).toBe(0) })
    expect(f.localeListeners.size).toBe(0)
    expect(f.account.cancelSignIn).not.toHaveBeenCalled()
    expect(f.account.signOut).not.toHaveBeenCalled()
  })
  it('opens manual callback on browser failure, validates paste, and reflects native success before sign-out', async () => {
    const f = await fixture()
    f.io.openBrowser.mockResolvedValueOnce(false)
    await f.accounts.open()
    await f.activate('sign-in')
    expect(JSON.stringify(f.current().node)).toContain('Couldn’t open a browser')
    expect(JSON.stringify(f.current().node)).toContain('callback-paste')
    const invalid = await f.dispatch(callback('https://attacker.example/oauth/callback?code=fixture'))
    expect(invalid).toMatchObject({ kind: 'invalid', errors: [{ formId: 'callback-paste', fieldId: 'callback-url' }] })
    expect(f.io.deliverCallback).not.toHaveBeenCalled()
    f.io.deliverCallback.mockResolvedValueOnce({ status: 403 })
    expect(await f.dispatch(callback('http://127.0.0.1:6789/oauth/callback?code=fixture'))).toMatchObject({ kind: 'failed', message: expect.stringContaining('not accepted') })
    expect(await f.dispatch(callback('http://127.0.0.1:6789/oauth/callback?code=fixture'))).toMatchObject({ kind: 'accepted', feedback: { severity: 'success' } })
    expect(JSON.stringify(f.current().node)).not.toContain('Account models need no API key.')
    f.stream.emit(accountView('succeeded'))
    await vi.waitFor(() => { expect(JSON.stringify(f.current().node)).toContain('Account models need no API key.') })
    await f.activate('sign-out')
    expect(f.account.signOut).toHaveBeenCalledOnce()
    expect(JSON.stringify(f.current().node)).toContain('Sign in with your DeepSeek account')
  })
  it('copies the current link with feedback and gives failed actions a structured safe reply', async () => {
    const f = await fixture()
    await f.accounts.open()
    expect(await f.activate('copy-link')).toMatchObject({ kind: 'failed', message: 'No sign-in link is available' })
    await f.activate('sign-in')
    expect(await f.activate('copy-link')).toEqual({ kind: 'completed', feedback: { severity: 'success', message: 'Sign-in link copied' } })
    await f.activate('show-paste')
    expect(JSON.stringify(f.current().node)).toContain('callback-paste')
    await f.activate('restart-sign-in')
    expect(f.account.cancelSignIn).toHaveBeenCalledExactlyOnceWith('attempt-1')
    expect(f.account.startSignIn).toHaveBeenCalledTimes(2)
  })
  it.each(['detach', 'reconnect', 'switchHost'] as const)('closes the panel and fences an unfinished sign-in when %s retires the Host operation', async reason => {
    const f = await fixture()
    const started = Promise.withResolvers<Awaited<ReturnType<typeof f.account.startSignIn>>>()
    f.account.startSignIn.mockReturnValueOnce(started.promise)
    await f.accounts.open()
    const entry = f.current()
    const signing = f.activate('sign-in')
    await vi.waitFor(() => { expect(f.account.startSignIn).toHaveBeenCalledOnce() })
    f[reason]()
    started.resolve({ ok: true, value: accountView('waiting-browser') })
    await signing
    expect(f.ctx.mayflyOverlays.list()).toEqual([])
    expect(f.stream.signals[0]!.aborted).toBe(true)
    expect(f.io.openBrowser).not.toHaveBeenCalled()
    expect(f.account.cancelSignIn).not.toHaveBeenCalled()
    const stale = await entry.events.prepare({ kind: 'activate', controlId: 'account-actions', actionId: 'sign-out', pagePath: [] }, {
      surfaceId: entry.id, source: entry.source, revision: entry.revision, operationId: 'retired-action', signal: new AbortController().signal, report: vi.fn(),
    })
    expect(stale.reply).toBeUndefined()
    expect(stale.publish()).toBe(false)
    expect(f.account.signOut).not.toHaveBeenCalled()
  })
  it('drops delayed account reads after local teardown and leaves no orphan watch or panel', async () => {
    const f = await fixture()
    const reading = Promise.withResolvers<Awaited<ReturnType<typeof f.account.getState>>>()
    f.account.getState.mockReturnValueOnce(reading.promise)
    const opening = f.accounts.open()
    f.accounts.dispose()
    reading.resolve({ ok: true, value: accountView() })
    await opening
    expect(f.ctx.mayflyOverlays.list()).toEqual([])
    expect(f.account.watch).not.toHaveBeenCalled()
    expect(f.notice.set).not.toHaveBeenCalled()
  })
  it('refreshes countdown through the live panel clock and stops its timer on close', async () => {
    const f = await fixture()
    vi.useFakeTimers()
    await f.accounts.open()
    await f.activate('sign-in')
    const revision = f.current().revision
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.current().revision).toBeGreaterThan(revision)
    await f.dismiss()
    expect(vi.getTimerCount()).toBe(0)
  })
})
