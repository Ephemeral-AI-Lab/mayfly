/**
 * What the Account tab of `/stats` knows about the provider of the current model: its route, its key or sign-in, and
 * (for DeepSeek) the balance. A DeepSeek account route reads the Platform profile and wallets through the Harness
 * account service; the official API-key route asks DeepSeek's own `GET /user/balance` with the stored key, sent only to
 * the route's endpoint; any other provider has facts and no balance. Read-only: nothing here writes, signs in or
 * out, and a failed read never touches the conversation.
 *
 * @module @ephemeral-ai/mayfly/interaction/stats-account
 */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import type {} from '@deepseek-ai/dsh-llm'
import { accountRoute, clientMetadata } from './provider-account.ts'
import { deriveKeyRef } from './provider-profile.ts'
import { providerAddress, providerDescriptor, providerProfileAt, providerValueAt } from './provider-store.ts'

export type WalletCurrency = 'CNY' | 'USD'

/** One currency of the balance; amounts are the decimal strings the server sent. */
export interface Wallet {
  readonly currency: WalletCurrency
  readonly total: string
  readonly toppedUp?: string | undefined
  readonly granted?: string | undefined
}

/** Why a balance could not be read. */
export type UnavailableReason = 'network' | 'rejected' | 'no-key' | 'signed-out'

export type BalanceResult =
  | { readonly status: 'ready', readonly wallets: readonly Wallet[], readonly available: boolean | undefined }
  | { readonly status: 'unavailable', readonly reason: UnavailableReason }

export type ProviderKind = 'account' | 'api-key' | 'other'

/** The provider of the current model, as the tab shows it. */
export interface AccountSnapshot {
  readonly route: string
  readonly name: string
  readonly kind: ProviderKind
  readonly endpoint?: string | undefined
  readonly models?: number | undefined
  readonly key?: { readonly ref: string, readonly configured: boolean } | undefined
  /** Account route: whether a Platform login is stored. */
  readonly signedIn?: boolean | undefined
  readonly profile?: { readonly name: string | null, readonly contact: string | null } | undefined
  readonly links?: { readonly topUp: string, readonly usage: string } | undefined
  /** Absent for a provider without a balance source. */
  readonly balance?: BalanceResult | undefined
  /** When the read finished. */
  readonly at: number
}

/** The DeepSeek API key reference and its official route. */
const DEEPSEEK_KEY = 'DEEPSEEK_API_KEY'
const DEEPSEEK_ROUTE = 'deepseek-official'
const DEFAULT_ENDPOINT = 'https://api.deepseek.com'
const DEFAULT_LINKS = { topUp: 'https://platform.deepseek.com/top_up', usage: 'https://platform.deepseek.com/usage' } as const
const BALANCE_TIMEOUT_MS = 8000

/** Process seam for specs: the one network call of the tab. */
export const balanceInternals = {
  /** GET one JSON document with a bearer key; the status tells a rejected key from a failing service. */
  fetchBalance: async (url: string, key: string, signal: AbortSignal): Promise<{ readonly status: number, readonly body: unknown }> => {
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(BALANCE_TIMEOUT_MS)]), headers: { accept: 'application/json', authorization: `Bearer ${key}` }, redirect: 'error' })
    const body: unknown = response.ok ? await response.json() : undefined
    return { status: response.status, body }
  },
}

const decimal = /^\d+(?:\.\d+)?$/u
const isDecimal = (value: unknown): value is string => typeof value === 'string' && decimal.test(value)
const isCurrency = (value: unknown): value is WalletCurrency => value === 'CNY' || value === 'USD'

/** Add two non-negative decimal strings without losing precision. */
export function addDecimal(left: string, right: string): string {
  const [leftWhole = '0', leftFraction = ''] = left.split('.')
  const [rightWhole = '0', rightFraction = ''] = right.split('.')
  const scale = Math.max(leftFraction.length, rightFraction.length)
  const total = BigInt(leftWhole + leftFraction.padEnd(scale, '0')) + BigInt(rightWhole + rightFraction.padEnd(scale, '0'))
  if (scale === 0) return String(total)
  const digits = String(total).padStart(scale + 1, '0')
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`
}

/** DeepSeek's `/user/balance` answer as wallets, or undefined when its shape is not the documented one. */
export function parseBalance(body: unknown): { readonly wallets: readonly Wallet[], readonly available: boolean | undefined } | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const { is_available: available, balance_infos: infos } = body as { is_available?: unknown, balance_infos?: unknown }
  if (!Array.isArray(infos)) return undefined
  const wallets: Wallet[] = []
  for (const info of infos as unknown[]) {
    if (info === null || typeof info !== 'object') return undefined
    const { currency, total_balance: total, granted_balance: granted, topped_up_balance: toppedUp } = info as Record<string, unknown>
    if (!isCurrency(currency) || !isDecimal(total)) return undefined
    wallets.push({ currency, total, ...isDecimal(toppedUp) ? { toppedUp } : {}, ...isDecimal(granted) ? { granted } : {} })
  }
  return { wallets, available: typeof available === 'boolean' ? available : undefined }
}

/** Whether the balance is low: nothing available, or every currency under its threshold. */
export function isLowBalance(balance: BalanceResult | undefined, thresholds: Readonly<Record<WalletCurrency, number>>): boolean {
  if (balance?.status !== 'ready') return false
  if (balance.available === false) return true
  return balance.wallets.length > 0 && balance.wallets.every(wallet => Number(wallet.total) < thresholds[wallet.currency])
}

/** The endpoint of the official route: its native profile, then `$DEEPSEEK_BASE_URL`, then the public API. */
function officialEndpoint(ctx: Context): string {
  const address = providerAddress(ctx, DEEPSEEK_ROUTE)
  const settings = ctx.get('settings')
  const descriptor = address === undefined || settings === undefined ? undefined : providerDescriptor(settings, address.ns)
  const configured = descriptor === undefined || address === undefined ? undefined : providerValueAt(descriptor.value, [...address.path, 'baseURL'])
  if (typeof configured === 'string' && configured !== '') return configured
  const environment = process.env.DEEPSEEK_BASE_URL
  return environment !== undefined && environment !== '' ? environment : DEFAULT_ENDPOINT
}

async function apiKeyBalance(ctx: Context, signal: AbortSignal): Promise<BalanceResult> {
  const credential = await ctx.get('credentials')?.resolve(credentialRef(DEEPSEEK_KEY)).catch(() => undefined)
  if (credential === undefined) return { status: 'unavailable', reason: 'no-key' }
  try {
    const { status, body } = await balanceInternals.fetchBalance(new URL('/user/balance', officialEndpoint(ctx)).href, credential.value, signal)
    if (status === 401 || status === 403) return { status: 'unavailable', reason: 'rejected' }
    const parsed = status === 200 ? parseBalance(body) : undefined
    return parsed === undefined ? { status: 'unavailable', reason: 'network' } : { status: 'ready', ...parsed }
  } catch {
    return { status: 'unavailable', reason: 'network' }
  }
}

async function platformBalance(ctx: Context): Promise<{ readonly balance: BalanceResult, readonly profile: AccountSnapshot['profile'] }> {
  const service = ctx.get('deepseekAccount')!
  const client = clientMetadata(ctx)
  const [profile, balance] = await Promise.all([service.getProfile(client).catch(() => null), service.getBalance(client).catch(() => null)])
  const shown = profile?.status === 'ready' ? { name: profile.value.name, contact: profile.value.contact } : undefined
  if (balance === null || balance.status !== 'ready') return { balance: { status: 'unavailable', reason: 'network' }, profile: shown }
  const currencies = [...new Set([...balance.value, ...balance.bonusWallets].map(wallet => wallet.currency))]
  const wallets = currencies.map((currency): Wallet => {
    const toppedUp = balance.value.find(wallet => wallet.currency === currency)?.balance
    const granted = balance.bonusWallets.find(wallet => wallet.currency === currency)?.balance
    return { currency, total: addDecimal(toppedUp ?? '0', granted ?? '0'), ...toppedUp === undefined ? {} : { toppedUp }, ...granted === undefined ? {} : { granted } }
  })
  return { balance: { status: 'ready', wallets, available: undefined }, profile: shown }
}

/**
 * Read the provider of one route.
 * @param ctx - the command's context.
 * @param route - the provider route of the current model.
 * @param signal - aborts the read (panel closed, route changed, unload).
 * @returns what the tab shows.
 */
export async function readAccountSnapshot(ctx: Context, route: string, signal: AbortSignal): Promise<AccountSnapshot> {
  const llm = ctx.get('llm')
  const name = llm?.listProviders().find(provider => provider.id === route)?.name || route
  const account = accountRoute(ctx)
  const service = ctx.get('deepseekAccount')
  const state = service === undefined ? undefined : await service.getState().catch(() => undefined)
  const links = state === undefined ? DEFAULT_LINKS : { topUp: state.links.topUpUrl, usage: state.links.usageUrl }
  if (route === account && service !== undefined) {
    const signedIn = state?.status === 'credential-stored'
    if (!signedIn) return { route, name, kind: 'account', signedIn, links, balance: { status: 'unavailable', reason: 'signed-out' }, at: Date.now() }
    const { balance, profile } = await platformBalance(ctx)
    return { route, name, kind: 'account', signedIn, ...profile === undefined ? {} : { profile }, links, balance, at: Date.now() }
  }
  if (route === DEEPSEEK_ROUTE) {
    const info = await ctx.get('credentials')?.describe(credentialRef(DEEPSEEK_KEY)).catch(() => undefined)
    const key = { ref: DEEPSEEK_KEY, configured: info?.configured === true }
    return { route, name, kind: 'api-key', key, links, balance: key.configured ? await apiKeyBalance(ctx, signal) : { status: 'unavailable', reason: 'no-key' }, at: Date.now() }
  }
  const address = providerAddress(ctx, route)
  const settings = ctx.get('settings')
  const descriptor = address === undefined || settings === undefined ? undefined : providerDescriptor(settings, address.ns)
  const profile = descriptor === undefined || address === undefined ? undefined : providerProfileAt(descriptor.value, address.path)
  const ref = profile?.apiKeyEnv ?? deriveKeyRef(route)
  const info = await ctx.get('credentials')?.describe(credentialRef(ref)).catch(() => undefined)
  return {
    route, name: profile?.displayName ?? name, kind: 'other',
    ...profile?.baseURL === undefined ? {} : { endpoint: profile.baseURL },
    ...profile?.models === undefined ? {} : { models: profile.models.length },
    key: { ref, configured: info?.configured === true }, at: Date.now(),
  }
}
