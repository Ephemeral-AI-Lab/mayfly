/** Readonly native provider account facts and precise decimal wallets. @module */
import { describe, expect, it, vi } from 'vitest'
import type { HostClient } from '../../src/client/types.ts'
import { remoteStatsAccount } from '../../src/remote/operations/stats-account.ts'
import { good, bad } from './task-feature-fixture.ts'

function fixture() {
  const profiles: Record<string, unknown> = { custom: { displayName: 'Custom', baseURL: 'https://example.test', models: [{ id: 'm' }], apiKeyEnv: 'CUSTOM_KEY' } }
  const providers = vi.fn(async (): Promise<unknown> => good([{ id: 'p', name: 'Provider' }]))
  const configurable = vi.fn(async (): Promise<unknown> => good([{ provider: 'custom', settingsNs: 'llm', settingsPath: ['custom'], displayName: 'Custom' }]))
  const settings = vi.fn(async (): Promise<unknown> => good({ namespaces: [{ ns: 'llm', value: profiles }] }))
  const state = vi.fn(async (): Promise<unknown> => good({ status: 'credential-stored', links: { topUpUrl: 'https://top.test', usageUrl: 'https://usage.test' } }))
  const profile = vi.fn(async (..._args: unknown[]): Promise<unknown> => good({ status: 'ready', value: { name: 'Name', contact: 'contact' } }))
  const balance = vi.fn(async (..._args: unknown[]): Promise<unknown> => good({ status: 'ready', value: [{ currency: 'CNY', balance: '0.10' }, { currency: 'USD', balance: '2' }], bonusWallets: [{ currency: 'CNY', balance: '0.20' }, { currency: 'USD', balance: '3' }] }))
  const credentials = vi.fn(async (..._args: unknown[]): Promise<unknown> => good({ DEEPSEEK_API_KEY: { configured: true }, CUSTOM_KEY: { configured: true } }))
  const apiBalance = vi.fn(async (..._args: unknown[]): Promise<unknown> => good({ status: 'ready', wallets: [{ currency: 'USD', total: '42' }], available: true }))
  const client = { remote: { llm: { listProviders: providers, listConfigurableProviders: configurable }, settings: { describe: settings }, credentials: { describe: credentials }, account: { getState: state, getProfile: profile, getBalance: balance }, mayflyHost: { providerBalance: apiBalance } } } as unknown as HostClient
  const signal = new AbortController().signal
  const read = (route = 'p', cancellation = signal) => remoteStatsAccount(client, route, 'en', '0.1.4-rc.2', cancellation)
  const account = () => { configurable.mockResolvedValue(good([{ provider: 'deepseek-account', settingsNs: 'account', settingsPath: [] }])); return read('deepseek-account') }
  return { client, providers, configurable, settings, state, profile, balance, credentials, apiBalance, profiles, read, account, signal }
}

describe('rc.2 statistics account snapshots', () => {
  it('reads native public provider settings and credential descriptions without resolving secrets', async () => {
    const f = fixture()
    expect(await f.read('custom')).toMatchObject({ route: 'custom', name: 'Custom', kind: 'other', endpoint: 'https://example.test', models: 1, key: { ref: 'CUSTOM_KEY', configured: true } })
    expect(f.credentials).toHaveBeenCalledWith(['CUSTOM_KEY'])
    expect(await f.read()).toMatchObject({ name: 'Provider', kind: 'other', key: { ref: 'P_API_KEY', configured: false } })
    expect(f.apiBalance).not.toHaveBeenCalled(); expect(f.profile).not.toHaveBeenCalled(); expect(f.balance).not.toHaveBeenCalled()
    f.profiles['custom'] = {}
    expect(await f.read('custom')).toMatchObject({ name: 'custom', key: { ref: 'CUSTOM_API_KEY' } })
    f.settings.mockResolvedValue(good({ namespaces: [] }))
    expect(await f.read('custom')).toMatchObject({ kind: 'other', name: 'custom' })
  })

  it('uses only the focused Host API-key balance and keeps wallet decimals untouched', async () => {
    const f = fixture()
    expect(await f.read('deepseek-official')).toMatchObject({ kind: 'api-key', key: { ref: 'DEEPSEEK_API_KEY', configured: true }, balance: { status: 'ready', wallets: [{ currency: 'USD', total: '42' }], available: true }, links: { topUp: 'https://top.test' } })
    expect(f.apiBalance).toHaveBeenCalledWith(f.signal)
    f.apiBalance.mockResolvedValueOnce(good({ status: 'unavailable', reason: 'network' }))
    expect(await f.read('deepseek-official')).toMatchObject({ balance: { status: 'unavailable', reason: 'network' } })
    f.credentials.mockResolvedValueOnce(good({ DEEPSEEK_API_KEY: { configured: false } }))
    expect(await f.read('deepseek-official')).toMatchObject({ balance: { status: 'unavailable', reason: 'no-key' } })
    f.credentials.mockResolvedValueOnce(bad('credential source unavailable'))
    expect(await f.read('deepseek-official')).toMatchObject({ key: { configured: false } })
  })

  it('uses published fallback links and provider route identity when optional metadata is absent', async () => {
    const f = fixture(); f.state.mockResolvedValue(bad('account unavailable'))
    f.providers.mockResolvedValue(good([{ id: 'deepseek-official', name: '' }]))
    const snapshot = await f.read('deepseek-official')
    expect(snapshot.name).toBe('deepseek-official')
    expect(snapshot.links).toEqual({ topUp: 'https://platform.deepseek.com/top_up', usage: 'https://platform.deepseek.com/usage' })
    expect(await f.read('deepseek-account')).toMatchObject({ kind: 'other' })
  })

  it('combines signed-in native platform wallets exactly and forwards client metadata', async () => {
    const f = fixture()
    expect(await f.account()).toMatchObject({ kind: 'account', signedIn: true, profile: { name: 'Name', contact: 'contact' }, balance: { status: 'ready', available: undefined, wallets: [
      { currency: 'CNY', total: '0.30', toppedUp: '0.10', granted: '0.20' }, { currency: 'USD', total: '5', toppedUp: '2', granted: '3' },
    ] } })
    expect(f.balance).toHaveBeenCalledWith(expect.objectContaining({ version: '0.1.4-rc.2', locale: 'en', timezoneOffsetSeconds: expect.any(Number) }))
    expect(f.apiBalance).not.toHaveBeenCalled(); expect(f.credentials).not.toHaveBeenCalled()
    f.balance.mockResolvedValueOnce(good({ status: 'ready', value: [{ currency: 'CNY', balance: '1' }], bonusWallets: [{ currency: 'USD', balance: '2' }] }))
    expect((await f.account()).balance).toMatchObject({ wallets: [{ currency: 'CNY', total: '1', toppedUp: '1' }, { currency: 'USD', total: '2', granted: '2' }] })
  })

  it('distinguishes signed-out native accounts and failed platform observations without mutation', async () => {
    const f = fixture(); f.state.mockResolvedValueOnce(good({ status: 'signed-out', links: { topUpUrl: 'top', usageUrl: 'usage' } }))
    expect(await f.account()).toMatchObject({ kind: 'account', signedIn: false, balance: { status: 'unavailable', reason: 'signed-out' } })
    expect(f.profile).not.toHaveBeenCalled()
    f.profile.mockResolvedValueOnce(bad('offline')); f.balance.mockResolvedValueOnce(bad('offline'))
    expect(await f.account()).toMatchObject({ balance: { status: 'unavailable', reason: 'network' } })
    f.profile.mockResolvedValueOnce(good({ status: 'unavailable' })); f.balance.mockResolvedValueOnce(good({ status: 'unavailable' }))
    expect(await f.account()).not.toHaveProperty('profile')
    f.state.mockResolvedValueOnce(bad('offline'))
    expect(await f.account()).toMatchObject({ signedIn: false })
  })

  it('rejects cancelled and late native directory, wallet, credential and API balance results', async () => {
    const f = fixture()
    await expect(f.read('p', AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' }); expect(f.providers).not.toHaveBeenCalled()
    for (const step of ['providers', 'credentials', 'apiBalance', 'balance'] as const) {
      const test = fixture(); const stop = new AbortController(); const seam = test[step]
      const original = seam.getMockImplementation()!
      seam.mockImplementationOnce(async (...args: unknown[]) => { const result = await original(...args); stop.abort(); return result })
      if (step === 'balance') test.configurable.mockResolvedValue(good([{ provider: 'deepseek-account', settingsNs: 'account', settingsPath: [] }]))
      await expect(test.read(step === 'balance' ? 'deepseek-account' : step === 'apiBalance' ? 'deepseek-official' : 'p', stop.signal)).rejects.toMatchObject({ name: 'AbortError' })
    }
  })
})
