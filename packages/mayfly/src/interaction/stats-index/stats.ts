/**
 * The figures of `/stats` History and Models from session digests, pure: the range window, the activity grid with its
 * levels, the streaks, the per-model totals, and the tokens-per-day series. Days are local calendar days.
 *
 * @module @ephemeral-ai/mayfly/interaction/stats-index/stats
 */
import type { ModelTokens } from '../pricing.ts'
import type { TokenBuckets } from '../usage.ts'
import { addBuckets, dayKey, emptyBuckets, type MutableBuckets, type SessionDigest } from './digest.ts'

export const RANGES = ['all', '7d', '30d'] as const
export type StatsRange = typeof RANGES[number]

/** The tokens of a model over a range, split for pricing, with their sum. */
export interface ModelTotals extends ModelTokens {
  readonly total: number
  readonly buckets: TokenBuckets
}

/** One model's tokens of one day, in the two price tiers. */
export interface DayTokens {
  readonly peak: MutableBuckets
  readonly offPeak: MutableBuckets
}

/** Everything History and Models show for one range. */
export interface StatsAggregate {
  readonly sessions: number
  readonly activeDays: number
  /** The days the range spans: 7, 30, or first active day to today. */
  readonly rangeDays: number
  readonly mostActiveDay: { readonly key: string, readonly turns: number } | undefined
  readonly longestSessionMs: number
  readonly longestStreak: number
  readonly currentStreak: number
  /** Turns per day inside the range. */
  readonly dayTurns: ReadonlyMap<string, number>
  /** The tokens of every day and model inside the range, by `provider\0model` then `yyyy-mm-dd`, split for pricing. */
  readonly daily: ReadonlyMap<string, ReadonlyMap<string, DayTokens>>
  /** Models by tokens, largest first. */
  readonly models: readonly ModelTotals[]
  readonly buckets: TokenBuckets
}

const DAY_MS = 86_400_000

/** The local day `offset` days from `now`'s. */
export function dayOffset(now: number, offset: number): string {
  const date = new Date(now)
  date.setDate(date.getDate() + offset)
  return dayKey(date.getTime())
}

/** Whole days since 1970 of a `yyyy-mm-dd`, DST-proof. */
function dayNumber(key: string): number {
  const [year, month, day] = key.split('-').map(Number) as [number, number, number]
  return Math.round(Date.UTC(year, month - 1, day) / DAY_MS)
}

/** The first day of a range's window (undefined: no lower bound). */
export function rangeStart(range: StatsRange, now: number): string | undefined {
  return range === '7d' ? dayOffset(now, -6) : range === '30d' ? dayOffset(now, -29) : undefined
}

const sum = (buckets: TokenBuckets): number => buckets.input + buckets.cacheRead + buckets.cacheWrite + buckets.output

/**
 * Fold digests into the figures of one range.
 * @param digests - the sessions to count.
 * @param range - the window.
 * @param now - the time that ends it.
 * @returns the aggregate.
 */
export function aggregate(digests: readonly SessionDigest[], range: StatsRange, now: number): StatsAggregate {
  const start = rangeStart(range, now)
  const today = dayKey(now)
  const dayTurns = new Map<string, number>()
  const daily = new Map<string, Map<string, DayTokens>>()
  const models = new Map<string, { provider: string, model: string, peak: MutableBuckets, offPeak: MutableBuckets }>()
  const total = emptyBuckets()
  let sessions = 0
  let longestSessionMs = 0
  let earliest = today
  for (const digest of digests) {
    let counted = false
    for (const [key, day] of digest.days) {
      if ((start !== undefined && key < start) || key > today) continue
      counted = true
      if (key < earliest) earliest = key
      if (day.turns > 0) dayTurns.set(key, (dayTurns.get(key) ?? 0) + day.turns)
      for (const [modelKey, tokens] of day.models) {
        let entry = models.get(modelKey)
        if (entry === undefined) { entry = { provider: tokens.provider, model: tokens.model, peak: emptyBuckets(), offPeak: emptyBuckets() }; models.set(modelKey, entry) }
        addBuckets(entry.peak, tokens.peak)
        addBuckets(entry.offPeak, tokens.offPeak)
        addBuckets(total, tokens.peak)
        addBuckets(total, tokens.offPeak)
        const perDay = daily.get(modelKey) ?? new Map<string, DayTokens>()
        let slot = perDay.get(key)
        if (slot === undefined) { slot = { peak: emptyBuckets(), offPeak: emptyBuckets() }; perDay.set(key, slot) }
        addBuckets(slot.peak, tokens.peak)
        addBuckets(slot.offPeak, tokens.offPeak)
        daily.set(modelKey, perDay)
      }
    }
    if (!counted) continue
    sessions += 1
    longestSessionMs = Math.max(longestSessionMs, digest.lastAt - digest.firstAt)
  }
  // Active days are the days with a turn; the streaks count consecutive ones.
  const active = [...dayTurns.keys()].sort()
  let longestStreak = 0
  let run = 0
  let previous = Number.NaN
  for (const key of active) {
    const number = dayNumber(key)
    run = number - previous === 1 ? run + 1 : 1
    previous = number
    longestStreak = Math.max(longestStreak, run)
  }
  // The current streak runs back from today, or from yesterday while today has no turn yet.
  let currentStreak = 0
  const lastActive = dayTurns.has(today) ? today : dayOffset(now, -1)
  for (let number = dayNumber(lastActive); dayTurns.has(new Date(number * DAY_MS).toISOString().slice(0, 10)); number -= 1) currentStreak += 1
  let most: { key: string, turns: number } | undefined
  for (const [key, turns] of dayTurns) if (most === undefined || turns > most.turns || (turns === most.turns && key > most.key)) most = { key, turns }
  const rangeDays = range === '7d' ? 7 : range === '30d' ? 30 : Math.max(1, dayNumber(today) - dayNumber(earliest) + 1)
  const totals: ModelTotals[] = [...models.values()].map(entry => ({
    provider: entry.provider, model: entry.model, peak: entry.peak, offPeak: entry.offPeak,
    total: sum(entry.peak) + sum(entry.offPeak),
    buckets: { input: entry.peak.input + entry.offPeak.input, cacheRead: entry.peak.cacheRead + entry.offPeak.cacheRead, cacheWrite: entry.peak.cacheWrite + entry.offPeak.cacheWrite, output: entry.peak.output + entry.offPeak.output },
  })).sort((a, b) => b.total - a.total || a.model.localeCompare(b.model))
  return { sessions, activeDays: active.length, rangeDays, mostActiveDay: most, longestSessionMs, longestStreak, currentStreak, dayTurns, daily, models: totals, buckets: total }
}

/** The activity grid: levels 0 to 4 per day, Sunday first, a day after today is null. */
export interface HeatmapGrid {
  readonly weeks: number
  /** One month name per week column, empty where the month did not change. */
  readonly monthLabels: readonly string[]
  /** Seven rows (Sunday to Saturday) of `weeks` levels. */
  readonly levels: readonly (readonly (number | null)[])[]
}

/**
 * The last `weeks` weeks of activity as levels: none, then one to four by the share of the busiest day of the range.
 * @param dayTurns - turns per day.
 * @param weeks - the columns to draw; the last holds today.
 * @param now - today.
 * @param monthName - the short name of a month (0 to 11) in the UI language.
 * @returns the grid.
 */
export function heatmapGrid(dayTurns: ReadonlyMap<string, number>, weeks: number, now: number, monthName: (month: number) => string): HeatmapGrid {
  const today = new Date(now)
  const lastSunday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - today.getDay())
  const busiest = Math.max(1, ...dayTurns.values())
  const levels: (number | null)[][] = Array.from({ length: 7 }, () => [])
  const months: number[] = []
  for (let column = 0; column < weeks; column += 1) {
    const sunday = new Date(lastSunday.getFullYear(), lastSunday.getMonth(), lastSunday.getDate() - (weeks - 1 - column) * 7)
    months.push(sunday.getMonth())
    for (let row = 0; row < 7; row += 1) {
      const date = new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate() + row)
      if (date.getTime() > now && dayKey(date.getTime()) !== dayKey(now)) { levels[row]!.push(null); continue }
      const turns = dayTurns.get(dayKey(date.getTime())) ?? 0
      levels[row]!.push(turns <= 0 ? 0 : Math.max(1, Math.min(4, Math.ceil(4 * turns / busiest))))
    }
  }
  // A label sits where the month changes; the first column is named only when the next name is far enough not to overwrite it.
  const labels = months.map((month, column) => column > 0 && month !== months[column - 1] ? monthName(month) : '')
  const firstChange = labels.findIndex(label => label !== '')
  if (firstChange === -1 || firstChange >= 4) labels[0] = monthName(months[0] ?? 0)
  return { weeks, monthLabels: labels, levels }
}

/** One drawn line of a per-day chart. */
export interface DailySeries {
  readonly id: string
  readonly provider: string | undefined
  readonly model: string | undefined
  readonly points: readonly number[]
}

/** A per-day chart: one value per model per step, `days` naming each step's first day. */
export interface DailyChart {
  readonly days: readonly string[]
  readonly series: readonly DailySeries[]
}

const MAX_STEPS = 40
const MAX_LINES = 4

/**
 * A per-day measure of each model over the range (tokens, money), in at most 40 steps and the four busiest models (the
 * rest are one `other` line).
 * @param aggregated - the range's figures.
 * @param now - today.
 * @param measure - the value of one model's tokens of one day.
 * @returns the chart's data.
 */
export function dailyChart(aggregated: StatsAggregate, now: number, measure: (model: ModelTotals, day: DayTokens) => number): DailyChart {
  const last = dayNumber(dayKey(now))
  const first = last - aggregated.rangeDays + 1
  const span = last - first + 1
  const step = Math.max(1, Math.ceil(span / MAX_STEPS))
  const steps = Math.ceil(span / step)
  const dayAt = (index: number): string => new Date((first + index * step) * DAY_MS).toISOString().slice(0, 10)
  const days = Array.from({ length: steps }, (_unused, index) => dayAt(index))
  const pointsOf = (models: readonly ModelTotals[]): number[] => {
    const points = Array.from({ length: steps }, () => 0)
    for (const model of models) for (const [day, tokens] of aggregated.daily.get(`${model.provider}\u0000${model.model}`) ?? []) {
      const index = Math.floor((dayNumber(day) - first) / step)
      if (index >= 0 && index < steps) points[index]! += measure(model, tokens)
    }
    return points
  }
  const shown = aggregated.models.slice(0, MAX_LINES)
  const rest = aggregated.models.slice(MAX_LINES)
  return {
    days,
    series: [
      ...shown.map(model => ({ id: `${model.provider}\u0000${model.model}`, provider: model.provider, model: model.model, points: pointsOf([model]) })),
      ...rest.length === 0 ? [] : [{ id: 'other', provider: undefined, model: undefined, points: pointsOf(rest) }],
    ],
  }
}
