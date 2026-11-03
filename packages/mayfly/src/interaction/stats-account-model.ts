/** Readonly account and balance facts shared by Stats renderers. @module */
export type WalletCurrency = 'CNY' | 'USD'

/** Decimal amounts remain the strings provided by the balance source. */
export interface Wallet {
  readonly currency: WalletCurrency
  readonly total: string
  readonly toppedUp?: string | undefined
  readonly granted?: string | undefined
}

export type UnavailableReason = 'network' | 'rejected' | 'no-key' | 'signed-out'
export type BalanceResult =
  | { readonly status: 'ready', readonly wallets: readonly Wallet[], readonly available: boolean | undefined }
  | { readonly status: 'unavailable', readonly reason: UnavailableReason }
export type ProviderKind = 'account' | 'api-key' | 'other'

/** Public provider information; credential values are never included. */
export interface AccountSnapshot {
  readonly route: string
  readonly name: string
  readonly kind: ProviderKind
  readonly endpoint?: string | undefined
  readonly models?: number | undefined
  readonly key?: { readonly ref: string, readonly configured: boolean } | undefined
  readonly signedIn?: boolean | undefined
  readonly profile?: { readonly name: string | null, readonly contact: string | null } | undefined
  readonly links?: { readonly topUp: string, readonly usage: string } | undefined
  readonly balance?: BalanceResult | undefined
  readonly at: number
}

/** Nothing available, or every available wallet below its currency's threshold. */
export function isLowBalance(balance: BalanceResult | undefined, thresholds: Readonly<Record<WalletCurrency, number>>): boolean {
  if (balance?.status !== 'ready') return false
  if (balance.available === false) return true
  return balance.wallets.length > 0 && balance.wallets.every(wallet => Number(wallet.total) < thresholds[wallet.currency])
}

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

