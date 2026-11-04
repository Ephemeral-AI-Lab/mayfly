/** Official API-key balance lookup with credentials confined to Host. @module */
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import type { MayflyProviderBalance, MayflyWallet } from '../types.ts'
import { frozen } from './json.ts'

const DEFAULT_ENDPOINT = 'https://api.deepseek.com'
const BALANCE_TIMEOUT_MS = 8_000
const DECIMAL = /^\d+(?:\.\d+)?$/u

function isDecimal(value: unknown): value is string {
  return typeof value === 'string' && DECIMAL.test(value)
}

function officialEndpoint(ctx: Context): string {
  const descriptor = ctx.settings.describe({ redactSecrets: true }).find(entry => String(entry.ns) === 'llm-deepseek')
  if (descriptor !== undefined && typeof descriptor.value === 'object' && descriptor.value !== null && !Array.isArray(descriptor.value)) {
    const configured = Reflect.get(descriptor.value, 'baseURL')
    if (typeof configured === 'string' && configured !== '') return configured
  }
  const environment = process.env.DEEPSEEK_BASE_URL
  return environment !== undefined && environment !== '' ? environment : DEFAULT_ENDPOINT
}

function parseBalance(body: unknown): Extract<MayflyProviderBalance, { readonly status: 'ready' }> | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const { is_available: available, balance_infos: infos } = body as { is_available?: unknown, balance_infos?: unknown }
  if (!Array.isArray(infos)) return undefined
  const wallets: MayflyWallet[] = []
  for (const info of infos) {
    if (info === null || typeof info !== 'object') return undefined
    const { currency, total_balance: total, granted_balance: granted, topped_up_balance: toppedUp } = info as Record<string, unknown>
    if ((currency !== 'CNY' && currency !== 'USD') || !isDecimal(total)) return undefined
    wallets.push({
      currency,
      total,
      ...isDecimal(toppedUp) ? { toppedUp } : {},
      ...isDecimal(granted) ? { granted } : {},
    })
  }
  return { status: 'ready', wallets, ...typeof available === 'boolean' ? { available } : {} }
}

/** Query the official balance endpoint without exposing the credential or making it a client argument. */
export async function providerBalance(ctx: Context, signal: AbortSignal): Promise<MayflyProviderBalance> {
  signal.throwIfAborted()
  const credential = await ctx.credentials.resolve(credentialRef('DEEPSEEK_API_KEY')).catch(() => undefined)
  signal.throwIfAborted()
  if (credential === undefined) return frozen({ status: 'unavailable', reason: 'no-key' })
  try {
    const response = await fetch(new URL('/user/balance', officialEndpoint(ctx)), {
      signal: AbortSignal.any([signal, AbortSignal.timeout(BALANCE_TIMEOUT_MS)]),
      headers: { accept: 'application/json', authorization: `Bearer ${credential.value}` },
      redirect: 'error',
    })
    signal.throwIfAborted()
    if (response.status === 401 || response.status === 403) return frozen({ status: 'unavailable', reason: 'rejected' })
    const body: unknown = response.ok ? await response.json() : undefined
    signal.throwIfAborted()
    const parsed = response.status === 200 ? parseBalance(body) : undefined
    return frozen(parsed ?? { status: 'unavailable', reason: 'network' })
  } catch (error) {
    if (signal.aborted) throw error
    return frozen({ status: 'unavailable', reason: 'network' })
  }
}
