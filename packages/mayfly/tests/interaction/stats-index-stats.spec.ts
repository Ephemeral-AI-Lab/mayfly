/** `/stats` History and Models figures: the range window, aggregation,
 * heatmap levels, streaks, model totals, and the daily chart.
 * @module @ephemeral-ai/mayfly/tests/interaction/stats-index-stats
 */
import { describe, expect, it } from 'vitest'
import { dayKey, type DayDigest, type ModelDay, type SessionDigest } from '../../src/interaction/stats-index/digest.ts'
import { aggregate, CHART_DAYS, dailyChart, dayOffset, heatmapGrid, rangeStart, type StatsAggregate } from '../../src/interaction/stats-index/stats.ts'
import type { TokenBuckets } from '../../src/interaction/usage.ts'

const DAY_MS = 86_400_000
const NOW = new Date(2026, 9, 14, 12, 0, 0).getTime()
const DAY = (offset: number): string => dayOffset(NOW, offset)
const buckets = (input = 0, cacheRead = 0, cacheWrite = 0, output = 0): TokenBuckets => ({ input, cacheRead, cacheWrite, output })
const tokenSum = (value: TokenBuckets): number => value.input + value.cacheRead + value.cacheWrite + value.output
const modelDay = (provider: string, model: string, peak = buckets(), offPeak = buckets()): ModelDay => ({ provider, model, peak: { ...peak }, offPeak: { ...offPeak } })
const day = (turns: number, models: readonly ModelDay[] = []): DayDigest => ({
  turns,
  models: new Map(models.map(entry => [`${entry.provider}\u0000${entry.model}`, entry])),
})
const digest = (id: string, days: Record<string, DayDigest>, firstAt = 0, lastAt = 0, cwd = '/repo'): SessionDigest => ({
  id, cwd, firstAt, lastAt, days: new Map(Object.entries(days)),
})
const modelKey = (provider: string, model: string): string => `${provider}\u0000${model}`

describe('range windows', () => {
  it('names today and the seven- and thirty-day starts', () => {
    expect(dayOffset(NOW, 0)).toBe(dayKey(NOW))
    expect(dayOffset(NOW, 1)).toBe(dayKey(NOW + DAY_MS))
    expect(dayOffset(NOW, -1)).toBe(dayKey(NOW - DAY_MS))
    expect(rangeStart('7d', NOW)).toBe(dayOffset(NOW, -6))
    expect(rangeStart('30d', NOW)).toBe(dayOffset(NOW, -29))
    expect(rangeStart('all', NOW)).toBeUndefined()
  })
})

/** Two sessions inside the last eleven days, one old session, and a future day that must not count. */
function historyDigests(): SessionDigest[] {
  return [
    digest('a', {
      [DAY(0)]: day(2, [modelDay('deepseek', 'flash', buckets(1, 2, 3, 4), buckets(10, 20, 30, 40))]),
      [DAY(-1)]: day(0, [modelDay('deepseek', 'pro', buckets(), buckets(5, 6, 7, 8))]),
    }, NOW - DAY_MS, NOW - DAY_MS + 2 * 3_600_000),
    digest('b', {
      [DAY(-3)]: day(5),
      [DAY(-10)]: day(1, [modelDay('acme', 'one', buckets(1, 1, 1, 1))]),
    }, NOW - 10 * DAY_MS, NOW - 10 * DAY_MS + 2 * 3_600_000),
    digest('future', { [DAY(1)]: day(100, [modelDay('acme', 'later', buckets(9, 9, 9, 9))]) }),
  ]
}

describe('aggregate', () => {
  it('counts the range, its active days, longest session, and every model total', () => {
    const all = aggregate(historyDigests(), 'all', NOW)
    expect(all.sessions).toBe(2)
    expect(all.activeDays).toBe(3)
    expect(all.rangeDays).toBe(11)
    expect(all.mostActiveDay).toEqual({ key: DAY(-3), turns: 5 })
    expect(all.longestSessionMs).toBe(2 * 3_600_000)
    expect(all.dayTurns.get(DAY(0))).toBe(2)
    expect(all.dayTurns.has(DAY(-1))).toBe(false)
    expect(all.dayTurns.has(DAY(1))).toBe(false)
    expect(all.models.map(model => `${model.provider}/${model.model}`)).toEqual(['deepseek/flash', 'deepseek/pro', 'acme/one'])
    const flash = all.models[0]!
    expect(flash.total).toBe(10 + 20 + 30 + 40 + 1 + 2 + 3 + 4)
    expect(flash.buckets).toEqual({ input: 11, cacheRead: 22, cacheWrite: 33, output: 44 })
    expect(all.models[1]!.total).toBe(5 + 6 + 7 + 8)
    expect(all.buckets).toEqual({ input: 17, cacheRead: 29, cacheWrite: 41, output: 53 })
    expect([...all.daily.keys()].sort()).toEqual([modelKey('acme', 'one'), modelKey('deepseek', 'flash'), modelKey('deepseek', 'pro')].sort())
    expect(all.daily.get(modelKey('deepseek', 'flash'))?.get(DAY(0))).toMatchObject({ peak: buckets(1, 2, 3, 4), offPeak: buckets(10, 20, 30, 40) })
  })

  it('clips a 7d range and keeps the fixed range length', () => {
    const week = aggregate(historyDigests(), '7d', NOW)
    expect(week.sessions).toBe(2)
    expect(week.activeDays).toBe(2)
    expect(week.rangeDays).toBe(7)
    expect(week.dayTurns.has(DAY(-10))).toBe(false)
    expect(week.models.map(model => model.model)).toEqual(['flash', 'pro'])
    const month = aggregate(historyDigests(), '30d', NOW)
    expect(month.rangeDays).toBe(30)
    expect(month.activeDays).toBe(3)
    expect(month.models.map(model => model.model)).toEqual(['flash', 'pro', 'one'])
  })

  it('counts a session by its in-range days and keeps a day with models but no turns', () => {
    const result = aggregate([digest('empty', {
      [DAY(-2)]: day(0, [modelDay('p', 'm', buckets(1))]),
      [DAY(-40)]: day(9),
    })], '7d', NOW)
    expect(result.sessions).toBe(1)
    expect(result.activeDays).toBe(0)
    expect(result.rangeDays).toBe(7)
    expect(result.mostActiveDay).toBeUndefined()
    expect(result.currentStreak).toBe(0)
    expect(result.models[0]).toMatchObject({ total: 1, buckets: { input: 1 } })
    const excluded = aggregate([digest('old', { [DAY(-40)]: day(9) })], '7d', NOW)
    expect(excluded).toMatchObject({ sessions: 0, activeDays: 0, mostActiveDay: undefined, rangeDays: 7, longestStreak: 0, currentStreak: 0, models: [], buckets: buckets() })
    expect(excluded.dayTurns.size).toBe(0)
    expect(aggregate([], 'all', NOW).rangeDays).toBe(1)
  })

  it('breaks a model-total tie by model id and sums both price tiers into one bucket', () => {
    const result = aggregate([digest('tie', {
      [DAY(0)]: day(1, [
        modelDay('p', 'zzz', buckets(1), buckets(1)),
        modelDay('p', 'aaa', buckets(2)),
        modelDay('q', 'aaa', buckets(1)),
      ]),
    })], 'all', NOW)
    expect(result.models.map(model => `${model.provider}/${model.model}:${model.total}`)).toEqual(['p/aaa:2', 'p/zzz:2', 'q/aaa:1'])
    const zzz = result.models[1]!
    expect(zzz.buckets).toEqual({ input: 2, cacheRead: 0, cacheWrite: 0, output: 0 })
    expect(zzz.peak).toEqual(buckets(1))
    expect(zzz.offPeak).toEqual(buckets(1))
  })

  it('merges one model and one day across digests into one total', () => {
    const result = aggregate([
      digest('one', { [DAY(0)]: day(1, [modelDay('p', 'm', buckets(1), buckets(2))]) }),
      digest('two', {
        [DAY(0)]: day(1, [modelDay('p', 'm', buckets(3), buckets(4))]),
        [DAY(-1)]: day(1, [modelDay('p', 'm', buckets(5))]),
      }),
    ], 'all', NOW)
    expect(result.models).toHaveLength(1)
    expect(result.models[0]).toMatchObject({ total: 15, buckets: { input: 15, cacheRead: 0, cacheWrite: 0, output: 0 } })
    expect(result.daily.get(modelKey('p', 'm'))?.get(DAY(0))).toEqual({ peak: buckets(4), offPeak: buckets(6) })
    expect(result.daily.get(modelKey('p', 'm'))?.get(DAY(-1))).toEqual({ peak: buckets(5), offPeak: buckets() })
  })

  it('breaks a most-active-day tie toward the later date and merges duplicate digests', () => {
    const result = aggregate([
      digest('one', { [DAY(-1)]: day(3), [DAY(-2)]: day(3) }),
      digest('two', { [DAY(-2)]: day(4) }),
    ], 'all', NOW)
    expect(result.mostActiveDay).toEqual({ key: DAY(-2), turns: 7 })
    expect(result.dayTurns.get(DAY(-2))).toBe(7)
    expect(result.longestStreak).toBe(2)
    expect(result.currentStreak).toBe(2)
  })
})

describe('streaks', () => {
  it('counts the current run back from today, or from yesterday before a turn today', () => {
    const endingToday = aggregate([digest('s', {
      [DAY(0)]: day(1), [DAY(-1)]: day(1), [DAY(-2)]: day(1), [DAY(-5)]: day(1),
    })], 'all', NOW)
    expect(endingToday.longestStreak).toBe(3)
    expect(endingToday.currentStreak).toBe(3)
    const endingYesterday = aggregate([digest('s', { [DAY(-1)]: day(1), [DAY(-2)]: day(1), [DAY(-4)]: day(1) })], 'all', NOW)
    expect(endingYesterday.currentStreak).toBe(2)
    expect(endingYesterday.longestStreak).toBe(2)
    const stale = aggregate([digest('s', { [DAY(-2)]: day(1), [DAY(-3)]: day(1) })], 'all', NOW)
    expect(stale.currentStreak).toBe(0)
    expect(stale.longestStreak).toBe(2)
    expect(aggregate([], 'all', NOW)).toMatchObject({ longestStreak: 0, currentStreak: 0 })
  })

  it('does not let a gap in the middle extend a run', () => {
    const result = aggregate([digest('s', { [DAY(0)]: day(1), [DAY(-1)]: day(1), [DAY(-3)]: day(1), [DAY(-4)]: day(1), [DAY(-5)]: day(1) })], 'all', NOW)
    expect(result.longestStreak).toBe(3)
    expect(result.currentStreak).toBe(2)
  })
})

describe('heatmapGrid', () => {
  const now = new Date(2026, 9, 14, 12, 0, 0).getTime() // Wednesday
  const monthName = (month: number): string => `M${String(month)}`

  it('draws the last week Sunday first, today last, and blanks the days after today', () => {
    const turns = new Map([[dayKey(now), 8], [dayOffset(now, -2), 2]])
    const grid = heatmapGrid(turns, 1, now, monthName)
    expect(grid.weeks).toBe(1)
    expect(grid.levels.map(row => row[0])).toEqual([0, 1, 0, 4, null, null, null])
    expect(grid.monthLabels).toEqual(['M9'])
  })

  it('labels a month only where it changes and names the first column when the change is far off', () => {
    const numbered = (weeks: number, at: number): readonly string[] => heatmapGrid(new Map(), weeks, at, monthName).monthLabels
    // Sundays 20 Sep through 25 Oct: the first change (column 2) is too early to move the name.
    expect(numbered(6, new Date(2026, 9, 28, 12).getTime())).toEqual(['', '', 'M9', '', '', ''])
    // Sundays 1 Mar through 5 Apr: the first change is in column 5, so column 0 gets the name.
    expect(numbered(6, new Date(2026, 3, 9, 12).getTime())).toEqual(['M2', '', '', '', '', 'M3'])
    // A single month is named in its first column.
    expect(numbered(2, new Date(2026, 9, 14, 12).getTime())).toEqual(['M9', ''])
    // A zero-width grid still names January.
    expect(numbered(0, now)).toEqual(['M0'])
  })

  it('scales levels one to four by the busiest day of the shown range', () => {
    const turns = new Map([
      [dayOffset(now, -3), 10],
      [dayOffset(now, -2), 1],
      [dayOffset(now, -1), 5],
    ])
    const grid = heatmapGrid(turns, 1, now, monthName)
    expect(grid.levels[0]![0]).toBe(4) // Sunday 11 Oct: the busiest (10)
    expect(grid.levels[1]![0]).toBe(1) // Monday: ceil(0.4) to 1
    expect(grid.levels[2]![0]).toBe(2) // Tuesday: ceil(2)
    expect(grid.levels[3]![0]).toBe(0) // Wednesday has no turn
    const quiet = heatmapGrid(new Map(), 1, now, monthName)
    expect(quiet.levels.flat().every(level => level === 0 || level === null)).toBe(true)
  })
})

describe('dailyChart', () => {
  /** Five models of falling totals, so the fifth folds into the `other` line. */
  function fiveModels(): StatsAggregate {
    const days: Record<string, DayDigest> = {
      [DAY(0)]: day(5, [
        modelDay('p', 'm1', buckets(50), buckets(50)),
        modelDay('p', 'm2', buckets(40), buckets(50)),
        modelDay('p', 'm3', buckets(70), buckets(10)),
        modelDay('p', 'm4', buckets(60), buckets(10)),
        modelDay('p', 'm5', buckets(60), buckets(0)),
      ]),
    }
    return aggregate([digest('five', days)], 'all', NOW)
  }

  it('draws the four busiest models and one other line over the chart window', () => {
    const chart = dailyChart(fiveModels(), NOW, (_model, day) => tokenSum(day.peak) + tokenSum(day.offPeak))
    expect(chart.days).toHaveLength(CHART_DAYS)
    expect(chart.days.at(-1)).toBe(dayKey(NOW))
    expect(chart.days[0]).toBe(dayKey(NOW - (CHART_DAYS - 1) * DAY_MS))
    expect(chart.series).toHaveLength(5)
    expect(chart.series.slice(0, 4).map(series => [series.id, series.provider, series.model])).toEqual([
      [modelKey('p', 'm1'), 'p', 'm1'],
      [modelKey('p', 'm2'), 'p', 'm2'],
      [modelKey('p', 'm3'), 'p', 'm3'],
      [modelKey('p', 'm4'), 'p', 'm4'],
    ])
    const other = chart.series[4]!
    expect(other).toMatchObject({ id: 'other', provider: undefined, model: undefined })
    expect(other.points.at(-1)).toBe(60)
    expect(chart.series[0]!.points.at(-1)).toBe(100)
    expect(chart.series[0]!.points.slice(0, -1).every(point => point === 0)).toBe(true)
  })

  it('ignores per-day values outside the chart window and allows another measure', () => {
    const base = fiveModels()
    const first = base.models[0]!
    const perDay = new Map(base.daily.get(modelKey(first.provider, first.model))!)
    const outside = { peak: buckets(999), offPeak: buckets(999) }
    perDay.set(dayKey(NOW - CHART_DAYS * DAY_MS), outside)
    perDay.set(dayKey(NOW + DAY_MS), outside)
    const daily = new Map(base.daily)
    daily.set(modelKey(first.provider, first.model), perDay)
    const chart = dailyChart({ ...base, daily }, NOW, (_model, day) => day.offPeak.output)
    expect(chart.series[0]!.points.every(point => point === 0)).toBe(true)
  })

  it('draws zero points for a model with no daily entry', () => {
    const chart = dailyChart({ ...fiveModels(), daily: new Map() }, NOW, () => 1)
    expect(chart.series).toHaveLength(5)
    expect(chart.series.every(series => series.points.every(point => point === 0))).toBe(true)
  })

  it('draws no lines without models', () => {
    const chart = dailyChart(aggregate([], 'all', NOW), NOW, () => 1)
    expect(chart.series).toEqual([])
    expect(chart.days).toHaveLength(CHART_DAYS)
  })
})
