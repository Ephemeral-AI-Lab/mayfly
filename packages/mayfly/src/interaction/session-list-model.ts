/** Pure `/sessions` rows and detail sheets over native session summaries:
 * the session name, wall-clock span, token total, and path come from the
 * listing's projection hints plus the stored session header.
 * @module @ephemeral-ai/mayfly/interaction/session-list-model
 */
import type { SessionProjectionBaseline, SessionSummary } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionStatsProjection } from '@deepseek-ai/dsh-session-stats'
import type {} from '@deepseek-ai/dsh-token-meter'
import { ui, type MayflyField, type MayflyInlineSpan, type MayflyListItem, type MayflyTone, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type {} from '../conversation/types.ts'
import type { MayflyTranslate } from '../frontend/index.ts'
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
  /** Header creation time; absent when the header listing is unavailable. */
  readonly createdAt?: number
  /** Latest human prompt, settled turn, or — while running — the listing time. */
  readonly lastActiveAt?: number
  readonly running: boolean
  readonly archived: boolean
  readonly current: boolean
  readonly reminders: boolean
  readonly parentId?: string
  readonly origin?: 'subagent'
  readonly preset?: string
  /** Cumulative provider usage; absent when the listing carries no cached value. */
  readonly tokens?: TokenBuckets
  /** Whole-log turn/step counts and model/tool times, when cached. */
  readonly stats?: SessionStatsProjection
  readonly model?: { readonly provider: string, readonly model: string, readonly reasoningEffort?: string }
}

/** Listing-time context the summary itself does not carry. */
export interface SessionListContext {
  readonly header?: SessionHeader | undefined
  readonly title?: string | null | undefined
  readonly projections?: SessionProjectionBaseline | undefined
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
 * @param context - header, archive, current-session, and time context.
 * @returns the display facts.
 */
export function sessionListFacts(summary: SessionSummary, context: SessionListContext): SessionListFacts {
  const values = context.projections?.values ?? summary.projections?.values
  const title = (context.projections?.values.title !== undefined
    ? context.projections.values.title
    : context.title === undefined ? values?.title : context.title)?.trim()
  // Native updatedAt falls back to creation on a cache miss. Only a later
  // value establishes activity independently of the optional metadata cell.
  const promptedAt = values?.sessionListMetadata?.lastPromptAt
    ?? (context.header !== undefined && summary.updatedAt > context.header.createdAt ? summary.updatedAt : 0)
  const usage = values?.tokenUsage
  const model = values?.modelSelection?.lastUsed ?? values?.modelSelection?.next ?? undefined
  const settledAt = values?.mayflyConversationFacts?.endedAt ?? 0
  const cwd = summary.cwd ?? context.header?.cwd
  return {
    id: String(summary.sessionId),
    ...(title === undefined || title === '' ? {} : { title }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(context.header === undefined ? {} : { createdAt: context.header.createdAt }),
    ...(context.header?.agentPreset === undefined ? {} : { preset: context.header.agentPreset }),
    ...(!summary.running && promptedAt === 0 && settledAt === 0 ? {} : {
      lastActiveAt: Math.max(promptedAt, settledAt, summary.running ? context.now : 0),
    }),
    running: summary.running,
    archived: context.archived,
    current: context.current,
    reminders: context.reminders?.has(String(summary.sessionId)) ?? false,
    ...(summary.parentSessionId === undefined ? {} : { parentId: String(summary.parentSessionId) }),
    ...(summary.origin === undefined ? {} : { origin: summary.origin }),
    ...(usage === undefined ? {} : { tokens: { input: usage.uncachedInputTokens, cacheRead: usage.cacheReadTokens, cacheWrite: usage.cacheWriteTokens, output: usage.outputTokens } }),
    ...(values?.sessionStats === undefined ? {} : { stats: values.sessionStats }),
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
 * Wall-clock span from creation to the last activity.
 * @param facts - the session display facts.
 * @returns the span in milliseconds, or `undefined` without a creation time.
 */
export function sessionSpan(facts: SessionListFacts): number | undefined {
  return facts.createdAt === undefined || facts.lastActiveAt === undefined ? undefined : Math.max(0, facts.lastActiveAt - facts.createdAt)
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
 * One `/sessions` list row. The detail spans lead with the span and token
 * total, then the relative age and the home-shortened path, so a narrow row
 * cuts the path first; filtering also matches the id and the full path.
 * @param facts - the session display facts.
 * @param now - the listing time.
 * @param home - the home directory for path shortening.
 * @param t - interaction translator.
 * @returns the list item.
 */
export function sessionListItem(facts: SessionListFacts, now: number, home: string, t: MayflyTranslate): MayflyListItem {
  const segments: MayflyInlineSpan[] = []
  const span = sessionSpan(facts)
  const tokens = facts.tokens === undefined ? 0 : totalTokens(facts.tokens)
  if (span !== undefined) segments.push({ text: formatDuration(span) })
  if (tokens > 0) segments.push({ text: `${formatTokens(tokens)} tok` })
  if (facts.lastActiveAt !== undefined) segments.push({ text: formatAgo(now - facts.lastActiveAt, t), tone: 'muted' })
  else if (facts.createdAt !== undefined) segments.push({ text: `${t('Created')} ${formatAgo(now - facts.createdAt, t)}`, tone: 'muted' })
  if (facts.cwd !== undefined) segments.push({ text: shortenCwd(facts.cwd, home), tone: 'muted' })
  const badges = [
    ...(facts.current ? [t('current')] : []),
    ...(facts.running ? [t('running')] : []),
    ...(facts.archived ? [t('archived')] : []),
    ...(facts.reminders ? [t('Reminders')] : []),
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
  const span = sessionSpan(facts)
  const status = [
    t(facts.running ? 'running' : 'inactive'),
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
    field(t('Created'), facts.createdAt === undefined ? unknown : formatCreated(facts.createdAt)),
    field(t('Last active'), facts.lastActiveAt === undefined ? unknown : `${formatCreated(facts.lastActiveAt)} (${formatAgo(now - facts.lastActiveAt, t)})`),
    field(t('Duration'), span === undefined ? unknown : formatDuration(span)),
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
