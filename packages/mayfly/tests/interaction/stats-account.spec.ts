/** The `/stats` Account tab's provider facts: DeepSeek balance parsing and
 * addition, the official API-key balance call, the Platform account read, and
 * any other route's profile/key facts.
 * @module @ephemeral-ai/mayfly/tests/interaction/stats-account
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addDecimal, balanceInternals, isLowBalance, parseBalance, readAccountSnapshot,
  type BalanceResult, type Wallet,
} from '../../src/interaction/stats-account.ts'

const originalFetchBalance = balanceInternals.fetchBalance
const contexts: Context[] = []
afterEach(async () => {
  balanceInternals.fetchBalance = originalFetchBalance
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

const signal = (): AbortSignal => new AbortController().signal
const ready = (wallets: readonly Wallet[], available?: boolean): BalanceResult => ({ status: 'ready', wallets, available })
const DEEPSEEK_LINKS = { topUp: 'https://platform.deepseek.com/top_up', usage: 'https://platform.deepseek.com/usage' }

function context(): Context {
  const ctx = new Context()
  contexts.push(ctx)
  return ctx
}

const llm = (options: {
  providers?: readonly { readonly id: string, readonly name: string }[]
  configurable?: readonly { readonly provider: string, readonly settingsNs: string, readonly settingsPath?: readonly string[], readonly displayName?: string }[]
} = {}) => ({
  listProviders: () => options.providers ?? [],
  listConfigurableProviders: () => options.configurable ?? [],
})

const settings = (value: unknown, ns = 'llm-pi-ai') => ({
  describe: () => [{ ns, value }],
})

describe('addDecimal', () => {
  it('adds whole numbers without a decimal point', () => {
    expect(addDecimal('1', '2')).toBe('3')
    expect(addDecimal('10', '0')).toBe('10')
  })

  it('aligns fractions, keeps trailing precision, and carries into the whole part', () => {
    expect(addDecimal('1.5', '2.25')).toBe('3.75')
    expect(addDecimal('0.1', '0.2')).toBe('0.3')
    expect(addDecimal('9.9', '0.1')).toBe('10.0')
    expect(addDecimal('0', '2.5')).toBe('2.5')
    expect(addDecimal('2.50', '0.5')).toBe('3.00')
  })
})

describe('parseBalance', () => {
  it('reads the wallets the documented payload carries', () => {
    const parsed = parseBalance({
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '12.34', granted_balance: '2.00', topped_up_balance: '10.34' },
        { currency: 'USD', total_balance: '1.5', granted_balance: '0.5' },
      ],
    })
    expect(parsed).toEqual({
      available: true,
      wallets: [
        { currency: 'CNY', total: '12.34', granted: '2.00', toppedUp: '10.34' },
        { currency: 'USD', total: '1.5', granted: '0.5' },
      ],
    })
    expect(parseBalance({ balance_infos: [] })).toEqual({ wallets: [], available: undefined })
    expect(parseBalance({ is_available: 'yes', balance_infos: [{ currency: 'USD', total_balance: '1' }] })).toEqual({
      wallets: [{ currency: 'USD', total: '1' }], available: undefined,
    })
  })

  it('rejects a payload of the wrong shape', () => {
    expect(parseBalance(null)).toBeUndefined()
    expect(parseBalance('balance')).toBeUndefined()
    expect(parseBalance({})).toBeUndefined()
    expect(parseBalance({ balance_infos: '12.00' })).toBeUndefined()
    expect(parseBalance({ balance_infos: [null] })).toBeUndefined()
    expect(parseBalance({ balance_infos: [{ currency: 'EUR', total_balance: '1' }] })).toBeUndefined()
    expect(parseBalance({ balance_infos: [{ currency: 'USD', total_balance: 1 }] })).toBeUndefined()
    expect(parseBalance({ balance_infos: [{ currency: 'USD', total_balance: '-1' }] })).toBeUndefined()
  })
})

describe('isLowBalance', () => {
  const thresholds = { CNY: 10, USD: 1.5 }

  it('is low when nothing is available or every wallet is under its threshold', () => {
    expect(isLowBalance(undefined, thresholds)).toBe(false)
    expect(isLowBalance({ status: 'unavailable', reason: 'network' }, thresholds)).toBe(false)
    expect(isLowBalance(ready([], false), thresholds)).toBe(true)
    expect(isLowBalance(ready([{ currency: 'CNY', total: '9.99' }]), thresholds)).toBe(true)
    expect(isLowBalance(ready([{ currency: 'CNY', total: '9.99' }, { currency: 'USD', total: '1.49' }]), thresholds)).toBe(true)
  })

  it('is not low with an empty wallet list, a wallet at its threshold, or one above it', () => {
    expect(isLowBalance(ready([]), thresholds)).toBe(false)
    expect(isLowBalance(ready([{ currency: 'CNY', total: '10' }]), thresholds)).toBe(false)
    expect(isLowBalance(ready([{ currency: 'CNY', total: '1' }, { currency: 'USD', total: '2' }]), thresholds)).toBe(false)
  })
})

describe('readAccountSnapshot', () => {
  it('shows a route without services as an unpriced other provider with an unconfigured derived key', async () => {
    const ctx = context()
    const before = Date.now()
    const snapshot = await readAccountSnapshot(ctx, 'glm', signal())
    expect(snapshot).toEqual({
      route: 'glm', name: 'glm', kind: 'other',
      key: { ref: 'GLM_API_KEY', configured: false }, at: snapshot.at,
    })
    expect(snapshot.at).toBeGreaterThanOrEqual(before)
    expect(snapshot.endpoint).toBeUndefined()
    expect(snapshot.models).toBeUndefined()
    expect(snapshot.balance).toBeUndefined()
  })

  it('reports an official route without a key and reads its configured key from the public endpoint', async () => {
    const missing = context()
    missing.provide('credentials', { resolve: async () => undefined, describe: async () => ({ configured: false }) } as never)
    const unconfigured = await readAccountSnapshot(missing, 'deepseek-official', signal())
    expect(unconfigured).toMatchObject({
      route: 'deepseek-official', name: 'deepseek-official', kind: 'api-key',
      key: { ref: 'DEEPSEEK_API_KEY', configured: false }, balance: { status: 'unavailable', reason: 'no-key' },
    })

    const ctx = context()
    ctx.provide('llm', llm({ providers: [{ id: 'deepseek-official', name: 'DeepSeek' }] }) as never)
    ctx.provide('credentials', { resolve: async () => ({ value: 'secret' }), describe: async () => ({ configured: true }) } as never)
    const calls: { url: string, key: string }[] = []
    balanceInternals.fetchBalance = async (url, key) => {
      calls.push({ url, key })
      return { status: 200, body: { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '10.00' }] } }
    }
    const snapshot = await readAccountSnapshot(ctx, 'deepseek-official', signal())
    expect(calls).toEqual([{ url: 'https://api.deepseek.com/user/balance', key: 'secret' }])
    expect(snapshot).toMatchObject({
      name: 'DeepSeek', kind: 'api-key', key: { ref: 'DEEPSEEK_API_KEY', configured: true },
      balance: { status: 'ready', available: true, wallets: [{ currency: 'CNY', total: '10.00' }] },
    })
  })

  it('takes the official endpoint from the configured profile, then the environment', async () => {
    const configured = context()
    configured.provide('llm', llm({ configurable: [{ provider: 'deepseek-official', settingsNs: 'llm-deepseek', settingsPath: [] }] }) as never)
    configured.provide('settings', settings({ baseURL: 'https://configured.example/v1/api' }, 'llm-deepseek') as never)
    configured.provide('credentials', { resolve: async () => ({ value: 'k' }), describe: async () => ({ configured: true }) } as never)
    let url = ''
    balanceInternals.fetchBalance = async requested => { url = requested; return { status: 200, body: { balance_infos: [] } } }
    await readAccountSnapshot(configured, 'deepseek-official', signal())
    expect(url).toBe('https://configured.example/user/balance')

    const fromEnv = context()
    vi.stubEnv('DEEPSEEK_BASE_URL', 'https://env.example')
    fromEnv.provide('credentials', { resolve: async () => ({ value: 'k' }), describe: async () => ({ configured: true }) } as never)
    balanceInternals.fetchBalance = async requested => { url = requested; return { status: 200, body: { balance_infos: [] } } }
    await readAccountSnapshot(fromEnv, 'deepseek-official', signal())
    expect(url).toBe('https://env.example/user/balance')

    const emptyEnv = context()
    vi.stubEnv('DEEPSEEK_BASE_URL', '')
    emptyEnv.provide('llm', llm({ configurable: [{ provider: 'deepseek-official', settingsNs: 'llm-deepseek' }] }) as never)
    emptyEnv.provide('settings', settings({ baseURL: '' }, 'llm-deepseek') as never)
    emptyEnv.provide('credentials', { resolve: async () => ({ value: 'k' }), describe: async () => ({ configured: true }) } as never)
    balanceInternals.fetchBalance = async requested => { url = requested; return { status: 200, body: { balance_infos: [] } } }
    await readAccountSnapshot(emptyEnv, 'deepseek-official', signal())
    expect(url).toBe('https://api.deepseek.com/user/balance')
  })

  it('maps the balance call status to rejected, network, or a malformed-answer network error', async () => {
    const ctx = context()
    ctx.provide('credentials', { resolve: async () => ({ value: 'k' }), describe: async () => ({ configured: true }) } as never)
    const reasons: string[] = []
    for (const [status, body] of [[401, undefined], [403, undefined], [500, { balance_infos: [] }], [200, { nope: true }]] as const) {
      balanceInternals.fetchBalance = async () => ({ status, body })
      const snapshot = await readAccountSnapshot(ctx, 'deepseek-official', signal())
      reasons.push(snapshot.balance?.status === 'unavailable' ? snapshot.balance.reason : snapshot.balance?.status ?? 'missing')
    }
    expect(reasons).toEqual(['rejected', 'rejected', 'network', 'network'])
    balanceInternals.fetchBalance = async () => { throw new Error('offline') }
    expect((await readAccountSnapshot(ctx, 'deepseek-official', signal())).balance).toEqual({ status: 'unavailable', reason: 'network' })
    balanceInternals.fetchBalance = async () => { throw 'offline' }
    expect((await readAccountSnapshot(ctx, 'deepseek-official', signal())).balance).toEqual({ status: 'unavailable', reason: 'network' })
  })

  it('reports no key when the credential store is absent or failing', async () => {
    const absent = context()
    absent.provide('credentials', { resolve: async () => { throw new Error('locked') }, describe: async () => { throw new Error('locked') } } as never)
    expect((await readAccountSnapshot(absent, 'deepseek-official', signal())).balance).toEqual({ status: 'unavailable', reason: 'no-key' })
    const none = context()
    expect((await readAccountSnapshot(none, 'deepseek-official', signal())).balance).toEqual({ status: 'unavailable', reason: 'no-key' })
    const unresolved = context()
    unresolved.provide('credentials', { describe: async () => ({ configured: true }), resolve: async () => undefined } as never)
    expect((await readAccountSnapshot(unresolved, 'deepseek-official', signal())).balance).toEqual({ status: 'unavailable', reason: 'no-key' })
    const rejectedResolve = context()
    rejectedResolve.provide('credentials', { describe: async () => ({ configured: true }), resolve: async () => { throw new Error('locked') } } as never)
    expect((await readAccountSnapshot(rejectedResolve, 'deepseek-official', signal())).balance).toEqual({ status: 'unavailable', reason: 'no-key' })
  })

  it('reads one JSON document over fetch with a bearer key and maps a failed status to no body', async () => {
    const requests: { url: string, init: RequestInit }[] = []
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, init })
      return { ok: true, status: 200, json: async () => ({ is_available: true, balance_infos: [] }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    expect(await balanceInternals.fetchBalance('https://api.example/user/balance', 'secret', signal())).toEqual({
      status: 200, body: { is_available: true, balance_infos: [] },
    })
    expect(requests[0]!.url).toBe('https://api.example/user/balance')
    expect(requests[0]!.init).toMatchObject({ headers: { accept: 'application/json', authorization: 'Bearer secret' }, redirect: 'error' })

    const failed = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({ error: 'slow down' }) }))
    vi.stubGlobal('fetch', failed)
    expect(await balanceInternals.fetchBalance('https://api.example/user/balance', 'secret', signal())).toEqual({ status: 429, body: undefined })
  })
})

/** The fake account service: its state, profile, and balance are scripted per test. */
function accountService(options: {
  state?: unknown | (() => Promise<unknown>)
  profile?: unknown
  balance?: unknown
} = {}) {
  const state = options.state
  return {
    getState: vi.fn(async () => {
      if (typeof state === 'function') return await (state as () => Promise<unknown>)()
      return state ?? { status: 'signed-out', links: { topUpUrl: 'https://t', usageUrl: 'https://u' } }
    }),
    getProfile: vi.fn(async () => options.profile ?? null),
    getBalance: vi.fn(async () => options.balance ?? null),
  }
}

const ACCOUNT_ROUTE = {
  provider: 'deepseek-account', settingsNs: 'llm-deepseek-account', settingsPath: [], displayName: 'DeepSeek Account',
}

describe('readAccountSnapshot for the DeepSeek account route', () => {
  it('reports signed out with the platform links', async () => {
    const ctx = context()
    ctx.provide('llm', llm({ providers: [{ id: 'deepseek-account', name: 'DeepSeek Account' }], configurable: [ACCOUNT_ROUTE] }) as never)
    ctx.provide('deepseekAccount', accountService() as never)
    const snapshot = await readAccountSnapshot(ctx, 'deepseek-account', signal())
    expect(snapshot).toMatchObject({
      route: 'deepseek-account', name: 'DeepSeek Account', kind: 'account', signedIn: false,
      links: { topUp: 'https://t', usage: 'https://u' }, balance: { status: 'unavailable', reason: 'signed-out' },
    })
    expect(snapshot.profile).toBeUndefined()
  })

  it('falls back to the public links when the state read fails', async () => {
    const ctx = context()
    ctx.provide('llm', llm({ configurable: [ACCOUNT_ROUTE] }) as never)
    ctx.provide('deepseekAccount', accountService({ state: async () => { throw new Error('unavailable') } }) as never)
    const snapshot = await readAccountSnapshot(ctx, 'deepseek-account', signal())
    expect(snapshot).toMatchObject({ signedIn: false, links: DEEPSEEK_LINKS, balance: { status: 'unavailable', reason: 'signed-out' } })
  })

  it('shows a signed-in profile and adds top-up and granted wallets per currency', async () => {
    const ctx = context()
    ctx.provide('llm', llm({ configurable: [ACCOUNT_ROUTE] }) as never)
    ctx.provide('deepseekAccount', accountService({
      state: { status: 'credential-stored', links: { topUpUrl: 'https://t', usageUrl: 'https://u' } },
      profile: { status: 'ready', value: { name: 'Ada', contact: 'ada@example' } },
      balance: {
        status: 'ready',
        value: [{ currency: 'CNY', balance: '5.50' }],
        bonusWallets: [{ currency: 'CNY', balance: '0.50' }, { currency: 'USD', balance: '2' }],
      },
    }) as never)
    const snapshot = await readAccountSnapshot(ctx, 'deepseek-account', signal())
    expect(snapshot).toMatchObject({
      signedIn: true, profile: { name: 'Ada', contact: 'ada@example' },
      balance: {
        status: 'ready', available: undefined,
        wallets: [
          { currency: 'CNY', total: '6.00', toppedUp: '5.50', granted: '0.50' },
          { currency: 'USD', total: '2', granted: '2' },
        ],
      },
    })
    expect(snapshot.balance?.status === 'ready' ? snapshot.balance.wallets[1]!.toppedUp : 'x').toBeUndefined()
  })

  it('keeps a wallet that has only a top-up and no grant', async () => {
    const ctx = context()
    ctx.provide('llm', llm({ configurable: [ACCOUNT_ROUTE] }) as never)
    ctx.provide('deepseekAccount', accountService({
      state: { status: 'credential-stored', links: { topUpUrl: 'https://t', usageUrl: 'https://u' } },
      profile: { status: 'ready', value: { name: 'Ada', contact: null } },
      balance: { status: 'ready', value: [{ currency: 'CNY', balance: '3' }], bonusWallets: [] },
    }) as never)
    const snapshot = await readAccountSnapshot(ctx, 'deepseek-account', signal())
    expect(snapshot.profile).toEqual({ name: 'Ada', contact: null })
    expect(snapshot.balance).toEqual({ status: 'ready', available: undefined, wallets: [{ currency: 'CNY', total: '3', toppedUp: '3' }] })
  })

  it('keeps a signed-in read without a ready profile or a ready balance shaped', async () => {
    const ctx = context()
    ctx.provide('llm', llm({ configurable: [ACCOUNT_ROUTE] }) as never)
    const failing = accountService({
      state: { status: 'credential-stored', links: { topUpUrl: 'https://t', usageUrl: 'https://u' } },
      profile: { status: 'pending' },
      balance: null,
    })
    ctx.provide('deepseekAccount', failing as never)
    const noBalance = await readAccountSnapshot(ctx, 'deepseek-account', signal())
    expect(noBalance).toMatchObject({ signedIn: true, balance: { status: 'unavailable', reason: 'network' } })
    expect(noBalance.profile).toBeUndefined()

    const throwing = context()
    throwing.provide('llm', llm({ configurable: [ACCOUNT_ROUTE] }) as never)
    throwing.provide('deepseekAccount', {
      getState: vi.fn(async () => ({ status: 'credential-stored', links: { topUpUrl: 'https://t', usageUrl: 'https://u' } })),
      getProfile: vi.fn(async () => { throw new Error('profile down') }),
      getBalance: vi.fn(async () => { throw new Error('balance down') }),
    } as never)
    expect((await readAccountSnapshot(throwing, 'deepseek-account', signal())).balance).toEqual({ status: 'unavailable', reason: 'network' })

    const rejected = context()
    rejected.provide('llm', llm({ configurable: [ACCOUNT_ROUTE] }) as never)
    rejected.provide('deepseekAccount', {
      getState: vi.fn(async () => ({ status: 'credential-stored', links: { topUpUrl: 'https://t', usageUrl: 'https://u' } })),
      getProfile: vi.fn(async () => { throw new Error('profile down') }),
      getBalance: vi.fn(async () => ({ status: 'ready', value: [], bonusWallets: [] })),
    } as never)
    const empty = await readAccountSnapshot(rejected, 'deepseek-account', signal())
    expect(empty).toMatchObject({ signedIn: true, balance: { status: 'ready', available: undefined, wallets: [] } })
    expect(empty.profile).toBeUndefined()
  })
})

describe('readAccountSnapshot for another provider', () => {
  const directory = { provider: 'acme', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'acme'], displayName: 'Acme' }

  it('shows the native profile name, endpoint, model count, and configured key', async () => {
    const ctx = context()
    ctx.provide('llm', llm({ providers: [{ id: 'acme', name: 'Acme' }], configurable: [directory] }) as never)
    ctx.provide('settings', settings({
      providers: { acme: { displayName: 'Acme Pro', baseURL: 'https://acme.example/v1', apiKeyEnv: 'ACME_KEY', models: [{ id: 'a' }, { id: 'b' }] } },
    }) as never)
    ctx.provide('credentials', { describe: async (ref: unknown) => ({ configured: ref === 'ACME_KEY' }) } as never)
    const snapshot = await readAccountSnapshot(ctx, 'acme', signal())
    expect(snapshot).toMatchObject({
      route: 'acme', name: 'Acme Pro', kind: 'other', endpoint: 'https://acme.example/v1', models: 2,
      key: { ref: 'ACME_KEY', configured: true },
    })
  })

  it('falls back to the route name and derived key without stored profile facts', async () => {
    const ctx = context()
    ctx.provide('llm', llm({ providers: [{ id: 'acme', name: 'Acme' }], configurable: [directory] }) as never)
    const snapshot = await readAccountSnapshot(ctx, 'acme', signal())
    expect(snapshot).toMatchObject({ name: 'Acme', kind: 'other', key: { ref: 'ACME_API_KEY', configured: false } })
    expect(snapshot.endpoint).toBeUndefined()
    expect(snapshot.models).toBeUndefined()
  })

  it('treats a missing descriptor, a failing describe, and a throw from describe as unconfigured', async () => {
    const withoutDescriptor = context()
    withoutDescriptor.provide('llm', llm({ configurable: [directory] }) as never)
    withoutDescriptor.provide('settings', { describe: () => [] } as never)
    expect((await readAccountSnapshot(withoutDescriptor, 'acme', signal())).key).toEqual({ ref: 'ACME_API_KEY', configured: false })

    const failing = context()
    failing.provide('llm', llm({ configurable: [directory] }) as never)
    failing.provide('credentials', { describe: async () => { throw new Error('locked') } } as never)
    expect((await readAccountSnapshot(failing, 'acme', signal())).key).toEqual({ ref: 'ACME_API_KEY', configured: false })

    const emptyPathProfile = context()
    emptyPathProfile.provide('llm', llm({ configurable: [{ ...directory, settingsPath: [] }] }) as never)
    emptyPathProfile.provide('settings', settings({ baseURL: 'https://root.example' }) as never)
    emptyPathProfile.provide('credentials', { describe: async () => ({ configured: true }) } as never)
    expect(await readAccountSnapshot(emptyPathProfile, 'acme', signal())).toMatchObject({
      name: 'acme', endpoint: 'https://root.example', key: { ref: 'ACME_API_KEY', configured: true },
    })
  })

  it('does not take the account path without the native account service', async () => {
    const ctx = context()
    ctx.provide('llm', llm({ configurable: [ACCOUNT_ROUTE] }) as never)
    const snapshot = await readAccountSnapshot(ctx, 'deepseek-account', signal())
    expect(snapshot.kind).toBe('other')
    expect(snapshot.signedIn).toBeUndefined()
  })
})
