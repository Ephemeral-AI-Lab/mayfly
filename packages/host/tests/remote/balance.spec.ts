/**
 * Decision tests for the balance lookup: credential confinement, endpoint
 * precedence, and the refusal to guess a wallet shape.
 * @module
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { providerBalance } from '../../src/remote/balance.ts'

/** A context answering one credential and an optional llm-deepseek namespace. */
/** One credential resolution: absent rejects, present answers its value. */
async function resolveCredential(credential: string | undefined): Promise<{ value: string }> {
  if (credential === undefined) throw new Error('no key')
  return { value: credential }
}

function ctx(credential: string | undefined, settingsValue?: object): Context {
  const entries: readonly object[] = settingsValue === undefined
    ? []
    : [{ ns: 'llm-deepseek', value: settingsValue }]
  return {
    credentials: { resolve: (): Promise<{ value: string }> => resolveCredential(credential) },
    settings: { describe: (): readonly object[] => entries },
  } as unknown as Context
}

/** One successful fetch response shape. */
interface StubResponse {
  readonly ok: boolean
  readonly status: number
  json(): Promise<unknown>
}

/** Stub global fetch and record the request it saw. */
function fetchAnswer(body: unknown, status = 200): { seen: () => RequestInit | undefined, url: () => string | undefined } {
  let init: RequestInit | undefined
  let seenUrl: string | undefined
  const respond = (): StubResponse => ({ ok: status >= 200 && status < 300, status, json: async () => body })
  vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, requestInit?: RequestInit): Promise<StubResponse> => {
    seenUrl = String(request)
    init = requestInit
    return respond()
  }))
  return { seen: () => init, url: (): string | undefined => seenUrl }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('providerBalance', () => {
  it('answers unavailable without ever fetching when no credential resolves', async () => {
    const { seen } = fetchAnswer({})
    const balance = await providerBalance(ctx(undefined), new AbortController().signal)
    expect(balance).toEqual({ status: 'unavailable', reason: 'no-key' })
    expect(seen()).toBeUndefined()
  })

  it('sends the credential as a bearer header to the official endpoint', async () => {
    const { seen, url } = fetchAnswer({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '42.50' }] })
    const balance = await providerBalance(ctx('sk-secret'), new AbortController().signal)
    expect(balance).toMatchObject({ status: 'ready', available: true, wallets: [{ currency: 'CNY', total: '42.50' }] })
    expect(url()).toContain('https://api.deepseek.com/user/balance')
    expect((seen()?.headers as Record<string, string>).authorization).toBe('Bearer sk-secret')
  })

  it('prefers the configured base URL, then the environment, then the default', async () => {
    const configured = fetchAnswer({ balance_infos: [] })
    await providerBalance(ctx('sk', { baseURL: 'https://proxy.internal' }), new AbortController().signal)
    expect(configured.url()).toContain('https://proxy.internal/user/balance')

    process.env.DEEPSEEK_BASE_URL = 'https://env.example'
    try {
      const fromEnv = fetchAnswer({ balance_infos: [] })
      await providerBalance(ctx('sk'), new AbortController().signal)
      expect(fromEnv.url()).toContain('https://env.example/user/balance')
    } finally {
      delete process.env.DEEPSEEK_BASE_URL
    }
  })

  it('reports rejected credentials and network failures as unavailable, never guessing a wallet', async () => {
    fetchAnswer({}, 401)
    expect(await providerBalance(ctx('sk-bad'), new AbortController().signal)).toEqual({ status: 'unavailable', reason: 'rejected' })
    vi.stubGlobal('fetch', vi.fn(async (): Promise<never> => { throw new Error('socket down') }))
    expect(await providerBalance(ctx('sk'), new AbortController().signal)).toEqual({ status: 'unavailable', reason: 'network' })
  })

  it('refuses a malformed document rather than inventing wallets', async () => {
    fetchAnswer({ balance_infos: 'not an array' })
    expect(await providerBalance(ctx('sk'), new AbortController().signal)).toEqual({ status: 'unavailable', reason: 'network' })
    fetchAnswer({ balance_infos: [{ currency: 'EUR', total_balance: '1.00' }] })
    expect(await providerBalance(ctx('sk'), new AbortController().signal)).toEqual({ status: 'unavailable', reason: 'network' })
    // A non-decimal balance is equally unusable.
    fetchAnswer({ balance_infos: [{ currency: 'CNY', total_balance: 'many' }] })
    expect(await providerBalance(ctx('sk'), new AbortController().signal)).toEqual({ status: 'unavailable', reason: 'network' })
  })

  it('keeps only the decimal wallet fields the document carries', async () => {
    fetchAnswer({ balance_infos: [{ currency: 'USD', total_balance: '9.00', granted_balance: '4.00' }] })
    const balance = await providerBalance(ctx('sk'), new AbortController().signal)
    expect(balance).toMatchObject({ wallets: [{ currency: 'USD', total: '9.00', granted: '4.00' }] })
    expect((balance as unknown as { wallets: object[] }).wallets[0]).not.toHaveProperty('toppedUp')
  })
})
