/** The `/stats` panel texts: live session rows, History figures and heatmap
 * variants, Models blocks and charts, the Account provider rows, the index
 * notes, and the copied summary.
 * @module @ephemeral-ai/mayfly/tests/interaction/stats-facts
 */
import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import type { MayflyTranslate } from '../../src/frontend/locale.ts'
import { formatCreated, type SessionInfoFacts } from '../../src/interaction/session-info-model.ts'
import { formatAgo } from '../../src/interaction/session-list-model.ts'
import { dayKey, type DayDigest, type ModelDay, type SessionDigest } from '../../src/interaction/stats-index/digest.ts'
import { dayOffset } from '../../src/interaction/stats-index/stats.ts'
import type { AccountSnapshot, BalanceResult, Wallet } from '../../src/interaction/stats-account.ts'
import type { ModelTokens, PriceSources, UserPrice } from '../../src/interaction/pricing.ts'
import type { StatsRow } from '../../src/components/stats-panel.ts'
import { buildStatsFacts, formatSpan, statsSummary, STATS_TABS, type StatsInput } from '../../src/interaction/stats-facts.ts'
import { formatTokens, usagePercent } from '../../src/interaction/usage.ts'

const NOW = new Date(2026, 9, 14, 12, 0, 0).getTime()
const EMPTY = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
const t: MayflyTranslate = (key, values) => values === undefined
  ? key
  : key.replace(/\{(\w+)\}/g, (match, name: string) => {
      const value = (values as Record<string, string | number>)[name]
      return value === undefined ? match : String(value)
    })

const buckets = (input = 0, cacheRead = 0, cacheWrite = 0, output = 0) => ({ input, cacheRead, cacheWrite, output })
const modelTokens = (provider: string, model: string, peak = buckets(), offPeak = buckets()): ModelTokens => ({ provider, model, peak, offPeak })
const modelDay = (provider: string, model: string, peak = buckets(), offPeak = buckets()): ModelDay => ({ provider, model, peak, offPeak })
const day = (turns: number, models: readonly ModelDay[] = []): DayDigest => ({
  turns, models: new Map(models.map(entry => [`${entry.provider}\u0000${entry.model}`, entry])),
})
const digest = (id: string, days: Record<string, DayDigest>, firstAt = NOW - 3_600_000, lastAt = NOW): SessionDigest => ({
  id, cwd: '/repo', firstAt, lastAt, days: new Map(Object.entries(days)),
})
const userPrice = (price: Partial<UserPrice> = {}): UserPrice => ({ input: 1, output: 1, currency: 'USD', ...price })
const sources = (user: Readonly<Record<string, UserPrice>> = {}, usdCnyRate = 7.2): PriceSources => ({ user, usdCnyRate })

function sessionFacts(overrides: Partial<SessionInfoFacts> = {}): SessionInfoFacts {
  return {
    id: 'session-abcdef123456', cwd: '/repo', createdAt: Date.UTC(2026, 9, 14, 3, 4), status: 'idle',
    turns: 3, steps: 7, usage: { buckets: { ...EMPTY }, context: {} }, ...overrides,
  }
}

function input(overrides: Partial<StatsInput> = {}): StatsInput {
  return {
    t, locale: 'en', now: NOW, tab: 'session', range: 'all', allWorkspaces: true,
    session: sessionFacts(), sessionTokens: [], digests: [], index: undefined,
    sources: sources(), account: { snapshot: undefined, loading: false },
    lowBalance: { CNY: 10, USD: 1.5 }, version: { mayfly: '1.2.3', harness: '0.2.1' },
    ...overrides,
  }
}

const row = (facts: { readonly rows: readonly StatsRow[] }, label: string): StatsRow | undefined => facts.rows.find(item => item.label === label)
const sessionRow = (facts: ReturnType<typeof buildStatsFacts>, label: string) => row(facts.session, label)
const plain = (value: readonly { readonly text: string }[] | undefined): string => (value ?? []).map(span => span.text).join('')

/** Some sessions with turns and priced models inside the last week. */
function history(): readonly SessionDigest[] {
  return [
    digest('a', {
      [dayKey(NOW)]: day(2, [modelDay('deepseek', 'deepseek-v4-flash', buckets(1_000_000), buckets(500_000))]),
      [dayOffset(NOW, -1)]: day(1, [modelDay('deepseek', 'deepseek-v4-pro', buckets(), buckets(1_000_000))]),
    }, NOW - 2 * 3_600_000, NOW - 3_600_000),
    digest('b', { [dayOffset(NOW, -3)]: day(3) }, NOW - 3 * 86_400_000, NOW - 3 * 86_400_000 + 60_000),
  ]
}

const HISTORY_SOURCES = sources({
  'deepseek/deepseek-v4-flash': userPrice({ input: 1, output: 2 }),
  'deepseek/deepseek-v4-pro': userPrice({ input: 3, output: 4 }),
})

const wallet = (currency: Wallet['currency'], total: string, extra: Partial<Wallet> = {}): Wallet => ({ currency, total, ...extra })
const ready = (wallets: readonly Wallet[], available?: boolean): BalanceResult => ({ status: 'ready', wallets, available })

function snapshot(overrides: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return { route: 'deepseek-official', name: 'deepseek-official', kind: 'api-key', at: NOW - 1000, ...overrides }
}

describe('formatSpan', () => {
  it('prints seconds below ten seconds with one decimal', () => {
    expect(formatSpan(0)).toBe('0s')
    expect(formatSpan(1800)).toBe('1.8s')
    expect(formatSpan(9999)).toBe('10s')
    expect(formatSpan(-5000)).toBe('0s')
  })

  it('prints hours, minutes, and seconds with every non-zero larger unit', () => {
    expect(formatSpan(10_000)).toBe('10s')
    expect(formatSpan(59_999)).toBe('1m 0s')
    expect(formatSpan(60_000)).toBe('1m 0s')
    expect(formatSpan(3_600_000)).toBe('1h 0m 0s')
    expect(formatSpan(3_723_000)).toBe('1h 2m 3s')
    expect(formatSpan(90_000_000)).toBe('25h 0m 0s')
  })
})

describe('session tab', () => {
  it('explains an unreadable session and keeps the refresh hint', () => {
    const facts = buildStatsFacts(input({ session: undefined }))
    expect(facts.session).toEqual({ rows: [], byModel: [], unavailable: 'Session information unavailable', refresh: 'refresh' })
  })

  it('collapses the home directory, names an absent model, and shows the reasoning effort', () => {
    const home = buildStatsFacts(input({ session: sessionFacts({ cwd: homedir() }) }))
    expect(plain(sessionRow(home, 'Working directory')!.value)).toBe('~')
    const inside = buildStatsFacts(input({ session: sessionFacts({ cwd: `${homedir()}/projects/x` }) }))
    expect(plain(sessionRow(inside, 'Working directory')!.value)).toBe('~/projects/x')
    const elsewhere = buildStatsFacts(input({ session: sessionFacts({ cwd: '/srv/app' }) }))
    expect(plain(sessionRow(elsewhere, 'Working directory')!.value)).toBe('/srv/app')
    const { cwd: _withoutCwd, ...withoutCwd } = sessionFacts()
    const unknown = buildStatsFacts(input({ session: withoutCwd }))
    expect(plain(sessionRow(unknown, 'Working directory')!.value)).toBe('(unknown)')
    expect(plain(sessionRow(unknown, 'Model')!.value)).toBe('not set')

    const plainModel = buildStatsFacts(input({ session: sessionFacts({ model: { provider: 'p', model: 'm' } }) }))
    expect(plain(sessionRow(plainModel, 'Model')!.value)).toBe('m (p)')
    const effort = buildStatsFacts(input({ session: sessionFacts({ model: { provider: 'p', model: 'm', reasoningEffort: 'high' } }) }))
    expect(plain(sessionRow(effort, 'Model')!.value)).toBe('m (p) · thinking high')
  })

  it('colors the context row by usage and only shows it when the window is known', () => {
    const ok = buildStatsFacts(input({ session: sessionFacts({ usage: { buckets: EMPTY, context: { used: 10, window: 100 } } }) }))
    expect(sessionRow(ok, 'Context')!.value[0]).toMatchObject({ text: `${usagePercent(10, 100)}% · 10 / 100`, tone: 'success' })
    const warn = buildStatsFacts(input({ session: sessionFacts({ usage: { buckets: EMPTY, context: { used: 50, window: 100 } } }) }))
    expect(sessionRow(warn, 'Context')!.value[0]).toMatchObject({ text: '50% · 50 / 100', tone: 'warning' })
    const danger = buildStatsFacts(input({ session: sessionFacts({ usage: { buckets: EMPTY, context: { used: 90, window: 100 } } }) }))
    expect(sessionRow(danger, 'Context')!.value[0]).toMatchObject({ text: '90% · 90 / 100', tone: 'danger' })
    const none = buildStatsFacts(input({ session: sessionFacts({ usage: { buckets: EMPTY, context: { window: 0 } } }) }))
    expect(sessionRow(none, 'Context')).toBeUndefined()
    const noWindow = buildStatsFacts(input({ session: sessionFacts({ usage: { buckets: EMPTY, context: { used: 10 } } }) }))
    expect(sessionRow(noWindow, 'Context')).toBeUndefined()
  })

  it('lists the token split, deriving the cache hit rate from the prompt tokens', () => {
    const outputOnly = buildStatsFacts(input({ session: sessionFacts({ usage: { buckets: buckets(0, 0, 0, 5), context: {} } }) }))
    expect(plain(sessionRow(outputOnly, 'Tokens')!.value)).toBe('0 in · 0 cache read (0% hit) · 0 cache write · 5 out')
    const tokens = buildStatsFacts(input({ session: sessionFacts({ usage: { buckets: buckets(10, 30, 60, 5), context: {} } }) }))
    expect(plain(sessionRow(tokens, 'Tokens')!.value)).toBe('10 in · 30 cache read (30% hit) · 60 cache write · 5 out')
    const empty = buildStatsFacts(input())
    expect(sessionRow(empty, 'Tokens')).toBeUndefined()
  })

  it('adds a cost row and a per-model block only when there is money and more than one model', () => {
    const priced = modelTokens('deepseek', 'deepseek-v4-flash', buckets(1_000_000))
    const single = buildStatsFacts(input({ sessionTokens: [priced], sources: HISTORY_SOURCES }))
    expect(plain(sessionRow(single, 'Cost')!.value)).toBe('≈ $ 1.00')
    expect(single.session.byModel).toEqual([])
    expect(single.session.byModelTitle).toBeUndefined()

    const unpriced = modelTokens('acme', 'unknown', buckets(1_000_000))
    const two = buildStatsFacts(input({ sessionTokens: [priced, unpriced], sources: HISTORY_SOURCES }))
    expect(plain(sessionRow(two, 'Cost')!.value)).toBe('≈ $ 1.00 + unpriced')
    expect(two.session.byModelTitle).toBe('By model')
    expect(two.session.byModel.map(entry => entry.label)).toEqual(['deepseek/deepseek-v4-flash', 'acme/unknown'])
    expect(plain(two.session.byModel[0]!.value)).toBe(`${formatTokens(1_000_000)} tokens · ≈ $ 1.00`)
    expect(plain(two.session.byModel[1]!.value)).toBe(`${formatTokens(1_000_000)} tokens`)
    expect(two.session.byModel[0]!.value[0]).toEqual({ text: `${formatTokens(1_000_000)} tokens · ≈ $ 1.00` })
  })

  it('shows the cost in the locale currency and totals both price tiers', () => {
    const zh = buildStatsFacts(input({
      locale: 'zh', sources: HISTORY_SOURCES, sessionTokens: [
        modelTokens('deepseek', 'deepseek-v4-flash', buckets(1_000_000), buckets(1_000_000)),
        modelTokens('deepseek', 'deepseek-v4-pro', buckets(1_000_000)),
      ],
    }))
    expect(plain(sessionRow(zh, 'Cost')!.value)).toMatch(/^≈ ¥ /)
    expect(plain(zh.session.byModel[0]!.value)).toContain('tokens')
  })

  it('shows timing parts only when there is time, including TTFT and decode rate when known', () => {
    const absent = buildStatsFacts(input({ session: sessionFacts() }))
    expect(sessionRow(absent, 'Time')).toBeUndefined()
    const zero = buildStatsFacts(input({ session: sessionFacts({ timing: { llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 } }) }))
    expect(sessionRow(zero, 'Time')).toBeUndefined()
    const basic = buildStatsFacts(input({ session: sessionFacts({ timing: { llmMs: 1000, toolMs: 2000, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 100 } }) }))
    expect(plain(sessionRow(basic, 'Time')!.value)).toBe('model 1s · tools 2s')
    const detailed = buildStatsFacts(input({ session: sessionFacts({ timing: { llmMs: 1000, toolMs: 2000, ttftMs: 500, ttftSteps: 2, decodeMs: 2000, decodeTokens: 100 } }) }))
    expect(plain(sessionRow(detailed, 'Time')!.value)).toBe('model 1s · tools 2s · first token 0.3s · 50 tok/s')
    const noTokens = buildStatsFacts(input({ session: sessionFacts({ timing: { llmMs: 1000, toolMs: 2000, ttftMs: 500, ttftSteps: 2, decodeMs: 2000, decodeTokens: 0 } }) }))
    expect(plain(sessionRow(noTokens, 'Time')!.value)).toBe('model 1s · tools 2s · first token 0.3s')
  })

  it('prints the turn counts, creation time, short id, and versions', () => {
    const facts = buildStatsFacts(input())
    expect(plain(sessionRow(facts, 'Turns')!.value)).toBe('3 turns · 7 steps')
    expect(plain(sessionRow(facts, 'Created')!.value)).toBe(`${formatCreated(Date.UTC(2026, 9, 14, 3, 4))} · session-`)
    expect(plain(sessionRow(facts, 'Version')!.value)).toBe('Mayfly 1.2.3 · Harness 0.2.1')
    expect(facts.session.refresh).toBe('refresh')
  })
})

describe('history tab', () => {
  const facts = () => buildStatsFacts(input({ tab: 'history', range: '7d', digests: history(), sources: HISTORY_SOURCES }))

  it('has three heatmap widths, seven weekday rows, levels, legend, and keys', () => {
    const historyFacts = facts().history
    expect(historyFacts.variants.map(variant => [variant.weeks, variant.minWidth])).toEqual([[52, 64], [26, 38], [13, 0]])
    expect(historyFacts.variants.every(variant => variant.levels.length === 7 && variant.monthLabels.length === variant.weeks)).toBe(true)
    const weekday = (day: number): string => new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(new Date(2023, 0, 1 + day))
    expect(historyFacts.rowLabels).toEqual(['', weekday(1), '', weekday(3), '', weekday(5), ''])
    expect(historyFacts.levelLabels).toEqual(['0', '1', '2', '3', '4'])
    expect(historyFacts.legend).toEqual({ less: 'Less', more: 'More' })
    expect(historyFacts.keys).toEqual({ range: 'dates', workspace: 'workspace', copy: 'copy' })
  })

  it('fills both figure columns and the token line from the range aggregate', () => {
    const historyFacts = facts().history
    expect(historyFacts.left.map(entry => entry.label)).toEqual(['Favorite model', 'Sessions', 'Active days', 'Most active day'])
    expect(plain(historyFacts.left[0]!.value)).toBe('deepseek/deepseek-v4-flash')
    expect(plain(historyFacts.left[1]!.value)).toBe('2')
    expect(plain(historyFacts.left[2]!.value)).toBe('3/7')
    expect(plain(historyFacts.left[3]!.value)).toContain('Oct')
    expect(historyFacts.right.map(entry => entry.label)).toEqual(['Total tokens', 'Longest session', 'Longest streak', 'Current streak'])
    expect(plain(historyFacts.right[0]!.value)).toBe(formatTokens(2_500_000))
    expect(plain(historyFacts.right[1]!.value)).toBe('1h 0m 0s')
    expect(plain(historyFacts.right[2]!.value)).toBe('2 days')
    expect(plain(historyFacts.right[3]!.value)).toBe('2 days')
    expect(plain(historyFacts.tokens)).toBe(`Input ${formatTokens(2_500_000)} · Output 0 · Cache read 0 · Cache write 0  ≈ $ 4.50`)
    expect(historyFacts.tokens[0]!.tone).toBe('muted')
  })

  it('uses placeholders for an empty aggregate and singular day counts', () => {
    const empty = buildStatsFacts(input({ tab: 'history', digests: [] })).history
    expect(plain(empty.left[0]!.value)).toBe('—')
    expect(plain(empty.left[1]!.value)).toBe('0')
    expect(plain(empty.left[2]!.value)).toBe('0/1')
    expect(plain(empty.left[3]!.value)).toBe('—')
    expect(plain(empty.right[1]!.value)).toBe('—')
    expect(plain(empty.right[2]!.value)).toBe('0 days')
    expect(plain(empty.right[3]!.value)).toBe('0 days')
    expect(plain(empty.tokens)).toBe('Input 0 · Output 0 · Cache read 0 · Cache write 0')
    const base = buildStatsFacts(input({ tab: 'history', digests: [digest('one', { [dayKey(NOW)]: day(1) })] })).history
    expect(plain(base.right[2]!.value)).toBe('1 day')
    expect(plain(base.right[3]!.value)).toBe('1 day')
    expect(plain(base.right[1]!.value)).toBe('1h 0m 0s')
  })

  it('offers the range labels and the workspace scope', () => {
    const all = buildStatsFacts(input({ tab: 'history', range: 'all', allWorkspaces: false }))
    expect(all.history.ranges).toEqual([
      { id: 'all', label: 'All time', active: true },
      { id: '7d', label: 'Last 7 days', active: false },
      { id: '30d', label: 'Last 30 days', active: false },
    ])
    expect(all.history.scope).toBe('this workspace')
    expect(buildStatsFacts(input({ tab: 'history', range: '30d' })).history.ranges[2]!.active).toBe(true)
    expect(buildStatsFacts(input({ tab: 'history', range: '7d' })).history.scope).toBe('all workspaces')
  })

  it('reports each index state under the figures', () => {
    const note = (index: StatsInput['index']) => buildStatsFacts(input({ tab: 'history', index })).history
    expect(note(undefined).loading).toBeUndefined()
    expect(note(undefined).note).toBeUndefined()
    expect(note({ running: false, done: 0, total: 0, skipped: 0, failed: 0 }).loading).toBeUndefined()
    expect(note({ running: false, done: 0, total: 0, skipped: 0, failed: 0 }).note).toBeUndefined()
    expect(note({ running: true, done: 3, total: 8, skipped: 0, failed: 0 }).loading).toBe('indexing 3/8 sessions')
    expect(note({ running: true, done: 3, total: 8, skipped: 0, failed: 0 }).note).toBeUndefined()
    expect(note({ running: false, done: 0, total: 8, skipped: 0, failed: 2 }).loading).toBeUndefined()
    expect(note({ running: false, done: 0, total: 8, skipped: 0, failed: 2 }).note).toBe('2 sessions could not be read')
    expect(note({ running: false, done: 0, total: 120, skipped: 3, failed: 0 }).note).toBe('latest 120 sessions')
    expect(note({ running: false, done: 0, total: 5, skipped: 0, failed: 0, error: 'EACCES' }).note).toBe('Could not read the stored sessions: EACCES')
  })

  it('replaces the figures with the reason there is nothing to count', () => {
    expect(buildStatsFacts(input({ tab: 'history', digests: [] })).history.empty).toBe('No sessions yet')
    expect(buildStatsFacts(input({ tab: 'history', digests: [], index: { running: false, done: 0, total: 7, skipped: 0, failed: 0 } })).history.empty)
      .toBe('No session with a turn yet · 7 stored sessions found')
    const running = { running: true, done: 1, total: 2, skipped: 0, failed: 0 } as const
    expect(buildStatsFacts(input({ tab: 'history', digests: [], index: running })).history.empty).toBeUndefined()
    const failed = { running: false, done: 0, total: 2, skipped: 0, failed: 1, error: 'broken' } as const
    expect(buildStatsFacts(input({ tab: 'history', digests: [], index: failed })).history.empty).toBeUndefined()
    const counted = buildStatsFacts(input({ tab: 'history', digests: [digest('one', { [dayKey(NOW)]: day(1) })] })).history
    expect(counted.empty).toBeUndefined()
  })
})

describe('models tab', () => {
  const digests = (): readonly SessionDigest[] => [
    digest('models', {
      [dayKey(NOW)]: day(1, [
        modelDay('deepseek', 'deepseek-v4-flash', buckets(1_000_000), buckets(1_000_000)),
        modelDay('deepseek', 'deepseek-v4-pro', buckets(), buckets(1_000_000)),
      ]),
    }),
  ]

  it('draws token and cost charts and one block per model with its share, money, and lines', () => {
    const facts = buildStatsFacts(input({ tab: 'models', digests: digests(), sources: HISTORY_SOURCES })).models
    expect(facts.models.map(model => model.name)).toEqual(['deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-pro'])
    expect(facts.models.map(model => model.id)).toEqual(['deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-pro'])
    expect(facts.models.map(model => model.tone)).toEqual(['accent', 'success'])
    expect(facts.models[0]!.share).toBe('66.7%')
    expect(facts.models[0]!.amount).toBe('≈ $ 2.00')
    expect(facts.models[1]!.amount).toBe('≈ $ 3.00')
    expect(facts.models[0]!.lines).toEqual([`Input ${formatTokens(2_000_000)} · Output 0`, 'Cache read 0 · Cache write 0'])
    expect(facts.tokensChart?.title).toBe('Tokens per day')
    expect(facts.tokensChart?.xLabels).toHaveLength(200)
    expect(facts.tokensChart?.series.map(series => series.label)).toEqual(['deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-pro'])
    expect(facts.tokensChart?.series[0]!.tone).toBe('accent')
    expect(facts.costChart?.title).toBe('Cost per day (USD)')
    expect(facts.costChart?.series[0]!.points.at(-1)).toBeCloseTo(2, 10)
  })

  it('omits the cost chart when no model is priced and the other chart when everything is zero', () => {
    const unpriced = buildStatsFacts(input({
      tab: 'models', digests: [digest('acme', { [dayKey(NOW)]: day(1, [modelDay('acme', 'one', buckets(1_000))]) })],
    })).models
    expect(unpriced.tokensChart).toBeDefined()
    expect(unpriced.costChart).toBeUndefined()
    const free = buildStatsFacts(input({ tab: 'models', digests: [digest('free', { [dayKey(NOW)]: day(1, [modelDay('deepseek', 'deepseek-v4-flash')]) })] })).models
    expect(free.tokensChart).toBeUndefined()
    expect(free.costChart).toBeUndefined()
    expect(free.models[0]!.share).toBe('0%')
    expect(free.models[0]!.amount).toBeUndefined()
  })

  it('folds the fifth and later models into one other line and uses the muted tone', () => {
    const five = buildStatsFacts(input({
      tab: 'models', digests: [digest('five', {
        [dayKey(NOW)]: day(1, [
          modelDay('p', 'm1', buckets(500)),
          modelDay('p', 'm2', buckets(400)),
          modelDay('p', 'm3', buckets(300)),
          modelDay('p', 'm4', buckets(200)),
          modelDay('p', 'm5', buckets(100)),
        ]),
      })],
    })).models
    expect(five.models.map(model => model.tone)).toEqual(['accent', 'success', 'warning', 'danger', 'muted'])
    expect(five.tokensChart?.series.map(series => series.label)).toEqual(['p/m1', 'p/m2', 'p/m3', 'p/m4', 'other'])
    expect(five.tokensChart?.series[4]!.tone).toBe('muted')
  })

  it('names the range, scope, and empty reason', () => {
    const facts = buildStatsFacts(input({ tab: 'models', range: '30d', allWorkspaces: false, digests: [] })).models
    expect(facts.ranges[2]).toEqual({ id: '30d', label: 'Last 30 days', active: true })
    expect(facts.scope).toBe('this workspace')
    expect(facts.empty).toBe('No sessions yet')
    expect(buildStatsFacts(input({ tab: 'models', digests: [], index: { running: false, done: 0, total: 4, skipped: 0, failed: 0 } })).models.empty)
      .toBe('No session with a turn yet · 4 stored sessions found')
    const running = { running: true, done: 0, total: 4, skipped: 0, failed: 0 } as const
    expect(buildStatsFacts(input({ tab: 'models', digests: [], index: running })).models.empty).toBeUndefined()
    const failed = { running: false, done: 0, total: 4, skipped: 0, failed: 1, error: 'x' } as const
    expect(buildStatsFacts(input({ tab: 'models', digests: [], index: failed })).models.empty).toBeUndefined()
    expect(facts.keys).toEqual({ range: 'dates', workspace: 'workspace', copy: 'copy' })
  })

  it('reports the index note under the models', () => {
    const models = (index: StatsInput['index']) => buildStatsFacts(input({ tab: 'models', index })).models
    expect(models({ running: true, done: 1, total: 4, skipped: 0, failed: 0 }).loading).toBe('indexing 1/4 sessions')
    expect(models({ running: false, done: 0, total: 4, skipped: 0, failed: 3 }).note).toBe('3 sessions could not be read')
    expect(models({ running: false, done: 0, total: 4, skipped: 0, failed: 0 }).note).toBeUndefined()
  })
})

describe('account tab', () => {
  const account = (snapshotValue: AccountSnapshot | undefined, loading = false, session: SessionInfoFacts | undefined = sessionFacts()) =>
    buildStatsFacts(input({ tab: 'account', session, account: { snapshot: snapshotValue, loading } }))
  const accountRow = (facts: ReturnType<typeof buildStatsFacts>, label: string) => row(facts.account, label)

  it('names the provider even before a snapshot exists and reports a pending read', () => {
    const none = account(undefined, false, sessionFacts({ model: { provider: 'p', model: 'm' } }))
    expect(plain(accountRow(none, 'Provider')!.value)).toBe('p')
    expect(none.account.loading).toBeUndefined()
    expect(account(undefined, false, sessionFacts()).account.rows).toEqual([
      { label: 'Provider', value: [{ text: 'not set' }] },
    ])
    const loading = account(undefined, true)
    expect(loading.account.loading).toBe('checking balance…')
    expect(loading.account.rows).toHaveLength(1)
  })

  it('shows an api-key provider with endpoint, model count, key state, links, and checked age', () => {
    const facts = account(snapshot({
      name: 'deepseek-official', route: 'deepseek-official', endpoint: 'https://api.deepseek.com', models: 4,
      key: { ref: 'DEEPSEEK_API_KEY', configured: true },
      links: { topUp: 'https://t', usage: 'https://u' },
    }))
    expect(plain(accountRow(facts, 'Provider')!.value)).toBe('deepseek-official')
    expect(plain(accountRow(facts, 'Endpoint')!.value)).toBe('https://api.deepseek.com')
    expect(plain(accountRow(facts, 'Models')!.value)).toBe('4 configured')
    expect(plain(accountRow(facts, 'Key')!.value)).toBe('configured (DEEPSEEK_API_KEY)')
    expect(accountRow(facts, 'Key')!.value[0]!.tone).toBeUndefined()
    expect(plain(accountRow(facts, 'Balance')!.value)).toBe('No balance information for this provider')
    expect(accountRow(facts, 'Balance')!.value[0]!.tone).toBe('muted')
    expect(plain(accountRow(facts, 'Top up')!.value)).toBe('https://t')
    expect(plain(accountRow(facts, 'Usage')!.value)).toBe('https://u')
    expect(plain(accountRow(facts, 'Checked')!.value)).toBe(formatAgo(1000, t))
  })

  it('shows route and name together and warns about an unconfigured key', () => {
    const facts = account(snapshot({ name: 'DeepSeek', route: 'deepseek-official', key: { ref: 'DEEPSEEK_API_KEY', configured: false } }))
    expect(plain(accountRow(facts, 'Provider')!.value)).toBe('DeepSeek (deepseek-official)')
    expect(plain(accountRow(facts, 'Key')!.value)).toBe('not configured (DEEPSEEK_API_KEY)')
    expect(accountRow(facts, 'Key')!.value[0]!.tone).toBe('warning')
    const age = account(snapshot({ at: NOW - 5 * 60_000 }))
    expect(plain(accountRow(age, 'Checked')!.value)).toBe('5m ago')
    const future = account(snapshot({ at: NOW + 60_000 }))
    expect(plain(accountRow(future, 'Checked')!.value)).toBe('just now')
  })

  it('shows the account sign-in state and only the profile parts it has', () => {
    const signedOut = account(snapshot({ kind: 'account', name: 'DeepSeek Account', route: 'deepseek-account', signedIn: false }))
    expect(plain(accountRow(signedOut, 'Account')!.value)).toBe('Not signed in')
    const signedIn = account(snapshot({
      kind: 'account', name: 'DeepSeek Account', route: 'deepseek-account', signedIn: true,
      profile: { name: 'Ada', contact: 'ada@example' },
    }))
    expect(plain(accountRow(signedIn, 'Account')!.value)).toBe('Signed in · Ada · ada@example')
    const sparse = account(snapshot({
      kind: 'account', name: 'DeepSeek Account', route: 'deepseek-account', signedIn: true,
      profile: { name: '', contact: null },
    }))
    expect(plain(accountRow(sparse, 'Account')!.value)).toBe('Signed in')
    const nameOnly = account(snapshot({
      kind: 'account', name: 'DeepSeek Account', route: 'deepseek-account', signedIn: true,
      profile: { name: 'Ada', contact: '' },
    }))
    expect(plain(accountRow(nameOnly, 'Account')!.value)).toBe('Signed in · Ada')
  })

  it('marks a balance read in progress and explains every unavailable reason', () => {
    const loading = account(snapshot({ balance: ready([wallet('CNY', '10')]) }), true)
    expect(plain(accountRow(loading, 'Balance')!.value)).toBe('—')
    expect(accountRow(loading, 'Balance')!.value[0]!.tone).toBe('muted')
    const texts: Record<string, string> = {
      'signed-out': '— sign in from /provider to see the balance',
      'no-key': '— no API key to ask with',
      rejected: '— unavailable (key rejected)',
      network: '— unavailable (network)',
    }
    for (const [reason, text] of Object.entries(texts)) {
      const facts = account(snapshot({ balance: { status: 'unavailable', reason: reason as never } }))
      expect(plain(accountRow(facts, 'Balance')!.value)).toBe(text)
      expect(accountRow(facts, 'Balance')!.value[0]!.tone).toBe('muted')
    }
  })

  it('prints one row per wallet, with top-up and grant breakdown and the low-balance warning', () => {
    const normal = account(snapshot({
      balance: ready([
        wallet('CNY', '20.00', { toppedUp: '18.00', granted: '2.00' }),
        wallet('USD', '5'),
      ]),
    }))
    const walletRows = normal.account.rows.filter(entry => entry.label === 'Balance' || entry.label === '')
    expect(walletRows.map(entry => plain(entry.value))).toEqual(['¥ 20.00 · top-up ¥ 18.00 · granted ¥ 2.00', '$ 5'])
    expect(walletRows.map(entry => entry.label)).toEqual(['Balance', ''])
    expect(normal.accountAttention).toBe(false)

    const low = account(snapshot({ balance: ready([wallet('CNY', '1.00'), wallet('USD', '0.50')]) }))
    expect(plain(accountRow(low, 'Balance')!.value)).toBe('⚠ ¥ 1.00 low balance · below ¥ 10.00')
    expect(accountRow(low, 'Balance')!.value[0]!.tone).toBe('warning')
    expect(low.accountAttention).toBe(true)
    const mixed = account(snapshot({ balance: ready([wallet('CNY', '1.00'), wallet('USD', '9.00')]) }))
    expect(plain(accountRow(mixed, 'Balance')!.value)).toBe('¥ 1.00')
    expect(mixed.accountAttention).toBe(false)
  })

  it('warns when no funds are available and shows a dash for an empty ready balance', () => {
    const unavailable = account(snapshot({ balance: ready([], false) }))
    expect(plain(accountRow(unavailable, 'Balance')!.value)).toBe('⚠ not enough for API calls')
    expect(accountRow(unavailable, 'Balance')!.value[0]!.tone).toBe('warning')
    expect(unavailable.accountAttention).toBe(true)
    const empty = account(snapshot({ balance: ready([]) }))
    expect(plain(accountRow(empty, 'Balance')!.value)).toBe('—')
    expect(accountRow(empty, 'Balance')!.value[0]!.tone).toBe('muted')
    const zeroWallet = account(snapshot({ balance: ready([wallet('CNY', '5.00')], false) }))
    expect(plain(accountRow(zeroWallet, 'Balance')!.value)).toBe('⚠ ¥ 5.00 not enough for API calls')
    expect(zeroWallet.accountAttention).toBe(true)
  })

  it('keeps the note when the balance is absent rather than showing a loading dash', () => {
    const facts = account(snapshot(), true)
    expect(plain(accountRow(facts, 'Balance')!.value)).toBe('No balance information for this provider')
  })
})

describe('statsSummary', () => {
  it('copies the session rows and the by-model block when there is one', () => {
    const facts = buildStatsFacts(input({
      sessionTokens: [modelTokens('deepseek', 'deepseek-v4-flash', buckets(1_000_000)), modelTokens('acme', 'x', buckets(1_000_000))],
      sources: HISTORY_SOURCES,
    }))
    const summary = statsSummary(facts, 'session')
    expect(summary).toContain('Working directory: /repo')
    expect(summary).toContain('Cost: ≈ $ 1.00 + unpriced')
    expect(summary).toContain('By model')
    expect(summary).toContain(`deepseek/deepseek-v4-flash: ${formatTokens(1_000_000)} tokens · ≈ $ 1.00`)
    expect(summary).not.toContain('acme/x: 1m tokens · ')
  })

  it('copies a session without by-model rows and tolerates a missing by-model title', () => {
    const facts = buildStatsFacts(input())
    expect(statsSummary(facts, 'session')).not.toContain('By model')
    const titled = {
      ...facts,
      session: {
        ...facts.session,
        byModel: [{ label: 'p/m', value: [{ text: 'one token' }] }],
        byModelTitle: undefined,
      },
    }
    const summary = statsSummary(titled, 'session')
    expect(summary.split('\n').slice(-2)).toEqual(['', 'p/m: one token'])
  })

  it('copies the history range, scope, figures, and token line', () => {
    const facts = buildStatsFacts(input({ tab: 'history', range: '7d', digests: history(), sources: HISTORY_SOURCES, allWorkspaces: false }))
    const summary = statsSummary(facts, 'history')
    expect(summary.split('\n')[0]).toBe('Stats · Last 7 days · this workspace')
    expect(summary).toContain('Favorite model: deepseek/deepseek-v4-flash')
    expect(summary).toContain('Sessions: 2')
    expect(summary).toContain(`Total tokens: ${formatTokens(2_500_000)}`)
    expect(summary).toContain(`Input ${formatTokens(2_500_000)} · Output 0 · Cache read 0 · Cache write 0  ≈ $ 4.50`)
    expect(summary).not.toContain('By model')
  })

  it('copies the models range, scope, share, and indented lines', () => {
    const facts = buildStatsFacts(input({
      tab: 'models', range: '30d', allWorkspaces: false, digests: [digest('one', {
        [dayKey(NOW)]: day(1, [modelDay('deepseek', 'deepseek-v4-flash', buckets(1_000_000))]),
      })], sources: HISTORY_SOURCES,
    }))
    const summary = statsSummary(facts, 'models')
    expect(summary.split('\n')[0]).toBe('Stats · Last 30 days · this workspace')
    expect(summary).toContain('deepseek/deepseek-v4-flash (100.0%)')
    expect(summary).toContain(`  Input ${formatTokens(1_000_000)} · Output 0`)
    expect(summary).toContain('  Cache read 0 · Cache write 0')
    expect(summary).not.toContain('Sessions:')
  })

  it('falls back to an empty range label when no range is marked active', () => {
    const facts = buildStatsFacts(input({ tab: 'models', digests: [] }))
    const noActive = {
      ...facts,
      history: { ...facts.history, ranges: facts.history.ranges.map(entry => ({ ...entry, active: false })) },
      models: { ...facts.models, ranges: facts.models.ranges.map(entry => ({ ...entry, active: false })) },
    }
    expect(statsSummary(noActive, 'history').split('\n')[0]).toBe('Stats ·  · all workspaces')
    expect(statsSummary(noActive, 'models').split('\n')[0]).toBe('Stats ·  · all workspaces')
  })

  it('lists the offered tabs in order and titles the panel', () => {
    const facts = buildStatsFacts(input())
    expect(STATS_TABS).toEqual(['session', 'account', 'history', 'models'])
    expect(facts.title).toBe('Stats')
    expect(facts.activeTab).toBe('session')
    expect(facts.tabs).toEqual({ session: 'Session', account: 'Account', history: 'History', models: 'Models' })
  })
})
