/**
 * The final texts of the stats panel: the live session's rows, the History figures, and the Models blocks, from the
 * session facts, the index's digests, and the price sources. Pure; the command passes the clock, the locale, and what
 * the index holds.
 *
 * @module @ephemeral-ai/mayfly/interaction/stats-facts
 */
import { homedir } from 'node:os'
import type { MayflyInlineSpan, MayflyTone } from '@ephemeral-ai/mayfly-ui'
import type { StatsFacts, StatsRow, ModelBlock, ModelsChart, HeatmapVariant } from '../components/stats-panel.ts'
import type { MayflyTranslate } from '../frontend/locale.ts'
import { formatCreated, type SessionInfoFacts } from './session-info-model.ts'
import { formatMoney, moneyOf, type Currency, type Money, type ModelTokens, type PriceSources } from './pricing.ts'
import { aggregate, dailyChart, heatmapGrid, RANGES, type DayTokens, type ModelTotals, type StatsAggregate, type StatsRange } from './stats-index/stats.ts'
import type { SessionDigest } from './stats-index/digest.ts'
import { formatTokens, ratioSeverity, usagePercent, usageRatio } from './usage.ts'

export type StatsTab = 'session' | 'history' | 'models'
export const STATS_TABS: readonly StatsTab[] = ['session', 'history', 'models']

/** The index's state as the panel shows it. */
export interface IndexState {
  readonly running: boolean
  readonly done: number
  readonly total: number
  readonly skipped: number
  readonly failed: number
}

/** Everything the panel's texts are made from. */
export interface StatsInput {
  readonly t: MayflyTranslate
  readonly locale: 'zh' | 'en'
  readonly now: number
  readonly tab: StatsTab
  readonly range: StatsRange
  readonly allWorkspaces: boolean
  readonly session: SessionInfoFacts | undefined
  /** The current session's tokens by model, from its own events. */
  readonly sessionTokens: readonly ModelTokens[]
  readonly digests: readonly SessionDigest[]
  readonly index: IndexState | undefined
  readonly sources: PriceSources
  readonly version: { readonly mayfly: string, readonly harness: string }
}

const SERIES_TONES: readonly MayflyTone[] = ['accent', 'success', 'warning', 'danger']

const text = (value: string, tone?: MayflyTone): readonly MayflyInlineSpan[] => [tone === undefined ? { text: value } : { text: value, tone }]

/** `6h 42m 32s`, `4m 12s`, `1.8s`: a span of time down to the second. */
export function formatSpan(ms: number): string {
  const value = Math.max(0, ms)
  if (value < 10_000) return `${String(Number((value / 1000).toFixed(1)))}s`
  const seconds = Math.round(value / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  return [hours > 0 ? `${String(hours)}h` : '', hours > 0 || minutes > 0 ? `${String(minutes)}m` : '', `${String(rest)}s`].filter(part => part !== '').join(' ')
}

/** The directory with the home folder as `~`. */
function homeCollapsed(path: string): string {
  const home = homedir()
  return home !== '' && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path
}

/** A model is its provider and its id: the same id under two providers is two models. */
function modelName(model: { readonly provider: string, readonly model: string }): string {
  return `${model.provider}/${model.model}`
}

const sum = (buckets: { readonly input: number, readonly cacheRead: number, readonly cacheWrite: number, readonly output: number }): number => buckets.input + buckets.cacheRead + buckets.cacheWrite + buckets.output

function sessionTab(input: StatsInput, currency: Currency): StatsFacts['session'] {
  const { t, session } = input
  const refresh = t('refresh')
  if (session === undefined) return { rows: [], byModel: [], unavailable: t('Session information unavailable'), refresh }
  const rows: StatsRow[] = []
  rows.push({ label: t('Working directory'), value: text(session.cwd === undefined ? t('(unknown)') : homeCollapsed(session.cwd)) })
  rows.push({ label: t('Agent'), value: text(t(session.status)) })
  rows.push({ label: t('Model'), value: text(session.model === undefined ? t('not set') : `${session.model.model} (${session.model.provider})${session.model.reasoningEffort === undefined ? '' : ` · ${t('thinking {level}', { level: session.model.reasoningEffort })}`}`) })
  const { used, window } = session.usage.context
  if (window !== undefined && window > 0 && used !== undefined) {
    const severity = ratioSeverity(usageRatio(used, window))
    rows.push({ label: t('Context'), value: text(t('{percent}% · {used} / {window}', { percent: usagePercent(used, window), used: formatTokens(used), window: formatTokens(window) }), severity === 'danger' ? 'danger' : severity === 'warn' ? 'warning' : 'success') })
  }
  rows.push({ label: t('Turns'), value: text(t('{turns} turns · {steps} steps', { turns: session.turns, steps: session.steps })) })
  const { buckets } = session.usage
  const prompt = buckets.input + buckets.cacheRead + buckets.cacheWrite
  if (sum(buckets) > 0) {
    rows.push({ label: t('Tokens'), value: text(t('{input} in · {read} cache read ({rate}% hit) · {write} cache write · {output} out', { input: formatTokens(buckets.input), read: formatTokens(buckets.cacheRead), rate: prompt === 0 ? 0 : Math.round(buckets.cacheRead / prompt * 100), write: formatTokens(buckets.cacheWrite), output: formatTokens(buckets.output) })) })
  }
  const money = moneyOf(input.sessionTokens, currency, input.sources)
  const cost = moneyText(money, currency, t)
  if (cost !== undefined) rows.push({ label: t('Cost'), value: text(cost) })
  const timing = session.timing
  if (timing !== undefined && timing.llmMs + timing.toolMs > 0) {
    const parts = [t('model {time}', { time: formatSpan(timing.llmMs) }), t('tools {time}', { time: formatSpan(timing.toolMs) })]
    if (timing.ttftSteps > 0) parts.push(t('first token {time}', { time: formatSpan(timing.ttftMs / timing.ttftSteps) }))
    if (timing.decodeMs > 0 && timing.decodeTokens > 0) parts.push(t('{rate} tok/s', { rate: Math.round(timing.decodeTokens / (timing.decodeMs / 1000)) }))
    rows.push({ label: t('Time'), value: text(parts.join(' · ')) })
  }
  rows.push({ label: t('Created'), value: text(`${formatCreated(session.createdAt)} · ${session.id.slice(0, 8)}`) })
  rows.push({ label: t('Version'), value: text(`Mayfly ${input.version.mayfly} · Harness ${input.version.harness}`) })
  const byModel = input.sessionTokens.length < 2 ? [] : input.sessionTokens.map((model): StatsRow => {
    const amount = moneyText(moneyOf([model], currency, input.sources), currency, t)
    return { label: modelName(model), value: text(`${t('{tokens} tokens', { tokens: formatTokens(sum(model.peak) + sum(model.offPeak)) })}${amount === undefined ? '' : ` · ${amount}`}`) }
  })
  return { rows, ...byModel.length === 0 ? {} : { byModelTitle: t('By model') }, byModel, refresh }
}

/** The money as text: `≈ ¥ 3.02`, `≈ ¥ 3.02 + unpriced`, or nothing when no token has a price. */
function moneyText(money: Money, currency: Currency, t: MayflyTranslate): string | undefined {
  if (money.amount === 0) return undefined
  const amount = formatMoney(money.amount, currency)
  return money.unpriced ? t('{amount} + unpriced', { amount }) : amount
}

function rangeFacts(input: StatsInput): { ranges: { id: string, label: string, active: boolean }[], scope: string } {
  const { t } = input
  const labels: Record<StatsRange, string> = { all: t('All time'), '7d': t('Last 7 days'), '30d': t('Last 30 days') }
  return { ranges: RANGES.map(id => ({ id, label: labels[id], active: id === input.range })), scope: input.allWorkspaces ? t('all workspaces') : t('this workspace') }
}

function indexFacts(input: StatsInput): { loading?: string, note?: string } {
  const { t, index } = input
  if (index === undefined) return {}
  if (index.running) return { loading: t('indexing {done}/{total} sessions', { done: index.done, total: index.total }) }
  if (index.failed > 0) return { note: t('{count} sessions could not be read', { count: index.failed }) }
  if (index.skipped > 0) return { note: t('latest {count} sessions', { count: index.total }) }
  return {}
}

function historyTab(input: StatsInput, aggregated: StatsAggregate, currency: Currency): StatsFacts['history'] {
  const { t, locale, now } = input
  const intl = locale === 'zh' ? 'zh-CN' : 'en-US'
  const monthName = (month: number): string => new Intl.DateTimeFormat(intl, { month: 'short' }).format(new Date(2000, month, 1))
  const weekday = (day: number): string => new Intl.DateTimeFormat(intl, { weekday: 'short' }).format(new Date(2023, 0, 1 + day))
  const variant = (weeks: number, minWidth: number): HeatmapVariant => {
    const grid = heatmapGrid(aggregated.dayTurns, weeks, now, monthName)
    return { weeks, minWidth, monthLabels: grid.monthLabels, levels: grid.levels }
  }
  const days = (count: number): string => t(count === 1 ? '{count} day' : '{count} days', { count })
  const favorite = aggregated.models[0]
  const money = moneyText(moneyOf(aggregated.models, currency, input.sources), currency, t)
  const date = (key: string): string => new Intl.DateTimeFormat(intl, { month: 'short', day: 'numeric' }).format(new Date(`${key}T00:00:00`))
  const { buckets } = aggregated
  const empty = aggregated.sessions === 0 && input.index?.running !== true ? t('No sessions yet') : undefined
  return {
    ...rangeFacts(input), ...indexFacts(input),
    variants: [variant(52, 64), variant(26, 38), variant(13, 0)],
    rowLabels: [0, 1, 2, 3, 4, 5, 6].map(day => day % 2 === 1 ? weekday(day) : ''),
    levelLabels: ['0', '1', '2', '3', '4'],
    legend: { less: t('Less'), more: t('More') },
    left: [
      { label: t('Favorite model'), value: text(favorite === undefined ? '—' : modelName(favorite)) },
      { label: t('Sessions'), value: text(String(aggregated.sessions)) },
      { label: t('Active days'), value: text(`${String(aggregated.activeDays)}/${String(aggregated.rangeDays)}`) },
      { label: t('Most active day'), value: text(aggregated.mostActiveDay === undefined ? '—' : date(aggregated.mostActiveDay.key)) },
    ],
    right: [
      { label: t('Total tokens'), value: text(formatTokens(sum(buckets))) },
      { label: t('Longest session'), value: text(aggregated.longestSessionMs > 0 ? formatSpan(aggregated.longestSessionMs) : '—') },
      { label: t('Longest streak'), value: text(days(aggregated.longestStreak)) },
      { label: t('Current streak'), value: text(days(aggregated.currentStreak)) },
    ],
    tokens: [
      { text: `${t('Input')} ${formatTokens(buckets.input)} · ${t('Output')} ${formatTokens(buckets.output)} · ${t('Cache read')} ${formatTokens(buckets.cacheRead)} · ${t('Cache write')} ${formatTokens(buckets.cacheWrite)}${money === undefined ? '' : `  ${money}`}`, tone: 'muted' },
    ],
    ...empty === undefined ? {} : { empty },
    keys: keys(t),
  }
}

const keys = (t: MayflyTranslate): { range: string, workspace: string, copy: string } => ({ range: t('dates'), workspace: t('workspace'), copy: t('copy') })

function modelsTab(input: StatsInput, aggregated: StatsAggregate, currency: Currency): StatsFacts['models'] {
  const { t, locale, now } = input
  const intl = locale === 'zh' ? 'zh-CN' : 'en-US'
  const total = sum(aggregated.buckets)
  const date = (key: string): string => new Intl.DateTimeFormat(intl, { month: 'short', day: 'numeric' }).format(new Date(`${key}T00:00:00`))
  const toneOf = (index: number): MayflyTone => SERIES_TONES[index] ?? 'muted'
  const draw = (title: string, measure: (model: ModelTotals, day: DayTokens) => number): ModelsChart | undefined => {
    if (aggregated.models.length === 0) return undefined
    const drawn = dailyChart(aggregated, now, measure)
    if (drawn.series.every(series => series.points.every(point => point === 0))) return undefined
    return {
      title, xLabels: drawn.days.map(date),
      series: drawn.series.map((series, index) => ({
        id: series.id, tone: toneOf(index),
        label: series.model === undefined || series.provider === undefined ? t('other') : modelName({ provider: series.provider, model: series.model }),
        points: series.points,
      })),
    }
  }
  const tokensChart = draw(t('Tokens per day'), (_model, day) => sum(day.peak) + sum(day.offPeak))
  const costChart = draw(t('Cost per day ({currency})', { currency }), (model, day) => moneyOf([{ provider: model.provider, model: model.model, peak: day.peak, offPeak: day.offPeak }], currency, input.sources).amount)
  const blocks = aggregated.models.map((model: ModelTotals, index): ModelBlock => {
    const amount = moneyText(moneyOf([model], currency, input.sources), currency, t)
    return {
      id: `${model.provider}/${model.model}`, name: modelName(model), tone: toneOf(index),
      share: `${total === 0 ? '0' : (model.total / total * 100).toFixed(1)}%`,
      ...amount === undefined ? {} : { amount },
      lines: [
        `${t('Input')} ${formatTokens(model.buckets.input)} · ${t('Output')} ${formatTokens(model.buckets.output)}`,
        `${t('Cache read')} ${formatTokens(model.buckets.cacheRead)} · ${t('Cache write')} ${formatTokens(model.buckets.cacheWrite)}`,
      ],
    }
  })
  const empty = aggregated.models.length === 0 && input.index?.running !== true ? t('No sessions yet') : undefined
  return { ...rangeFacts(input), ...indexFacts(input), ...tokensChart === undefined ? {} : { tokensChart }, ...costChart === undefined ? {} : { costChart }, models: blocks, ...empty === undefined ? {} : { empty }, keys: keys(t) }
}

/**
 * The facts of the whole panel.
 * @param input - the clock, the locale, the session, the index and the prices.
 * @returns the panel's facts.
 */
export function buildStatsFacts(input: StatsInput): StatsFacts {
  const { t } = input
  const currency: Currency = input.locale === 'zh' ? 'CNY' : 'USD'
  const aggregated = aggregate(input.digests, input.range, input.now)
  return {
    title: t('Stats'), activeTab: input.tab,
    tabs: { session: t('Session'), history: t('History'), models: t('Models') },
    session: sessionTab(input, currency),
    history: historyTab(input, aggregated, currency),
    models: modelsTab(input, aggregated, currency),
  }
}

const plain = (spans: readonly MayflyInlineSpan[]): string => spans.map(span => span.text).join('')

/** The plain text `c` copies: the rows of the tab on show. */
export function statsSummary(facts: StatsFacts, tab: StatsTab): string {
  const rows = (list: readonly StatsRow[]): string[] => list.map(row => `${row.label}: ${plain(row.value)}`)
  if (tab === 'session') return [...rows(facts.session.rows), ...facts.session.byModel.length === 0 ? [] : [facts.session.byModelTitle ?? '', ...rows(facts.session.byModel)]].join('\n')
  const range = facts.history.ranges.find(entry => entry.active)?.label ?? ''
  if (tab === 'history') return [`${facts.title} · ${range} · ${facts.history.scope}`, ...rows(facts.history.left), ...rows(facts.history.right), plain(facts.history.tokens)].join('\n')
  return [`${facts.title} · ${range} · ${facts.models.scope}`, ...facts.models.models.flatMap(model => [`${model.name} (${model.share})`, ...model.lines.map(line => `  ${line}`)])].join('\n')
}
