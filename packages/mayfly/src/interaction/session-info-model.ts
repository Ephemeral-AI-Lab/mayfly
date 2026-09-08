/** Readonly session facts projected into shared fields, progress, and charts.
 * @module @ephemeral-ai/mayfly/interaction/session-info-model
 */
import { ui, type MayflyField, type MayflyTone, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyTranslate } from '../frontend/index.ts'
import type { ChangelogEntry } from './changelog-content.ts'
import { MAYFLY_VERSION } from '../transcript/banner-content.ts'
import { formatTokens, usagePercent, usageRatio, ratioSeverity, totalTokens, type UsageFacts, type CompositionFacts } from './usage.ts'

export interface VersionFacts { readonly mayfly: string, readonly harness: string }
export interface SessionInfoFacts {
  readonly id: string
  readonly cwd?: string
  readonly createdAt: number
  readonly status: string
  readonly turns: number
  readonly steps: number
  readonly model?: { readonly provider: string, readonly model: string, readonly reasoningEffort?: string }
  readonly usage: UsageFacts
  readonly composition?: CompositionFacts
}

export function formatCreated(createdAt: number): string {
  const date = new Date(createdAt)
  return `${Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 16).replace('T', ' ') : 'unknown'} UTC`
}

function field(label: string, value: string, tone: MayflyTone = 'default'): MayflyField { return { label, value: [{ text: value, tone }] } }

function tokenInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined
  return Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(value))
}

export function versionNode(version: VersionFacts): MayflyUiNode {
  return ui.fields([field('Mayfly', `v${version.mayfly}`), field('Harness', version.harness)])
}

export function changelogNode(entries: readonly ChangelogEntry[], t: MayflyTranslate): MayflyUiNode {
  return ui.stack.column(entries.flatMap(entry => [
    ui.divider({ label: `v${entry.version}${entry.version === MAYFLY_VERSION ? ` · ${t('current')}` : ''}` }),
    ui.text(entry.summary),
    ui.fields([
      ...entry.highlights.map(text => field(t('Highlights'), text)),
      ...entry.knownIssues.map(text => field(t('Known issues'), text, 'warning')),
    ]),
  ]))
}

export function contextNode(facts: UsageFacts['context'], t: MayflyTranslate): MayflyUiNode {
  const window = tokenInteger(facts.window)
  if (window === undefined || window <= 0) return ui.text(t('not advertised for the current model'), { tone: 'muted' })
  const used = tokenInteger(facts.used)
  if (used === undefined) return ui.text(t('no request has reported usage yet'), { tone: 'muted' })
  const occupied = Math.min(used, window)
  const ratio = usageRatio(used, window)
  const severity = ratioSeverity(ratio)
  return ui.stack.column([
    ui.progress({ value: occupied, max: window }),
    ui.fields([field(t('Context window'), `${formatTokens(used)} / ${formatTokens(window)} (${usagePercent(used, window)}%)`, severity === 'danger' ? 'danger' : severity === 'warn' ? 'warning' : 'success')]),
  ])
}

export function statusNode(facts: SessionInfoFacts, version: VersionFacts, t: MayflyTranslate): MayflyUiNode {
  return ui.stack.column([
    ui.divider({ label: t('Session') }),
    ui.fields([
      field('ID', facts.id), field(t('Working directory'), facts.cwd ?? t('(unknown)')),
      field(t('Created'), formatCreated(facts.createdAt)), field(t('Agent'), t(facts.status)),
      field(t('Turns'), String(facts.turns)), field(t('Steps'), String(facts.steps)),
    ]),
    ui.divider({ label: t('Model') }),
    ui.fields([
      field(t('Model'), facts.model === undefined ? t('not set') : `${facts.model.model} (${facts.model.provider})`),
      ...facts.model?.reasoningEffort === undefined ? [] : [field(t('Thinking effort'), facts.model.reasoningEffort)],
    ]),
    contextNode(facts.usage.context, t),
    ui.divider({ label: t('Version') }), versionNode(version),
  ])
}

export function usageNode(facts: SessionInfoFacts, t: MayflyTranslate): MayflyUiNode {
  const { buckets, context } = facts.usage
  const total = totalTokens(buckets)
  const contextWindow = tokenInteger(context.window)
  const parts = facts.composition === undefined ? [] : [
    { id: 'system', label: t('System prompt'), tokens: tokenInteger(facts.composition.system) ?? 0, tone: 'muted' as const },
    { id: 'tools', label: t('Tools'), tokens: tokenInteger(facts.composition.tools) ?? 0, tone: 'primary' as const },
    { id: 'messages', label: t('Messages'), tokens: tokenInteger(facts.composition.messages) ?? 0, tone: 'accent' as const },
  ]
  if (parts.length > 0 && contextWindow !== undefined) parts.push({ id: 'free', label: t('Estimated free space'), tokens: Math.max(0, contextWindow - parts.reduce((sum, part) => sum + part.tokens, 0)), tone: 'muted' })
  return ui.stack.column([
    contextNode(context, t),
    ui.divider({ label: t('Session usage') }),
    total === 0 ? ui.text(t('no provider usage recorded yet'), { tone: 'muted' }) : ui.fields([
      field(t('Input'), formatTokens(buckets.input)), field(t('Cache read'), formatTokens(buckets.cacheRead)),
      field(t('Cache write'), formatTokens(buckets.cacheWrite)), field(t('Output'), formatTokens(buckets.output)), field(t('Total'), formatTokens(total)),
    ]),
    ...parts.length === 0 ? [] : [
      ui.divider({ label: t('Context usage (heuristic)') }),
      ui.chart({ chart: 'bar', layout: 'stacked', categories: [t('Estimated usage by category')], series: parts.map(part => ({ id: part.id, label: part.label, tone: part.tone, values: [part.tokens] })) }),
      ui.fields(parts.map(part => field(part.label, `${formatTokens(part.tokens)}${contextWindow === undefined || contextWindow <= 0 ? '' : ` (${Math.min(100, Math.max(0, part.tokens / contextWindow * 100)).toFixed(1)}%)`}`, part.tone))),
    ],
  ])
}
