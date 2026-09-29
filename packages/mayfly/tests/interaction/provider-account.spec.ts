/** DeepSeek account panel: state projection, sign-in guidance, and sign-out.
 * @module @ephemeral-ai/mayfly/tests/interaction/provider-account
 */
import { Context } from '@deepseek-ai/cordis'
import type { AccountClientMetadata, AccountView } from '@deepseek-ai/dsh-deepseek-account'
import { afterEach, describe, expect, it } from 'vitest'
import { MAYFLY_VERSION } from '../../src/transcript/banner-content.ts'
import { openAccountPanel } from '../../src/interaction/provider-account.ts'
import { providerFixture } from './provider-fixture.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
const flush = async (times = 4): Promise<void> => { for (let index = 0; index < times; index += 1) await new Promise<void>(resolve => { setImmediate(resolve) }) }

const LINKS = { usageUrl: 'https://example/usage', topUpUrl: 'https://example/topup' }
const signedOut: AccountView = { status: 'signed-out', links: LINKS, attempt: null }
const stored: AccountView = { status: 'credential-stored', links: LINKS, attempt: null }

/** Minimal account double: the panel reads state, signs out, and watches. */
function fakeAccount(initial: AccountView) {
  const signOuts: AccountClientMetadata[] = []
  let view = initial
  const listeners = new Set<() => void>()
  const api = {
    async getState(): Promise<AccountView> { return view },
    async signOut(client: AccountClientMetadata): Promise<AccountView> {
      signOuts.push(client)
      view = { ...view, status: 'signed-out' }
      for (const listener of listeners) listener()
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
  return { api, signOuts }
}

const accountLlm = {
  listProviders: () => [],
  listConfigurableProviders: () => [{ provider: 'deepseek-account', settingsNs: 'llm-deepseek-account' }],
}

async function bench(initial: AccountView) {
  const ctx = new Context()
  contexts.push(ctx)
  const account = fakeAccount(initial)
  const fixture = await providerFixture(ctx, {}, accountLlm)
  ctx.provide('deepseekAccount', account.api as never)
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

  it('shows sign-in guidance instead of a dead end while signed out', async () => {
    const { ctx } = await bench(signedOut)
    expect(await openAccountPanel(ctx, 'deepseek-account')).toBe(true)
    const model = ctx.mayflyUiInteraction.get('overlay', panelId)
    expect(model?.node).toBeDefined()
    const json = JSON.stringify(model!.node)
    expect(json).toContain('Not signed in')
    expect(json).toContain('Desktop or Web host')
    expect(json).not.toContain('"Sign out"')
  })

  it('signs out through the native service and repaints from the watch stream', async () => {
    const { ctx, account } = await bench(stored)
    expect(await openAccountPanel(ctx, 'deepseek-account')).toBe(true)
    const model = ctx.mayflyUiInteraction.get('overlay', panelId)!
    expect(JSON.stringify(model.node)).toContain('Signed in')
    model.invoke('sign-out', [], true)
    await flush()
    expect(account.signOuts).toHaveLength(1)
    expect(account.signOuts[0]).toMatchObject({ version: MAYFLY_VERSION, locale: expect.any(String), timezoneOffsetSeconds: expect.any(Number) })
    expect(JSON.stringify(model.node)).toContain('Not signed in')
    expect(JSON.stringify(model.node)).toContain('Desktop or Web host')
  })
})
