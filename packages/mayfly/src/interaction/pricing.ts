/**
 * Token prices for the `/stats` money figures, pure. A model's price comes from the first source that has one: a price the
 * user wrote in the `mayfly.prices` setting, the official DeepSeek table below (USD and CNY, half price off-peak), then
 * the models.dev list price (USD). The money is computed when a panel is drawn from token buckets kept per model and
 * per peak/off-peak request, never stored, so a locale switch only changes the currency it is shown in.
 *
 * @module @ephemeral-ai/mayfly/interaction/pricing
 */
import type { ModelsDevCost } from './models-dev.ts'
import type { TokenBuckets } from './usage.ts'

export type Currency = 'USD' | 'CNY'

/** One price list, in `currency` per million tokens. */
interface PriceList {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

/** What a user wrote for one model in the `mayfly.prices` setting. */
export interface UserPrice {
  readonly input: number
  readonly output: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
  readonly currency: Currency
}

/** Where a price came from. */
export type PriceSource = 'user' | 'deepseek' | 'models.dev'

/** A price in the currency a panel shows; `approx` when it was converted at the configured rate. */
export interface Price extends PriceList {
  readonly source: PriceSource
  readonly approx: boolean
}

/** The date the official DeepSeek table below was read (api-docs.deepseek.com, USD and zh-cn pages). */
export const DEEPSEEK_PRICES_AS_OF = '2026-10-14'

/** Off-peak rates; a peak request pays twice. DeepSeek has no cache-write price. */
const DEEPSEEK_OFF_PEAK: Readonly<Record<'flash' | 'pro', Readonly<Record<Currency, PriceList>>>> = {
  flash: {
    USD: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
    CNY: { input: 1, output: 4, cacheRead: 0.02, cacheWrite: 0 },
  },
  pro: {
    USD: { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0 },
    CNY: { input: 4.5, output: 13.5, cacheRead: 0.15, cacheWrite: 0 },
  },
}

/** The names DeepSeek bills at each tier; the legacy Flash names are served and billed as Flash. */
const DEEPSEEK_TIERS: Readonly<Record<string, 'flash' | 'pro'>> = {
  'deepseek-flash': 'flash', 'deepseek-v4-flash': 'flash', 'deepseek-v4-flash-vision-exp': 'flash', 'deepseek-v4-pro': 'pro',
}

/** DeepSeek's peak hours: Monday to Friday, 09:00-12:00 and 14:00-18:00 Beijing time (a public holiday is not modelled, so it counts as peak). */
export function isDeepseekPeak(at: number): boolean {
  const beijing = new Date(at + 8 * 3_600_000)
  const day = beijing.getUTCDay()
  const hour = beijing.getUTCHours()
  return day >= 1 && day <= 5 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18))
}

/** The provider routes that bill at DeepSeek's own price list: the built-in official route and the pi-ai catalog's `deepseek`. */
const isDeepseekRoute = (provider: string): boolean => provider === 'deepseek-official' || provider === 'deepseek'

/** Whether a request at `at` is billed at DeepSeek's peak rate; other providers have no peak. */
export function isPeakRequest(provider: string, at: number): boolean {
  return isDeepseekRoute(provider) && isDeepseekPeak(at)
}

/** The price sources a panel consults. */
export interface PriceSources {
  readonly user: Readonly<Record<string, UserPrice>>
  readonly modelsDev?: { lookupCost(provider: string, id: string): ModelsDevCost | undefined } | undefined
  /** CNY per USD for a USD price shown in CNY (and the reverse). */
  readonly usdCnyRate: number
}

function convert(list: PriceList, from: Currency, to: Currency, rate: number): { list: PriceList, approx: boolean } {
  if (from === to) return { list, approx: false }
  const factor = from === 'USD' ? rate : 1 / rate
  return { list: { input: list.input * factor, output: list.output * factor, cacheRead: list.cacheRead * factor, cacheWrite: list.cacheWrite * factor }, approx: true }
}

/**
 * The price of one model in `currency`, or undefined when no source has one.
 * @param provider - the provider route id.
 * @param model - the model id.
 * @param peak - whether the request was billed at DeepSeek's peak rate.
 * @param currency - the currency the panel shows.
 * @param sources - the user prices, the catalog and the exchange rate.
 * @returns the price, or undefined.
 */
export function priceFor(provider: string, model: string, peak: boolean, currency: Currency, sources: PriceSources): Price | undefined {
  const user = sources.user[`${provider}/${model}`]
  if (user !== undefined) {
    const { list, approx } = convert({ input: user.input, output: user.output, cacheRead: user.cacheRead ?? user.input, cacheWrite: user.cacheWrite ?? user.input }, user.currency, currency, sources.usdCnyRate)
    return { ...list, source: 'user', approx }
  }
  const tier = isDeepseekRoute(provider) ? DEEPSEEK_TIERS[model.toLowerCase()] : undefined
  if (tier !== undefined) {
    const base = DEEPSEEK_OFF_PEAK[tier][currency]
    const k = peak ? 2 : 1
    return { input: base.input * k, output: base.output * k, cacheRead: base.cacheRead * k, cacheWrite: base.cacheWrite * k, source: 'deepseek', approx: false }
  }
  const cost = sources.modelsDev?.lookupCost(provider, model)
  if (cost === undefined) return undefined
  const { list, approx } = convert({ input: cost.input, output: cost.output, cacheRead: cost.cacheRead ?? cost.input, cacheWrite: cost.cacheWrite ?? cost.input }, 'USD', currency, sources.usdCnyRate)
  return { ...list, source: 'models.dev', approx }
}

/** The tokens of one model, split the way the price splits them. */
export interface ModelTokens {
  readonly provider: string
  readonly model: string
  /** Tokens of requests billed at DeepSeek's peak rate. */
  readonly peak: TokenBuckets
  readonly offPeak: TokenBuckets
}

/** What a set of tokens costs. */
export interface Money {
  readonly amount: number
  /** Some of it was converted at the configured rate or comes from the catalog. */
  readonly approx: boolean
  /** Some tokens belong to a model no source prices. */
  readonly unpriced: boolean
}

const cost = (buckets: TokenBuckets, price: PriceList): number =>
  (buckets.input * price.input + buckets.output * price.output + buckets.cacheRead * price.cacheRead + buckets.cacheWrite * price.cacheWrite) / 1_000_000

const empty = (buckets: TokenBuckets): boolean => buckets.input + buckets.output + buckets.cacheRead + buckets.cacheWrite === 0

/**
 * The money of the tokens of some models.
 * @param models - their tokens.
 * @param currency - the currency to show.
 * @param sources - the price sources.
 * @returns the amount over the priced models and whether any was left out.
 */
export function moneyOf(models: readonly ModelTokens[], currency: Currency, sources: PriceSources): Money {
  let amount = 0
  let approx = false
  let unpriced = false
  for (const tokens of models) {
    for (const peak of [false, true]) {
      const buckets = peak ? tokens.peak : tokens.offPeak
      if (empty(buckets)) continue
      const price = priceFor(tokens.provider, tokens.model, peak, currency, sources)
      if (price === undefined) { unpriced = true; continue }
      amount += cost(buckets, price)
      approx ||= price.approx || price.source !== 'deepseek'
    }
  }
  return { amount, approx, unpriced }
}

const SYMBOL: Readonly<Record<Currency, string>> = { USD: '$', CNY: '¥' }

/** `≈ ¥ 3.02`, `≈ $ 1,204`, `≈ ¥ < 0.01`; every figure is an estimate, so the mark stays. */
export function formatMoney(amount: number, currency: Currency): string {
  const symbol = SYMBOL[currency]
  if (!(amount > 0)) return `≈ ${symbol} 0.00`
  if (amount < 0.01) return `≈ ${symbol} < 0.01`
  if (amount >= 1000) return `≈ ${symbol} ${Math.round(amount).toLocaleString('en-US')}`
  return `≈ ${symbol} ${amount.toFixed(2)}`
}
