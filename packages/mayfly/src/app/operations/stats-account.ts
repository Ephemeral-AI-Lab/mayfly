/** Readonly rc.2 account facts over native Remotes; credentials stay on Host. @module */
import { addDecimal, type AccountSnapshot, type BalanceResult, type Wallet } from '../../stats-presentation.ts'
import type { HostClient } from '../../client/types.ts'
import { mayflyHostRemote } from '../../hosts/host-mount.ts'
import { remoteValue } from '../features/official.ts'
import { deriveRemoteProviderKeyRef, remoteProviderAddress, remoteProviderProfileAt } from '../features/provider-profile.ts'

const LINKS = { topUp: 'https://platform.deepseek.com/top_up', usage: 'https://platform.deepseek.com/usage' }

/** Read the current route's public configuration and provider-owned wallet state. */
export async function remoteStatsAccount(client: HostClient, route: string, locale: string, version: string, signal: AbortSignal): Promise<AccountSnapshot> {
  signal.throwIfAborted()
  const [providers, configurable, settings, state] = await Promise.all([
    remoteValue(client.remote.llm.listProviders()),
    remoteValue(client.remote.llm.listConfigurableProviders()),
    remoteValue(client.remote.settings.describe()),
    remoteValue(client.remote.account.getState()).catch(() => undefined),
  ])
  signal.throwIfAborted()
  const name = providers.find(item => item.id === route)?.name || route
  const links = state === undefined ? LINKS : { topUp: state.links.topUpUrl, usage: state.links.usageUrl }
  if (route === 'deepseek-account' && configurable.some(item => item.provider === route)) {
    const signedIn = state?.status === 'credential-stored'
    if (!signedIn) return { route, name, kind: 'account', signedIn, links, balance: { status: 'unavailable', reason: 'signed-out' }, at: Date.now() }
    const metadata = { version, locale, timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 }
    const [profile, balance] = await Promise.all([
      remoteValue(client.remote.account.getProfile(metadata)).catch(() => undefined),
      remoteValue(client.remote.account.getBalance(metadata)).catch(() => undefined),
    ])
    signal.throwIfAborted()
    let result: BalanceResult = { status: 'unavailable', reason: 'network' }
    if (balance?.status === 'ready') {
      const currencies = [...new Set([...balance.value, ...balance.bonusWallets].map(wallet => wallet.currency))]
      const wallets = currencies.map((currency): Wallet => {
        const toppedUp = balance.value.find(wallet => wallet.currency === currency)?.balance
        const granted = balance.bonusWallets.find(wallet => wallet.currency === currency)?.balance
        return { currency, total: addDecimal(toppedUp ?? '0', granted ?? '0'), ...toppedUp === undefined ? {} : { toppedUp }, ...granted === undefined ? {} : { granted } }
      })
      result = { status: 'ready', wallets, available: undefined }
    }
    return { route, name, kind: 'account', signedIn, links, balance: result, ...profile?.status === 'ready' ? { profile: { name: profile.value.name, contact: profile.value.contact } } : {}, at: Date.now() }
  }
  const address = remoteProviderAddress(configurable, route)
  const descriptor = settings.namespaces.find(item => item.ns === address?.ns)
  const profile = descriptor === undefined || address === undefined ? undefined : remoteProviderProfileAt(descriptor.value, address.path)
  const official = route === 'deepseek-official'
  const ref = official ? 'DEEPSEEK_API_KEY' : profile?.apiKeyEnv ?? deriveRemoteProviderKeyRef(route)
  const credentials = await remoteValue(client.remote.credentials.describe([ref])).catch(() => undefined)
  signal.throwIfAborted()
  const key = { ref, configured: credentials?.[ref]?.configured === true }
  if (official) {
    const balance = key.configured ? await remoteValue(mayflyHostRemote(client).providerBalance(signal)) : { status: 'unavailable' as const, reason: 'no-key' as const }
    signal.throwIfAborted()
    return { route, name, kind: 'api-key', key, links, balance: balance.status === 'ready' ? { ...balance, available: balance.available } : balance, at: Date.now() }
  }
  return { route, name: profile?.displayName ?? name, kind: 'other', ...profile?.baseURL === undefined ? {} : { endpoint: profile.baseURL }, ...profile?.models === undefined ? {} : { models: profile.models.length }, key, at: Date.now() }
}
