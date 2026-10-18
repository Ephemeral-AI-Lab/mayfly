/** `/stats` money: DeepSeek's peak calendar and table, user and catalog
 * prices in either currency, token costs, and the money text.
 * @module @ephemeral-ai/mayfly/tests/interaction/pricing
 */
import { describe, expect, it } from 'vitest'
import type { ModelsDevCost } from '../../src/interaction/models-dev.ts'
import {
  DEEPSEEK_PRICES_AS_OF, formatMoney, isDeepseekPeak, isPeakRequest, moneyOf, priceFor,
  type ModelTokens, type PriceSources, type UserPrice,
} from '../../src/interaction/pricing.ts'
import type { TokenBuckets } from '../../src/interaction/usage.ts'

const buckets = (input = 0, output = 0, cacheRead = 0, cacheWrite = 0): TokenBuckets => ({ input, cacheRead, cacheWrite, output })
const empty = (): TokenBuckets => buckets()
const model = (provider: string, id: string, peak = empty(), offPeak = empty()): ModelTokens => ({ provider, model: id, peak, offPeak })
const sources = (overrides: Partial<PriceSources> = {}): PriceSources => ({ user: {}, usdCnyRate: 7.2, ...overrides })
const cost = (input: number, output: number, cacheRead?: number, cacheWrite?: number): ModelsDevCost => ({
  input, output, ...cacheRead === undefined ? {} : { cacheRead }, ...cacheWrite === undefined ? {} : { cacheWrite },
})
const user = (price: Partial<UserPrice> = {}): UserPrice => ({ input: 1, output: 2, currency: 'USD', ...price })

/** Beijing 09:00 on a Monday, the first peak hour of the week. */
const MONDAY_NINE = Date.UTC(2026, 9, 19, 1, 0)
const HOUR = 3_600_000

describe('isDeepseekPeak', () => {
  it('counts the two Beijing work-hour windows on weekdays', () => {
    expect(isDeepseekPeak(MONDAY_NINE)).toBe(true)
    expect(isDeepseekPeak(MONDAY_NINE + 3 * HOUR)).toBe(false) // 12:00 break
    expect(isDeepseekPeak(MONDAY_NINE + 5 * HOUR)).toBe(true) // 14:00
    expect(isDeepseekPeak(MONDAY_NINE + 9 * HOUR)).toBe(false) // 18:00
    expect(isDeepseekPeak(MONDAY_NINE - HOUR)).toBe(false) // 08:00
  })

  it('treats Saturday and Sunday as off-peak all day', () => {
    expect(isDeepseekPeak(Date.UTC(2026, 9, 24, 1, 0))).toBe(false)
    expect(isDeepseekPeak(Date.UTC(2026, 9, 25, 1, 0))).toBe(false)
  })

  it('bills only DeepSeek routes by that calendar', () => {
    expect(isPeakRequest('deepseek-official', MONDAY_NINE)).toBe(true)
    expect(isPeakRequest('deepseek', MONDAY_NINE)).toBe(true)
    expect(isPeakRequest('deepseek', MONDAY_NINE + 3 * HOUR)).toBe(false)
    expect(isPeakRequest('openrouter', MONDAY_NINE)).toBe(false)
  })
})

describe('priceFor', () => {
  it('uses a user price first, with its cache prices falling back to input', () => {
    const price = priceFor('acme', 'one', false, 'USD', sources({ user: { 'acme/one': user({ cacheRead: 0.5, cacheWrite: 0.25 }) } }))
    expect(price).toEqual({ input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25, source: 'user', approx: false })
    const fallback = priceFor('acme', 'one', true, 'USD', sources({ user: { 'acme/one': user() } }))
    expect(fallback).toMatchObject({ input: 1, output: 2, cacheRead: 1, cacheWrite: 1, source: 'user', approx: false })
  })

  it('converts a user price into the panel currency and marks it approximate', () => {
    const inCny = priceFor('acme', 'one', false, 'CNY', sources({ user: { 'acme/one': user({ input: 2, output: 4, cacheRead: 1, cacheWrite: 0.5, currency: 'USD' }) }, usdCnyRate: 7 }))
    expect(inCny).toMatchObject({ input: 14, output: 28, cacheRead: 7, cacheWrite: 3.5, source: 'user', approx: true })
    const inUsd = priceFor('acme', 'one', false, 'USD', sources({ user: { 'acme/one': user({ input: 7, output: 14, cacheRead: 7, cacheWrite: 7, currency: 'CNY' }) }, usdCnyRate: 7 }))
    expect(inUsd).toMatchObject({ input: 1, output: 2, cacheRead: 1, cacheWrite: 1, source: 'user', approx: true })
  })

  it('bills the DeepSeek table double during peak hours for known tiers', () => {
    expect(priceFor('deepseek-official', 'deepseek-v4-flash', false, 'USD', sources())).toEqual({
      input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0, source: 'deepseek', approx: false,
    })
    expect(priceFor('deepseek-official', 'deepseek-v4-flash', true, 'USD', sources())).toMatchObject({ input: 0.3, output: 1.2, cacheRead: 0.006 })
    expect(priceFor('deepseek', 'DeepSeek-V4-Pro', false, 'CNY', sources())).toMatchObject({ input: 4.5, output: 13.5, cacheRead: 0.15, source: 'deepseek' })
    expect(priceFor('deepseek-official', 'deepseek-flash', false, 'USD', sources())).toMatchObject({ input: 0.15, source: 'deepseek' })
  })

  it('uses the models.dev list price after the DeepSeek table and converts it', () => {
    const catalog = { lookupCost: (provider: string, id: string) => provider === 'acme' && id === 'one' ? cost(3, 6) : undefined }
    expect(priceFor('acme', 'one', false, 'USD', sources({ modelsDev: catalog }))).toEqual({
      input: 3, output: 6, cacheRead: 3, cacheWrite: 3, source: 'models.dev', approx: false,
    })
    expect(priceFor('acme', 'one', false, 'CNY', sources({ modelsDev: catalog, usdCnyRate: 7 }))).toMatchObject({
      input: 21, output: 42, cacheRead: 21, cacheWrite: 21, source: 'models.dev', approx: true,
    })
    expect(priceFor('acme', 'one', false, 'USD', sources({ modelsDev: { lookupCost: () => cost(1, 2, 0.1, 0.2) } }))).toMatchObject({ cacheRead: 0.1, cacheWrite: 0.2 })
  })

  it('answers undefined when no source prices the model or a DeepSeek tier is unknown', () => {
    expect(priceFor('acme', 'one', false, 'USD', sources())).toBeUndefined()
    expect(priceFor('deepseek-official', 'unknown-model', false, 'USD', sources())).toBeUndefined()
    expect(priceFor('deepseek-official', 'unknown-model', false, 'USD', sources({ modelsDev: { lookupCost: () => undefined } }))).toBeUndefined()
    expect(DEEPSEEK_PRICES_AS_OF).toBe('2026-10-14')
  })
})

describe('moneyOf', () => {
  it('skips empty buckets and prices each tier of a model', () => {
    const priced = moneyOf([model('deepseek-official', 'deepseek-v4-flash', buckets(1_000_000), buckets(2_000_000, 1_000_000))], 'USD', sources())
    // off-peak: 2M input * 0.15 + 1M output * 0.6; peak: 1M input * 0.3
    expect(priced.amount).toBeCloseTo(0.3 + 0.6 + 0.3, 10)
    expect(priced).toEqual({ amount: expect.closeTo(1.2, 10), approx: false, unpriced: false })
    expect(moneyOf([model('deepseek-official', 'deepseek-v4-flash')], 'USD', sources())).toEqual({ amount: 0, approx: false, unpriced: false })
  })

  it('marks user and catalog prices approximate and any unpriced tokens', () => {
    const priced = moneyOf([
      model('acme', 'one', empty(), buckets(1_000_000)),
      model('acme', 'missing', empty(), buckets(1_000_000)),
      model('deepseek-official', 'deepseek-v4-pro', buckets(1_000_000)),
    ], 'USD', sources({ user: { 'acme/one': user({ input: 1, output: 0 }) } }))
    expect(priced).toMatchObject({ approx: true, unpriced: true })
    expect(priced.amount).toBeCloseTo(2.32, 10)
    expect(moneyOf([model('acme', 'one', buckets(1))], 'USD', sources({ user: { 'acme/one': user({ input: 0, output: 0 }) } }))).toEqual({ amount: 0, approx: true, unpriced: false })
  })

  it('adds both tiers of several models', () => {
    const money = moneyOf([
      model('deepseek', 'deepseek-v4-flash', buckets(1_000_000), buckets(1_000_000)),
      model('deepseek', 'deepseek-v4-pro', buckets(0), buckets(1_000_000)),
    ], 'CNY', sources())
    expect(money.amount).toBeCloseTo(1 + 4.5 + 2, 10)
    expect(money).toMatchObject({ approx: false, unpriced: false })
  })
})

describe('formatMoney', () => {
  it('prints zero, a sub-cent amount, a normal amount, and a rounded thousand', () => {
    expect(formatMoney(0, 'USD')).toBe('≈ $ 0.00')
    expect(formatMoney(-1, 'CNY')).toBe('≈ ¥ 0.00')
    expect(formatMoney(0.004, 'USD')).toBe('≈ $ < 0.01')
    expect(formatMoney(0.01, 'USD')).toBe('≈ $ 0.01')
    expect(formatMoney(3.019, 'CNY')).toBe('≈ ¥ 3.02')
    expect(formatMoney(999.999, 'USD')).toBe('≈ $ 1000.00')
    expect(formatMoney(1000, 'USD')).toBe('≈ $ 1,000')
    expect(formatMoney(1234.56, 'CNY')).toBe('≈ ¥ 1,235')
  })
})
