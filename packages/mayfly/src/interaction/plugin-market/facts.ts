/**
 * Marketplace facts with their texts: turns the model's rows into the final, translated facts the marketplace component
 * draws (rows with their group headings, the tab strip, the detail of one plugin, the availability of each key).
 *
 * @module @ephemeral-ai/mayfly/interaction/plugin-market/facts
 */

import type { MayflyInlineSpan, MayflyTone, MayflyTranslate } from '@ephemeral-ai/mayfly-ui'
import type { MarketplaceRow, MarketplaceTab, PluginDetailFacts } from '../../components/marketplace.ts'
import { currentProfileInstallBlock, defaultInstallSource, entrySupportsSource, marketEntryInstallBlock, rowSpec, type InstallSource } from './installer.ts'
import {
  engineChecks, groupKey, groupRows, rowName, rowSearchText, tabRows, usefulInTui, usefulOnWeb, UNLISTED_GROUP,
  type GroupMode, type MarketRow, type MarketTab, type RuntimeVersions,
} from './model.ts'
import type { MarketEntry } from './types.ts'

/** What the facts need besides the rows. */
export interface FactsEnv {
  readonly t: MayflyTranslate
  readonly locale: 'zh' | 'en'
  readonly versions: RuntimeVersions
}

const CATEGORY_LABELS: Readonly<Record<string, (t: MayflyTranslate) => string>> = {
  tools: t => t('Tools'), ui: t => t('UI'), provider: t => t('Providers'), workflow: t => t('Workflow'),
  testing: t => t('Testing'), integration: t => t('Integration'),
}

/** A category's display name; an unknown one shows its own name capitalized. */
export function categoryLabel(t: MayflyTranslate, key: string): string {
  if (key === UNLISTED_GROUP) return t('Custom')
  return CATEGORY_LABELS[key]?.(t) ?? `${key.slice(0, 1).toUpperCase()}${key.slice(1)}`
}

/** A source tier's word. */
export function sourceLabel(t: MayflyTranslate, source: MarketEntry['source']): string {
  switch (source) {
    case 'official': return t('official')
    case 'dsh': return t('dsh')
    case 'community': return t('community')
  }
}

/** The grouping's name, as the `g` hint shows it. */
export function groupModeLabel(t: MayflyTranslate, mode: GroupMode): string {
  switch (mode) {
    case 'category': return t('category')
    case 'source': return t('source')
    case 'none': return t('none')
  }
}

function groupHeading(env: FactsEnv, key: string, mode: GroupMode, count: number): string {
  const { t } = env
  const name = key === UNLISTED_GROUP ? t('Custom')
    : mode === 'category' ? categoryLabel(t, key)
    : sourceLabel(t, key as MarketEntry['source'])
  return t('{group} · {count}', { group: name, count })
}

/** The description of an entry in the active language. */
export function describeEntry(entry: MarketEntry, locale: 'zh' | 'en'): string {
  return locale === 'zh' && entry.descriptionZh !== undefined ? entry.descriptionZh : entry.description
}

/** Why a key cannot run on a row (absent keys can). The reasons feed the row's `unavailableActions`. */
export function unavailableKeys(t: MayflyTranslate, row: MarketRow): Readonly<Record<string, string>> {
  const entry = row.entry
  const blocked = entry === undefined ? undefined : marketEntryInstallBlock(entry)
  const reasons: Record<string, string> = {}
  if (row.installed) reasons.install = t('Already installed in this profile')
  else if (blocked !== undefined) reasons.install = t(blocked)
  if (!row.installed) reasons.remove = t('Not installed in this profile')
  if (row.state !== 'update' && row.state !== 'repair') reasons.update = row.installed ? t('Nothing to update') : t('Not installed in this profile')
  else if (blocked !== undefined) reasons.update = t(blocked)
  if (row.installed || entry === undefined || !(entrySupportsSource(entry, 'npm') && entrySupportsSource(entry, 'github'))) reasons.source = t('Only one install source')
  return reasons
}

/** The state icon of a row and its tone; a plain row (installed and current, or not installed) has none in the list it is in. An incomplete install shares `↑` with an update: updating completes it. */
const GLYPHS: Readonly<Record<MarketRow['state'], readonly [string, MayflyTone]>> = {
  installed: ['✓', 'success'], update: ['↑', 'warning'], repair: ['↑', 'warning'], deprecated: ['!', 'warning'],
  removed: ['✗', 'danger'], available: ['', 'muted'], unlisted: ['?', 'muted'],
}

/** The state of a row in words, for the detail's first line. */
function stateWords(t: MayflyTranslate, row: MarketRow): string {
  switch (row.state) {
    case 'installed': return ''
    case 'update': return t('Update available')
    case 'repair': return t('Incomplete; update to repair')
    case 'deprecated': return t('Deprecated')
    case 'removed': return t('Removed from the market')
    case 'available': return ''
    case 'unlisted': return t('Custom')
  }
}

/** The icons of the rows in a tab with their meanings, in a fixed order. */
function legendOf(t: MayflyTranslate, rows: readonly MarketRow[]): MarketplaceTab['legend'] {
  const present = new Set(rows.map(row => GLYPHS[row.state][0]))
  const entries: readonly (readonly [string, MayflyTone, string])[] = [
    ['✓', 'success', t('installed')], ['↑', 'warning', t('update')], ['!', 'warning', t('deprecated')],
    ['✗', 'danger', t('removed')], ['?', 'muted', t('custom')],
  ]
  return entries.filter(([glyph]) => present.has(glyph)).map(([glyph, tone, text]) => ({ glyph, tone, text }))
}

/** One row of a list. */
export function rowFacts(env: FactsEnv, row: MarketRow, group: string | undefined): MarketplaceRow {
  const { t } = env
  const entry = row.entry
  const version = row.state === 'update' && row.version !== undefined && row.updateVersion !== undefined ? `${row.version}→${row.updateVersion}`
    : row.version ?? entry?.verified?.packages[0]?.version
  return {
    id: row.id, name: rowName(row), group,
    glyph: GLYPHS[row.state][0], glyphTone: GLYPHS[row.state][1],
    source: entry === undefined ? undefined : sourceLabel(t, entry.source),
    surfaces: entry === undefined ? undefined : [{ letter: 'T', label: 'TUI', on: usefulInTui(entry) }, { letter: 'W', label: 'WEB', on: usefulOnWeb(entry) }],
    version, dim: row.state === 'deprecated' || row.state === 'removed',
    searchText: rowSearchText(row), unavailable: unavailableKeys(t, row),
  }
}

/**
 * One tab: its rows ordered and headed by the grouping, its count, and its empty state.
 * @param env - translator, locale, and running versions.
 * @param all - every row.
 * @param tab - the tab.
 * @param mode - the grouping.
 * @param focus - the cursor restore request, when one is owed.
 * @returns the tab facts.
 */
export function tabFacts(env: FactsEnv, all: readonly MarketRow[], tab: MarketTab, mode: GroupMode, focus: { readonly id: string, readonly rev: number } | undefined): MarketplaceTab {
  const { t } = env
  const rows = groupRows(tabRows(all, tab), mode)
  const counts = new Map<string, number>()
  for (const row of rows) {
    const key = groupKey(row, mode)
    if (key !== undefined) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const label = tab === 'installed' ? t('Installed') : tab === 'updates' ? t('Updates') : t('Browse')
  return {
    id: tab, label, count: rows.length, legend: legendOf(t, rows), attention: tab === 'updates' && rows.length > 0,
    rows: rows.map(row => {
      const key = groupKey(row, mode)
      return rowFacts(env, row, key === undefined ? undefined : groupHeading(env, key, mode, counts.get(key)!))
    }),
    emptyDescription: tab === 'installed' ? t('Switch to Browse with Alt+→ to add one.') : undefined,
    emptyTitle: tab === 'installed' ? t('no plugins installed') : tab === 'updates' ? t('everything is up to date') : t('no plugins available'),
    focus,
  }
}

const span = (text: string, tone?: MayflyTone): MayflyInlineSpan => tone === undefined ? { text } : { text, tone }

/**
 * The detail of one row: what the row does not already say. The surfaces are the row's `T W`, so the detail speaks of
 * them only when they cost something (web-only, automation-only).
 * @param env - translator, locale, and running versions.
 * @param row - the row.
 * @param source - the install source that `i` would use.
 * @returns the detail facts.
 */
export function detailFacts(env: FactsEnv, row: MarketRow, source: InstallSource | undefined): PluginDetailFacts {
  const { t } = env
  const entry = row.entry
  if (entry === undefined) {
    const plugin = row.plugin!
    return {
      title: plugin.name, tagline: [span(`${GLYPHS.unlisted[0]} ${stateWords(t, row)}`, GLYPHS.unlisted[1])], notes: [],
      description: t('Installed in this profile but not listed in the marketplace index.'),
      rows: [{ label: t('Package'), value: [span(plugin.spec, 'accent')] }],
    }
  }
  const block = currentProfileInstallBlock(entry)
  const notes: { text: string, tone: MayflyTone }[] = []
  if (entry.statusNote !== undefined && (entry.status === 'removed' || entry.status === 'deprecated')) notes.push({ text: entry.statusNote, tone: entry.status === 'removed' ? 'danger' : 'warning' })
  if (block !== undefined) notes.push({ text: t(block), tone: 'warning' })
  else if (!usefulInTui(entry)) notes.push({ text: t('web-only plugin: it contributes nothing in this terminal frontend'), tone: 'warning' })
  const tools = entry.provides?.tools ?? []
  const commands = entry.provides?.commands ?? []
  const checks = engineChecks(entry, env.versions)
  const needs = entry.capabilities ?? []
  const supports = [entrySupportsSource(entry, 'npm') ? 'npm' : undefined, entrySupportsSource(entry, 'github') ? 'github' : undefined].filter((value): value is InstallSource => value !== undefined)
  const via = source ?? defaultInstallSource(entry)
  const installCommand = via === undefined || block !== undefined || entry.status === 'removed' ? undefined
    : `dsh plugin --profile <name> add ${entry.install.rows.map(item => rowSpec(item, via)!).join(' ')}`
  return {
    title: entry.displayName,
    tagline: [...stateWords(t, row) === '' ? [] : [span(`${GLYPHS[row.state][0]} ${stateWords(t, row)}`, GLYPHS[row.state][1]), span(' · ')], span(categoryLabel(t, entry.category.toLowerCase()))],
    notes,
    description: describeEntry(entry, env.locale),
    rows: [
      ...tools.length === 0 ? [] : [{ label: t('Tools'), value: [span(tools.join(' · '))] }],
      ...commands.length === 0 ? [] : [{ label: t('Commands'), value: [span(commands.join(' · '))] }],
      ...needs.length === 0 ? [] : [{ label: t('Needs'), value: [span(needs.join(' · '))] }],
      ...checks.length === 0 ? [] : [{ label: t('Engines'), value: checks.flatMap((check, index): MayflyInlineSpan[] => [
        ...index === 0 ? [] : [span(' · ')],
        span(t('{engine} {range}', { engine: check.engine, range: check.range })),
        ...check.fits === undefined ? [] : [check.fits ? span(' ✓', 'success') : span(` ✗ ${t('running {version}', { version: check.engine === 'node' ? env.versions.node : env.versions.mayfly })}`, 'warning')],
      ]) }],
      ...supports.length < 2 || row.installed || via === undefined ? [] : [{ label: t('Install via'), value: [span(via, 'accent'), span(` · ${t('press s for {other}', { other: supports.find(item => item !== via)! })}`, 'muted')] }],
      { label: t('Author'), value: [span(entry.license === undefined ? entry.author.name : `${entry.author.name} · ${entry.license}`)] },
      ...entry.links?.repo === undefined ? [] : [{ label: t('Links'), value: [span(entry.links.repo, 'accent')] }],
      ...installCommand === undefined ? [] : [{ label: t('Install command'), value: [span(installCommand, 'accent')] }],
    ],
  }
}
