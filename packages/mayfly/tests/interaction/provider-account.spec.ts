/** DeepSeek account panel: sign-in flow, state projection, and sign-out.
 * @module @ephemeral-ai/mayfly/tests/interaction/provider-account
 */
import { Context } from '@deepseek-ai/cordis'
import type { AccountClientMetadata, AccountView, SignInAttemptId, SignInAttemptView } from '@deepseek-ai/dsh-deepseek-account'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAYFLY_VERSION } from '../../src/transcript/banner-content.ts'
import { setClipboardTextWriter } from '../../src/interaction/clipboard-write.ts'
import { accountInternals, accountPanelNode, callbackOrigin, clientMetadata, openAccountPanel, openUrlInBrowser, openerFor, parseCallbackLocation } from '../../src/interaction/provider-account.ts'
import { providerFixture } from './provider-fixture.ts'
import { flush } from '../helpers.ts'

const contexts: Context[] = []
// A Linux test host without a display skips the browser opener entirely; the
// opener seams below are what these tests exercise.
beforeEach(() => { vi.stubEnv('DISPLAY', ':1') })
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

const LINKS = { usageUrl: 'https://example/usage', topUpUrl: 'https://example/topup' }
const signedOut: AccountView = { status: 'signed-out', links: LINKS, attempt: null }
const stored: AccountView = { status: 'credential-stored', links: LINKS, attempt: null }

/** Minimal account double: the panel reads state, signs in and out, and watches. */
function fakeAccount(initial: AccountView) {
  const starts: Array<{ client: AccountClientMetadata, origin: string, source: string }> = []
  const cancels: SignInAttemptId[] = []
  const signOuts: AccountClientMetadata[] = []
  const failures = { start: false, cancel: false, signOut: false, initializing: false }
  let view = initial
  const listeners = new Set<() => void>()
  const publish = (next: AccountView): void => {
    view = next
    for (const listener of listeners) listener()
  }
  const api = {
    async getState(): Promise<AccountView> { return view },
    async startSignIn(client: AccountClientMetadata, origin: string, source: string): Promise<AccountView> {
      starts.push({ client, origin, source })
      if (failures.start) throw new Error('unavailable')
      publish({ ...view, attempt: failures.initializing
        ? { id: 'attempt' as never, phase: 'initializing' }
        : { id: `attempt-${String(starts.length)}` as never, phase: 'waiting-browser', authorizeUrl: `https://auth.example/authorize?origin=${origin}&n=${String(starts.length)}`, expiresAt: Date.now() + 600_000 } })
      return view
    },
    async cancelSignIn(id: SignInAttemptId): Promise<AccountView> {
      cancels.push(id)
      if (failures.cancel) throw new Error('unavailable')
      publish({ ...view, attempt: null })
      return view
    },
    async signOut(client: AccountClientMetadata): Promise<AccountView> {
      signOuts.push(client)
      if (failures.signOut) throw new Error('unavailable')
      publish({ ...view, status: 'signed-out' })
      return view
    },
    watch(signal: AbortSignal): AsyncIterable<AccountView> {
      return {
        async *[Symbol.asyncIterator]() {
          let notify: (() => void) | undefined
          const wake = () => notify?.()
          listeners.add(wake)
          signal.addEventListener('abort', () => { listeners.delete(wake); notify?.() }, { once: true })
          try {
            yield view
            while (!signal.aborted) {
              await new Promise<void>(resolve => {
                notify = () => { notify = undefined; resolve() }
              })
              if (signal.aborted) return
              yield view
            }
          } finally { listeners.delete(wake) }
        },
      }
    },
  }
  const complete = (): void => { publish({ ...view, status: 'credential-stored', attempt: { id: 'attempt-1' as never, phase: 'succeeded' } }) }
  return { api, starts, cancels, signOuts, failures, complete }
}

const accountLlm = {
  listProviders: () => [],
  listConfigurableProviders: () => [{ provider: 'deepseek-account', settingsNs: 'llm-deepseek-account' }],
}

async function bench(initial: AccountView, webServer?: { port: number }) {
  const ctx = new Context()
  contexts.push(ctx)
  const account = fakeAccount(initial)
  const fixture = await providerFixture(ctx, {}, accountLlm)
  ctx.provide('deepseekAccount', account.api as never)
  if (webServer !== undefined) ctx.provide('webServer', webServer as never)
  return { ...fixture, account }
}

const panelId = 'mayfly.provider-account.deepseek-account'

describe('DeepSeek account panel', () => {
  it('requires the native account service and the account adapter route', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const fixture = await providerFixture(ctx, {}, accountLlm)
    expect(await openAccountPanel(fixture.ctx, 'deepseek-account')).toBe(false)
    await ctx.fiber.dispose()
    const prepared = await bench(signedOut)
    expect(await openAccountPanel(prepared.ctx, 'glm')).toBe(false)
    expect(prepared.ctx.mayflyOverlays.list().map(entry => entry.id)).not.toContain(panelId)
  })

  it('explains the Desktop or Web host path only when no local webserver is composed', async () => {
    const { ctx } = await bench(signedOut)
    expect(await openAccountPanel(ctx, 'deepseek-account')).toBe(true)
    const model = ctx.mayflyUiInteraction.get('overlay', panelId)!
    const json = JSON.stringify(model.node)
    expect(json).toContain('Desktop or Web host')
    expect(json).not.toContain('"Sign in"')

    const withServer = await bench(signedOut, { port: 45678 })
    expect(await openAccountPanel(withServer.ctx, 'deepseek-account')).toBe(true)
    const serverModel = withServer.ctx.mayflyUiInteraction.get('overlay', panelId)!
    const serverJson = JSON.stringify(serverModel.node)
    expect(serverJson).toContain('Sign in with your DeepSeek account')
    expect(serverJson).not.toContain('Desktop or Web host')
    expect(serverJson).toContain('"Sign in"')
  })

  it('starts browser sign-in through the loopback callback and cancels it by attempt id', async () => {
    const spawned: Array<{ command: string, args: readonly string[] }> = []
    const original = accountInternals.spawnOpener
    accountInternals.spawnOpener = async (command, args) => { spawned.push({ command, args }); return true }
    try {
      const { ctx, account } = await bench(signedOut, { port: 45678 })
      expect(await openAccountPanel(ctx, 'deepseek-account')).toBe(true)
      const model = ctx.mayflyUiInteraction.get('overlay', panelId)!
      model.invoke('sign-in')
      await flush(4)
      expect(account.starts).toHaveLength(1)
      expect(account.starts[0]).toMatchObject({ origin: 'http://localhost:45678', source: 'desktop' })
      expect(account.starts[0]!.client).toMatchObject({ version: MAYFLY_VERSION, locale: expect.any(String), timezoneOffsetSeconds: expect.any(Number) })
      expect(spawned).toHaveLength(1)
      expect(spawned[0]!.args.at(-1)).toBe('https://auth.example/authorize?origin=http://localhost:45678&n=1')
      const json = JSON.stringify(model.node)
      // A browser opened: the page waits, shows the countdown, and keeps the
      // link actions as hidden accelerators. The paste-back form stays in the
      // tree but out of sight.
      expect(json).toContain('Waiting for you to sign in in your browser')
      expect(json).toContain('expires in ')
      expect(json).toContain('"id":"copy-link","label":"Copy link","key":"ctrl+y","hidden":true')
      expect(json).toContain('"id":"restart-sign-in","label":"New link","key":"ctrl+r","hidden":true')
      expect(json).toContain('"id":"show-paste","label":"Other machine","key":"p","hidden":true')
      expect(json).not.toContain('Sign-in link')
      expect(json).not.toContain('"Cancel sign-in"')
      expect(account.cancels).toEqual([])
    } finally {
      accountInternals.spawnOpener = original
    }
  })

  it('completes on the watch stream alone when the local browser hits the callback, with no paste', async () => {
    const original = accountInternals.spawnOpener
    accountInternals.spawnOpener = async () => true
    try {
      const { ctx, account } = await bench(signedOut, { port: 45678 })
      await openAccountPanel(ctx, 'deepseek-account')
      const model = ctx.mayflyUiInteraction.get('overlay', panelId)!
      model.invoke('sign-in')
      await flush(4)
      expect(JSON.stringify(model.node)).toContain('Waiting for you to sign in in your browser')
      // The loopback server completes the attempt; only the watch stream reports it.
      account.complete()
      await flush(4)
      const json = JSON.stringify(model.node)
      expect(json).toContain('Signed in')
      expect(json).toContain('Account models need no API key.')
      expect(json).not.toContain('callback-paste')
    } finally {
      accountInternals.spawnOpener = original
    }
  })

  it('copies the authorize link and reports a clipboard failure without leaving the panel', async () => {
    const copied: string[] = []
    let fail = false
    setClipboardTextWriter(async text => { if (fail) throw new Error('no clipboard'); copied.push(text) })
    const original = accountInternals.spawnOpener
    accountInternals.spawnOpener = async () => true
    try {
      const { ctx } = await bench(signedOut, { port: 45678 })
      await openAccountPanel(ctx, 'deepseek-account')
      const model = ctx.mayflyUiInteraction.get('overlay', panelId)!
      model.invoke('sign-in')
      await flush(4)
      expect(JSON.stringify(model.node)).toContain('"Copy link"')
      model.invoke('copy-link')
      await flush(4)
      expect(copied).toEqual(['https://auth.example/authorize?origin=http://localhost:45678&n=1'])
      fail = true
      model.invoke('copy-link')
      await flush(4)
      expect(copied).toHaveLength(1)
      expect(ctx.mayflyOverlays.list().map(entry => entry.id)).toContain(panelId)
    } finally {
      setClipboardTextWriter(undefined)
      accountInternals.spawnOpener = original
    }
  })

  it('delivers a pasted callback to the loopback server and reports rejection', async () => {
    const delivered: string[] = []
    const originalFetch = accountInternals.fetchCallback
    const originalOpener = accountInternals.spawnOpener
    accountInternals.fetchCallback = async url => { delivered.push(url); return { status: 204 } }
    accountInternals.spawnOpener = async () => false
    try {
      const { ctx } = await bench(signedOut, { port: 45678 })
      expect(await openAccountPanel(ctx, 'deepseek-account')).toBe(true)
      const model = ctx.mayflyUiInteraction.get('overlay', panelId)!
      model.invoke('sign-in')
      await flush(4)
      await flush(4)
      model.edit({ pagePath: [], formId: 'callback-paste', fieldId: 'callback-url' }, 'http://localhost:45678/oauth/callback?code=a&state=b')
      model.invoke('deliver-callback')
      await flush(4)
      expect(delivered).toEqual(['http://localhost:45678/oauth/callback?code=a&state=b'])
      expect(model.feedbackSnapshot().at(-1)?.message).toContain('Callback delivered')

      accountInternals.fetchCallback = async () => { throw new Error('unreachable') }
      model.edit({ pagePath: [], formId: 'callback-paste', fieldId: 'callback-url' }, 'http://localhost:45678/oauth/callback?code=e&state=f')
      model.invoke('deliver-callback')
      await flush(4)
      expect(model.feedbackSnapshot().at(-1)?.message).toContain('could not be delivered')

      accountInternals.fetchCallback = async () => ({ status: 400 })
      model.edit({ pagePath: [], formId: 'callback-paste', fieldId: 'callback-url' }, 'http://localhost:45678/oauth/callback?code=c&state=d')
      model.invoke('deliver-callback')
      await flush(4)
      expect(model.feedbackSnapshot().at(-1)?.severity).toBe('error')

      model.edit({ pagePath: [], formId: 'callback-paste', fieldId: 'callback-url' }, 'https://evil.example/oauth/callback?code=a&state=b')
      model.invoke('deliver-callback')
      await flush(4)
      expect(model.form({ pagePath: [], formId: 'callback-paste' })!.fields['callback-url']!.error).toContain('Paste the full callback address')
      expect(delivered).toHaveLength(1)
    } finally {
      accountInternals.fetchCallback = originalFetch
      accountInternals.spawnOpener = originalOpener
    }
  })

  it('validates pasted locations against the live loopback endpoint only', () => {
    const good = 'http://localhost:45678/oauth/callback?code=a&state=b'
    expect(parseCallbackLocation(good, 45678)?.href).toBe(good)
    expect(parseCallbackLocation('http://localhost:45678/oauth/callback?code=a&state=b', 45679)).toBeUndefined()
    expect(parseCallbackLocation('https://localhost:45678/oauth/callback', 45678)).toBeUndefined()
    expect(parseCallbackLocation('http://evil.example:45678/oauth/callback', 45678)).toBeUndefined()
    expect(parseCallbackLocation('http://localhost:45678/other', 45678)).toBeUndefined()
    expect(parseCallbackLocation('http://127.0.0.1:45678/oauth/callback?code=a', 45678)?.pathname).toBe('/oauth/callback')
    expect(parseCallbackLocation('not a url', 45678)).toBeUndefined()
  })

  it('surfaces a visible link instead of an error when the browser cannot open and reports native failures', async () => {
    const original = accountInternals.spawnOpener
    accountInternals.spawnOpener = async () => false
    try {
      const { ctx } = await bench(signedOut, { port: 45678 })
      expect(await openAccountPanel(ctx, 'deepseek-account')).toBe(true)
      const model = ctx.mayflyUiInteraction.get('overlay', panelId)!
      model.invoke('sign-in')
      await flush(4)
      expect(model.feedbackSnapshot().at(-1)?.message).toBeUndefined()
      const json = JSON.stringify(model.node)
      expect(json).toContain('Couldn’t open a browser')
      expect(json).toContain('https://auth.example/authorize?origin=http://localhost:45678&n=1')
    } finally {
      accountInternals.spawnOpener = original
    }

    const failing = await bench(stored, { port: 45678 })
    failing.account.failures.signOut = true
    expect(await openAccountPanel(failing.ctx, 'deepseek-account')).toBe(true)
    const failModel = failing.ctx.mayflyUiInteraction.get('overlay', panelId)!
    failModel.invoke('sign-out', [], true)
    await flush(4)
    expect(failModel.feedbackSnapshot().at(-1)?.severity).toBe('error')

    const startFail = await bench(signedOut, { port: 45678 })
    startFail.account.failures.start = true
    expect(await openAccountPanel(startFail.ctx, 'deepseek-account')).toBe(true)
    const startModel = startFail.ctx.mayflyUiInteraction.get('overlay', panelId)!
    startModel.invoke('sign-in')
    await flush(4)
    expect(startModel.feedbackSnapshot().at(-1)?.severity).toBe('error')

    const cancelFail = await bench({ status: 'signed-out', links: LINKS, attempt: { id: 'attempt' as never, phase: 'waiting-browser', authorizeUrl: 'https://auth.example/x' } }, { port: 45678 })
    cancelFail.account.failures.cancel = true
    expect(await openAccountPanel(cancelFail.ctx, 'deepseek-account')).toBe(true)
    const cancelModel = cancelFail.ctx.mayflyUiInteraction.get('overlay', panelId)!
    cancelModel.invoke('restart-sign-in')
    await flush(4)
    expect(cancelModel.feedbackSnapshot().at(-1)?.severity).toBe('error')
  })

  it('restarts with a fresh authorize URL by retiring the waiting attempt first', async () => {
    const urls: string[] = []
    const originalFetch = accountInternals.fetchCallback
    const originalOpener = accountInternals.spawnOpener
    accountInternals.fetchCallback = originalFetch
    accountInternals.spawnOpener = async () => false
    try {
      const { ctx, account } = await bench(signedOut, { port: 45678 })
      expect(await openAccountPanel(ctx, 'deepseek-account')).toBe(true)
      const model = ctx.mayflyUiInteraction.get('overlay', panelId)!
      model.invoke('sign-in')
      await flush(4)
      urls.push(JSON.stringify(model.node).match(/authorize\?origin=([^"]+)/)![1]!)
      expect(JSON.stringify(model.node)).toContain('"New link"')
      model.invoke('restart-sign-in')
      await flush(8)
      expect(account.cancels).toHaveLength(1)
      expect(account.starts).toHaveLength(2)
      expect(model.feedbackSnapshot().at(-1)?.message).toContain('restarted')
      const fresh = (await account.api.getState()).attempt?.authorizeUrl
      expect(fresh).toBeDefined()
      expect(fresh).not.toBe(urls[0])

    } finally {
      accountInternals.spawnOpener = originalOpener
    }

    const opened = await bench(signedOut, { port: 45678 })
    accountInternals.spawnOpener = async () => true
    try {
      expect(await openAccountPanel(opened.ctx, 'deepseek-account')).toBe(true)
      const openedModel = opened.ctx.mayflyUiInteraction.get('overlay', panelId)!
      openedModel.invoke('sign-in')
      await flush(4)
      openedModel.invoke('restart-sign-in')
      await flush(8)
      expect(opened.account.starts).toHaveLength(2)
      expect(openedModel.feedbackSnapshot().at(-1)?.message).toContain('Opened the sign-in page')
    } finally {
      accountInternals.spawnOpener = originalOpener
    }
  })

  it('offers retry after a failed attempt and signs out through the native service', async () => {
    const failed: AccountView = { status: 'signed-out', links: LINKS, attempt: { id: 'attempt' as never, phase: 'failed', errorCode: 'network' } }
    const { ctx } = await bench(failed, { port: 45678 })
    expect(await openAccountPanel(ctx, 'deepseek-account')).toBe(true)
    const model = ctx.mayflyUiInteraction.get('overlay', panelId)!
    expect(JSON.stringify(model.node)).toContain('Could not reach DeepSeek')
    expect(JSON.stringify(model.node)).toContain('"Try again"')

    const signedIn = await bench(stored, { port: 45678 })
    expect(await openAccountPanel(signedIn.ctx, 'deepseek-account')).toBe(true)
    const storedModel = signedIn.ctx.mayflyUiInteraction.get('overlay', panelId)!
    expect(JSON.stringify(storedModel.node)).toContain('Signed in')
    storedModel.invoke('sign-out', [], true)
    await flush(4)
    expect(signedIn.account.signOuts).toHaveLength(1)
    expect(JSON.stringify(storedModel.node)).toContain('Sign in with your DeepSeek account')
  })

  it('offers sign-in again after a cancelled, expired or unsaved attempt and names the reason', async () => {
    const cases: Array<[SignInAttemptView, string, string]> = [
      [{ id: 'a' as never, phase: 'cancelled' }, 'Sign-in cancelled', '"Sign in"'],
      [{ id: 'a' as never, phase: 'expired' }, 'The sign-in link expired', '"Try again"'],
      [{ id: 'a' as never, phase: 'failed', errorCode: 'expired' }, 'The sign-in link expired', '"Try again"'],
      [{ id: 'a' as never, phase: 'failed', errorCode: 'storage' }, 'could not be saved on this machine', '"Try again"'],
      [{ id: 'a' as never, phase: 'failed', errorCode: 'protocol' }, 'Sign-in failed — try again', '"Try again"'],
    ]
    for (const [attempt, text, action] of cases) {
      const { ctx } = await bench({ status: 'signed-out', links: LINKS, attempt }, { port: 45678 })
      expect(await openAccountPanel(ctx, 'deepseek-account')).toBe(true)
      const json = JSON.stringify(ctx.mayflyUiInteraction.get('overlay', panelId)!.node)
      expect(json).toContain(text)
      expect(json).toContain(action)
      expect(json).not.toContain('Signing in…')
    }
  })

  it('confirms a finished sign-in instead of showing it as in progress', async () => {
    const done: AccountView = { status: 'credential-stored', links: LINKS, attempt: { id: 'a' as never, phase: 'succeeded' } }
    const plain = await bench(done, { port: 45678 })
    await openAccountPanel(plain.ctx, 'deepseek-account')
    const plainJson = JSON.stringify(plain.ctx.mayflyUiInteraction.get('overlay', panelId)!.node)
    expect(plainJson).toContain('Signed in')
    expect(plainJson).toContain('Account models need no API key.')
    expect(plainJson).not.toContain('Signing in…')
    expect(plainJson).toContain('"Sign out"')
  })

  it('answers a stale copy against the live attempt state, not the waiting panel', async () => {
    const copied: string[] = []
    setClipboardTextWriter(async text => { copied.push(text) })
    const original = accountInternals.spawnOpener
    accountInternals.spawnOpener = async () => true
    try {
      const { ctx, account } = await bench(signedOut, { port: 45678 })
      await openAccountPanel(ctx, 'deepseek-account')
      const model = ctx.mayflyUiInteraction.get('overlay', panelId)!
      model.invoke('sign-in')
      await flush(4)
      // the service ends the attempt while the panel still shows its waiting link
      void account.api.cancelSignIn('attempt-1' as never)
      model.invoke('copy-link')
      await flush(4)
      expect(copied).toEqual([])
    } finally {
      setClipboardTextWriter(undefined)
      accountInternals.spawnOpener = original
    }
  })

  it('restarts from a stale waiting panel without retiring an attempt the service already ended', async () => {
    const original = accountInternals.spawnOpener
    accountInternals.spawnOpener = async () => true
    try {
      const { ctx, account } = await bench(signedOut, { port: 45678 })
      await openAccountPanel(ctx, 'deepseek-account')
      const model = ctx.mayflyUiInteraction.get('overlay', panelId)!
      model.invoke('sign-in')
      await flush(4)
      void account.api.cancelSignIn('attempt-1' as never)
      model.invoke('restart-sign-in')
      await flush(4)
      expect(account.cancels).toEqual(['attempt-1'])
      expect(account.starts).toHaveLength(2)
    } finally {
      accountInternals.spawnOpener = original
    }
  })

  it('drops the sign-in control and explains the host path once the local web server stops', async () => {
    const { ctx } = await bench(signedOut)
    const server = await ctx.plugin({ name: 'e2e-web-server', apply(plugin: Context) { plugin.provide('webServer', { port: 45678 } as never) } })
    expect(await openAccountPanel(ctx, 'deepseek-account')).toBe(true)
    const model = ctx.mayflyUiInteraction.get('overlay', panelId)!
    expect(JSON.stringify(model.node)).toContain('"Sign in"')
    await server.dispose()
    await flush(4)
    const json = JSON.stringify(model.node)
    expect(json).not.toContain('"Sign in"')
    expect(json).toContain('Desktop or Web host')
  })

  it('restarts into an attempt that has no link yet and reports the fresh restart after the wait', async () => {
    const original = accountInternals.spawnOpener
    accountInternals.spawnOpener = async () => true
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const { ctx, account } = await bench(signedOut, { port: 45678 })
      await openAccountPanel(ctx, 'deepseek-account')
      const model = ctx.mayflyUiInteraction.get('overlay', panelId)!
      model.invoke('sign-in')
      await vi.advanceTimersByTimeAsync(0)
      await flush(4)
      account.failures.initializing = true
      model.invoke('restart-sign-in')
      // The panel waits for the platform to issue the link before it replies.
      await vi.advanceTimersByTimeAsync(15_000)
      await flush(4)
      expect(model.feedbackSnapshot().at(-1)?.message).toBe('Sign-in restarted with a fresh link')
    } finally {
      vi.useRealTimers()
      accountInternals.spawnOpener = original
    }
  })

  it('ignores a watch view that arrives after the panel closed', async () => {
    const { ctx, account } = await bench(signedOut)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    account.api.watch = () => ({
      async *[Symbol.asyncIterator]() {
        yield signedOut
        await gate
        yield stored
      },
    })
    expect(await openAccountPanel(ctx, 'deepseek-account')).toBe(true)
    ctx.mayflyOverlays.close(panelId)
    release()
    await flush(4)
    expect(ctx.mayflyOverlays.list().map(entry => entry.id)).not.toContain(panelId)
  })
})

describe('DeepSeek account browser openers', () => {
  it('maps every platform to its system opener', () => {
    expect(openerFor('darwin')).toEqual({ command: 'open', prefix: [] })
    expect(openerFor('win32')).toEqual({ command: 'cmd', prefix: ['/c', 'start', ''] })
    expect(openerFor('linux')).toEqual({ command: 'xdg-open', prefix: [] })
  })

  it('resolves false for a missing opener executable and true for a real spawn', async () => {
    await expect(accountInternals.spawnOpener('mayfly-missing-opener-x', ['https://example'])).resolves.toBe(false)
    await expect(accountInternals.spawnOpener(process.execPath, ['--version'])).resolves.toBe(true)
  })

  it('derives the callback origin only while a webserver is composed', () => {
    const bare = new Context()
    contexts.push(bare)
    expect(callbackOrigin(bare)).toBeUndefined()
    const served = new Context()
    contexts.push(served)
    served.provide('webServer', { port: 41321 } as never)
    expect(callbackOrigin(served)).toBe('http://localhost:41321')
  })

  it('renders a waiting attempt without forwarding rows when no hint is available', () => {
    const waiting: AccountView = { status: 'signed-out', links: LINKS, attempt: { id: 'attempt' as never, phase: 'waiting-browser', authorizeUrl: 'https://auth.example/x', expiresAt: Date.now() + 60_000 } }
    const json = JSON.stringify(accountPanelNode(waiting, key => key, true))
    expect(json).toContain('Waiting for you to sign in in your browser')
    expect(json).toContain('expires in')
    expect(json).not.toContain('Sign-in link')
    expect(json).not.toContain('Port forward')
    expect(json).not.toContain('Browsing on your local machine')
  })

  it('delivers through the real fetch to a live loopback server', async () => {
    const { createServer } = await import('node:http')
    const server = createServer((_request, response) => { response.writeHead(204).end() })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      const url = `http://localhost:${typeof address === 'object' && address !== null ? address.port : 0}/oauth/callback?code=a`
      await expect(accountInternals.fetchCallback(url, new AbortController().signal)).resolves.toMatchObject({ status: 204 })
    } finally {
      server.close()
    }
  })

  it('opens through the current platform opener with the URL last', async () => {
    const original = accountInternals.spawnOpener
    const calls: string[] = []
    accountInternals.spawnOpener = async (command, args) => { calls.push(`${command} ${args.join(' ')}`); return true }
    try {
      await expect(openUrlInBrowser('https://example/signin')).resolves.toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toContain('https://example/signin')
    } finally {
      accountInternals.spawnOpener = original
    }
  })

  it('reports an opener that cannot take the URL as not opened instead of throwing', async () => {
    await expect(openUrlInBrowser('https://example/\u0000signin')).resolves.toBe(false)
  })
})

describe('DeepSeek account panel lifetime', () => {
  it('focuses the live panel on reopen and accepts a caller lifetime', async () => {
    const { ctx } = await bench(signedOut, { port: 45678 })
    expect(await openAccountPanel(ctx, 'deepseek-account')).toBe(true)
    expect(ctx.mayflyOverlays.list().map(entry => entry.id)).toContain(panelId)
    expect(await openAccountPanel(ctx, 'deepseek-account', new AbortController().signal)).toBe(true)
    expect(ctx.mayflyOverlays.list().filter(entry => entry.id === panelId)).toHaveLength(1)
  })

  it('keeps the panel usable while the attempt is still initializing without a URL', async () => {
    const original = accountInternals.spawnOpener
    accountInternals.spawnOpener = async () => true
    try {
      const initializing = await bench(signedOut, { port: 45678 })
      initializing.account.failures.initializing = true
      expect(await openAccountPanel(initializing.ctx, 'deepseek-account')).toBe(true)
      const model = initializing.ctx.mayflyUiInteraction.get('overlay', panelId)!
      model.invoke('sign-in')
      await flush(4)
      const json = JSON.stringify(model.node)
      // Until the platform issues the link the page stays on the sign-in
      // offer; the overlay remains open and usable.
      expect(json).toContain('Sign in with your DeepSeek account')
      expect(json).toContain('"Sign in"')
      expect(json).not.toContain('Signing in…')
    } finally {
      accountInternals.spawnOpener = original
    }
  })

  it('derives the client locale with an English fallback when no locale service exists', () => {
    const bare = new Context()
    contexts.push(bare)
    const metadata = clientMetadata(bare)
    expect(metadata.locale).toBe('en')
    expect(metadata.version).toBe(MAYFLY_VERSION)
    expect(typeof metadata.timezoneOffsetSeconds).toBe('number')
  })
})
