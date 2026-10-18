/** Pure `/sessions` rows and detail sheets over native Session Controller
 * summaries: the name, activity, tokens, and model come from the listing's
 * projection hints, and the detail sheet may replace them with one exact
 * projection read. Harness owns the session header, log, and projections.
 * @module @ephemeral-ai/mayfly/interaction/session-list-model
 */
import type { SessionProjectionValues, SessionSummary } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionStatsProjection } from '@deepseek-ai/dsh-session-stats'
// Empty type imports carry the projection declarations read below.
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-token-meter'
import { ui, type MayflyField, type MayflyInlineSpan, type MayflyListItem, type MayflyTone, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyTranslate } from '../frontend/locale.ts'
import { shortenCwd } from '../transcript/status-cwd.ts'
import { formatCreated } from './session-info-model.ts'
import { formatTokens, totalTokens, type TokenBuckets } from './usage.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Everything one `/sessions` row and its detail sheet display. */
export interface SessionListFacts {
  readonly id: string
  /** Native session title; absent before the title service names the session. */
  readonly title?: string
  readonly cwd?: string
  /** Latest human prompt from the listing metadata, or the running time. */
  readonly lastActiveAt?: number
  readonly running: boolean
  readonly archived: boolean
  readonly current: boolean
  readonly reminders: boolean
  /** The stored log predates the current Session format; absent reads as false. */
  readonly migrationRequired?: boolean
  readonly parentId?: string
  readonly origin?: 'subagent'
  /** Preset projection, when the deployment composes presets. */
  readonly preset?: string
  /** Cumulative provider usage; absent when the listing carries no cached value. */
  readonly tokens?: TokenBuckets
  /** Whole-log turn/step counts and model/tool times, when cached. */
  readonly stats?: SessionStatsProjection
  readonly model?: { readonly provider: string, readonly model: string, readonly reasoningEffort?: string }
}

/** Listing-time context the summary itself does not carry. */
interface SessionListContext {
  /**
   * Exact projections from one detail read, or undefined to use the summary's
   * listing hints. A migration-required read carries cached values only.
   */
  readonly values?: SessionProjectionValues | undefined
  readonly archived: boolean
  readonly current: boolean
  /** Sessions with at least one active Host reminder; absent without Schedule. */
  readonly reminders?: ReadonlySet<string>
  /** The listing time, for running sessions and relative ages. */
  readonly now: number
}

/**
 * Project one native session summary into display facts.
 * @param summary - the session-controller list row.
 * @param context - exact projections, archive, current-session, and time context.
 * @returns the display facts.
 */
export function sessionListFacts(summary: SessionSummary, context: SessionListContext): SessionListFacts {
  const values: SessionProjectionValues = { ...summary.projections?.values, ...context.values }
  const title = values.title?.trim()
  const metadata = values.sessionListMetadata
  const stats = values.sessionStats
  const promptedAt = metadata?.lastPromptAt
    ?? (stats !== undefined && stats.turns > 0 ? summary.updatedAt : undefined)
  const usage = values.tokenUsage
  const model = values.modelSelection?.lastUsed ?? values.modelSelection?.next ?? undefined
  const preset = values.agentPreset ?? undefined
  const cwd = summary.cwd
  const lastActiveAt = summary.running ? context.now : promptedAt
  return {
    id: String(summary.sessionId),
    ...(title === undefined || title === '' ? {} : { title }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(lastActiveAt === undefined ? {} : { lastActiveAt }),
    running: summary.running,
    archived: context.archived,
    current: context.current,
    reminders: context.reminders?.has(String(summary.sessionId)) ?? false,
    migrationRequired: summary.formatStatus === 'migration-required',
    ...(summary.parentSessionId === undefined ? {} : { parentId: String(summary.parentSessionId) }),
    ...(summary.origin === undefined ? {} : { origin: summary.origin }),
    ...(preset === undefined ? {} : { preset }),
    ...(usage === undefined ? {} : { tokens: { input: usage.uncachedInputTokens, cacheRead: usage.cacheReadTokens, cacheWrite: usage.cacheWriteTokens, output: usage.outputTokens } }),
    ...(stats === undefined ? {} : { stats }),
    ...(model === undefined ? {} : { model }),
  }
}

/**
 * Compact duration: `45s`, `12m`, `2h 14m`, `3d 4h`; a zero trailing unit is
 * omitted (`2h`, `3d`).
 * @param ms - the duration in milliseconds; negative values format as `0s`.
 * @returns the formatted duration.
 */
export function formatDuration(ms: number): string {
  const value = Math.max(0, ms)
  if (value < MINUTE) return `${String(Math.floor(value / 1000))}s`
  if (value < HOUR) return `${String(Math.floor(value / MINUTE))}m`
  const [major, minor, majorUnit, minorUnit] = value < DAY
    ? [Math.floor(value / HOUR), Math.floor((value % HOUR) / MINUTE), 'h', 'm']
    : [Math.floor(value / DAY), Math.floor((value % DAY) / HOUR), 'd', 'h']
  return minor === 0 ? `${String(major)}${majorUnit}` : `${String(major)}${majorUnit} ${String(minor)}${minorUnit}`
}

/**
 * Relative age: `just now`, `5m ago`, `3h ago`, `2d ago`.
 * @param ms - elapsed milliseconds.
 * @param t - interaction translator.
 * @returns the localized age.
 */
export function formatAgo(ms: number, t: MayflyTranslate): string {
  if (ms < MINUTE) return t('just now')
  if (ms < HOUR) return t('{count}m ago', { count: Math.floor(ms / MINUTE) })
  if (ms < DAY) return t('{count}h ago', { count: Math.floor(ms / HOUR) })
  return t('{count}d ago', { count: Math.floor(ms / DAY) })
}

/**
 * The row label: the session name, or `Untitled · <short id>`.
 * @param facts - the session display facts.
 * @param t - interaction translator.
 * @returns the label text.
 */
export function sessionLabel(facts: SessionListFacts, t: MayflyTranslate): string {
  return facts.title ?? `${t('Untitled')} · ${facts.id.replace(/^session-/, '').slice(0, 8)}`
}

/**
 * One `/sessions` list row. The detail spans lead with the token total, then
 * the relative age and the home-shortened path, so a narrow row cuts the path
 * first; filtering also matches the id and the full path.
 * @param facts - the session display facts.
 * @param now - the listing time.
 * @param home - the home directory for path shortening.
 * @param t - interaction translator.
 * @param showCwd - include the path span (off inside one workspace).
 * @returns the list item.
 */
export function sessionListItem(facts: SessionListFacts, now: number, home: string, t: MayflyTranslate, showCwd = true): MayflyListItem {
  const segments: MayflyInlineSpan[] = []
  const tokens = facts.tokens === undefined ? 0 : totalTokens(facts.tokens)
  if (tokens > 0) segments.push({ text: `${formatTokens(tokens)} tok` })
  if (facts.lastActiveAt !== undefined) segments.push({ text: formatAgo(now - facts.lastActiveAt, t), tone: 'muted' })
  if (showCwd && facts.cwd !== undefined) segments.push({ text: shortenCwd(facts.cwd, home), tone: 'muted' })
  const badges = [
    ...(facts.current ? [t('current')] : []),
    ...(facts.running ? [t('running')] : []),
    ...(facts.migrationRequired ? [t('migration required')] : []),
    ...(facts.archived ? [t('archived')] : []),
    ...(facts.reminders ? [t('reminders')] : []),
  ]
  const label = sessionLabel(facts, t)
  return {
    id: facts.id,
    label,
    detailSpans: segments.flatMap((segment, index) => index === 0 ? [segment] : [{ text: ' · ', tone: 'muted' as const }, segment]),
    searchText: `${label} ${facts.id} ${facts.cwd ?? ''}`,
    ...(badges.length === 0 ? {} : { badge: badges.join(' · ') }),
    ...(facts.parentId === undefined ? {} : { parentId: facts.parentId }),
  }
}

function field(label: string, value: string, tone: MayflyTone = 'default'): MayflyField {
  return { label, value: [{ text: value, tone }] }
}

/**
 * The detail sheet for one session: name, identity, status, times, work, and
 * usage. Values the listing does not carry render as `—`.
 * @param facts - the session display facts.
 * @param now - the listing time.
 * @param t - interaction translator.
 * @returns the fields node.
 */
export function sessionDetailNode(facts: SessionListFacts, now: number, t: MayflyTranslate): MayflyUiNode {
  const unknown = '—'
  const status = [
    t(facts.running ? 'running' : 'inactive'),
    ...(facts.migrationRequired ? [t('migration required')] : []),
    ...(facts.archived ? [t('archived')] : []),
    ...(facts.current ? [t('current')] : []),
  ].join(' · ')
  const usage = facts.tokens
  return ui.fields([
    field(t('Name'), facts.title ?? t('Untitled'), facts.title === undefined ? 'muted' : 'default'),
    field('ID', facts.id),
    field(t('Path'), facts.cwd ?? unknown),
    field(t('Status'), status, facts.running ? 'success' : 'default'),
    ...(facts.preset === undefined ? [] : [field(t('Preset'), facts.preset)]),
    ...(facts.parentId === undefined ? [] : [field(t(facts.origin === 'subagent' ? 'Parent session' : 'Forked from'), facts.parentId)]),
    field(t('Last active'), facts.lastActiveAt === undefined ? unknown : `${formatCreated(facts.lastActiveAt)} (${formatAgo(now - facts.lastActiveAt, t)})`),
    field(t('Agent time'), facts.stats === undefined
      ? unknown
      : t('model {model} · tools {tools}', { model: formatDuration(facts.stats.llmMs), tools: formatDuration(facts.stats.toolMs) })),
    field(t('Turns'), facts.stats === undefined
      ? unknown
      : t('{turns} turns · {steps} steps', { turns: facts.stats.turns, steps: facts.stats.steps })),
    field(t('Tokens'), usage === undefined
      ? unknown
      : t('{total} (input {input} · cache read {cacheRead} · cache write {cacheWrite} · output {output})', {
          total: formatTokens(totalTokens(usage)),
          input: formatTokens(usage.input),
          cacheRead: formatTokens(usage.cacheRead),
          cacheWrite: formatTokens(usage.cacheWrite),
          output: formatTokens(usage.output),
        })),
    field(t('Model'), facts.model === undefined
      ? unknown
      : `${facts.model.model} (${facts.model.provider})${facts.model.reasoningEffort === undefined ? '' : ` · ${facts.model.reasoningEffort}`}`),
  ])
}
