/**
 * The marketplace's facts: how each indexed entry (and each installed package the index does not list) relates to the
 * profile, which tab holds it, how rows are grouped, what a filter can match, and whether the entry's engine ranges
 * fit the running Mayfly. Pure functions of the index and the profile's dependencies; no service, no text, no node.
 *
 * @module @ephemeral-ai/mayfly/interaction/plugin-market/model
 */

import semver from 'semver'
import { currentProfileInstallBlock, entryInstallStates, type InstalledPlugin } from './installer.ts'
import type { MarketEntry } from './types.ts'

/** The panel's tabs: what is installed, what needs attention, what can be added. */
export type MarketTab = 'installed' | 'updates' | 'browse'
export const MARKET_TABS: readonly MarketTab[] = ['installed', 'updates', 'browse']

/** How a tab's rows are grouped under headings (`g` cycles them). */
export type GroupMode = 'category' | 'source' | 'none'
export const GROUP_MODES: readonly GroupMode[] = ['category', 'source', 'none']

/** The one word that says what a row asks of the user. */
export type RowState = 'installed' | 'update' | 'repair' | 'available' | 'deprecated' | 'removed' | 'unlisted'

/** The group an installed package the index does not list sits in. */
export const UNLISTED_GROUP = 'unlisted'

export interface MarketRow {
  /** The entry id, or `unlisted:<package>` for a package the index does not list. */
  readonly id: string
  readonly entry?: MarketEntry
  /** The package of an unlisted row. */
  readonly plugin?: InstalledPlugin
  readonly state: RowState
  /** At least one package of the entry is a profile dependency. */
  readonly installed: boolean
  /** Some but not all packages are installed. */
  readonly partial: boolean
  readonly version?: string
  readonly updateVersion?: string
}

/** Packages the profile needs to run at all; `/plugin` never lists them as plugins. */
const PROTECTED_PACKAGES = new Set(['@ephemeral-ai/mayfly-ui', '@deepseek-ai/dsh-base'])

const SOURCE_ORDER = ['official', 'dsh', 'community'] as const

/**
 * Derive the rows. A removed entry is listed only while the profile still carries it; an installed package no entry row
 * names becomes an `unlisted` row.
 * @param entries - the index entries (empty while offline).
 * @param installed - the profile's dependencies.
 * @returns the rows in index order, then the unlisted ones.
 */
export function buildRows(entries: readonly MarketEntry[], installed: readonly InstalledPlugin[]): readonly MarketRow[] {
  const states = entryInstallStates(entries, installed)
  const names = new Set(installed.map(plugin => plugin.name))
  const rows: MarketRow[] = []
  const claimed = new Set<string>()
  for (const entry of entries) {
    for (const row of entry.install.rows) claimed.add(row.name)
    const present = entry.install.rows.filter(row => names.has(row.name)).length
    const any = present > 0
    if (entry.status === 'removed' && !any) continue
    const state = states[entry.id]!
    const partial = any && !state.installed
    const rowState: RowState = entry.status === 'removed' ? 'removed'
      : entry.status === 'deprecated' ? 'deprecated'
      : !any ? 'available'
      : partial ? 'repair'
      : state.updateAvailable ? 'update'
      : 'installed'
    rows.push({
      id: entry.id, entry, state: rowState, installed: any, partial,
      ...(state.version === undefined ? {} : { version: state.version }),
      ...(state.updateVersion === undefined ? {} : { updateVersion: state.updateVersion }),
    })
  }
  for (const plugin of installed) {
    if (claimed.has(plugin.name) || PROTECTED_PACKAGES.has(plugin.name)) continue
    rows.push({
      id: `${UNLISTED_GROUP}:${plugin.name}`, plugin, state: 'unlisted', installed: true, partial: false,
      ...(plugin.version === undefined ? {} : { version: plugin.version }),
    })
  }
  return rows
}

/** Whether a row belongs to a tab. Updates is the inbox: installed rows that ask for an update, repair, or a decision. */
export function inTab(row: MarketRow, tab: MarketTab): boolean {
  if (tab === 'browse') return !row.installed
  if (tab === 'installed') return row.installed
  return row.installed && row.state !== 'installed' && row.state !== 'unlisted'
}

/** The rows of one tab. */
export function tabRows(rows: readonly MarketRow[], tab: MarketTab): readonly MarketRow[] {
  return rows.filter(row => inTab(row, tab))
}

/** The display name of a row. */
export function rowName(row: MarketRow): string {
  return row.entry?.displayName ?? row.plugin!.name
}

/**
 * The group key of a row under a mode, or `undefined` for `none`. Unlisted rows always sit in their own last group.
 * @param row - the row.
 * @param mode - the grouping.
 * @returns the key: a category, a source, a status, or {@link UNLISTED_GROUP}.
 */
export function groupKey(row: MarketRow, mode: GroupMode): string | undefined {
  if (row.entry === undefined) return UNLISTED_GROUP
  if (mode === 'none') return undefined
  return mode === 'category' ? row.entry.category.toLowerCase() : row.entry.source
}

function groupRank(key: string | undefined, mode: GroupMode): number {
  if (key === undefined) return 0
  if (key === UNLISTED_GROUP) return Number.MAX_SAFE_INTEGER
  if (mode === 'source') return SOURCE_ORDER.indexOf(key as typeof SOURCE_ORDER[number])
  return 0
}

/**
 * Order rows so that rows of one group are contiguous (a list heading appears when the group changes): groups by rank
 * and then by key, rows by name inside.
 * @param rows - the rows of one tab.
 * @param mode - the grouping.
 * @returns the rows, ordered.
 */
export function groupRows(rows: readonly MarketRow[], mode: GroupMode): readonly MarketRow[] {
  return [...rows].sort((a, b) => {
    const ka = groupKey(a, mode)
    const kb = groupKey(b, mode)
    const byRank = groupRank(ka, mode) - groupRank(kb, mode)
    if (byRank !== 0) return byRank
    if (ka !== kb) return (ka ?? '') < (kb ?? '') ? -1 : 1
    return rowName(a).localeCompare(rowName(b))
  })
}

/** Which frontends the entry contributes to. */
export interface SurfaceFlags {
  readonly tui: boolean
  readonly web: boolean
  readonly server: boolean
  /** An automation-only entry: it owns stdio and cannot join a Mayfly profile. */
  readonly automation: boolean
}

/** The surfaces an entry declares. */
export function surfaceFlags(entry: MarketEntry): SurfaceFlags {
  return {
    tui: entry.surfaces.tui !== undefined,
    web: entry.surfaces.web !== undefined,
    server: entry.surfaces.server !== undefined,
    automation: currentProfileInstallBlock(entry) !== undefined,
  }
}

/** Whether the entry contributes anything to this terminal frontend. */
export function usefulInTui(entry: MarketEntry): boolean {
  return currentProfileInstallBlock(entry) === undefined && (entry.surfaces.server !== undefined || entry.surfaces.tui !== undefined)
}

/** Whether the entry contributes anything to dsh Web. */
export function usefulOnWeb(entry: MarketEntry): boolean {
  return currentProfileInstallBlock(entry) === undefined && (entry.surfaces.web !== undefined || entry.surfaces.server !== undefined)
}

/** The versions the running process offers an `engines` range to compare with. */
export interface RuntimeVersions {
  readonly mayfly: string
  readonly node: string
}

export interface EngineCheck {
  readonly engine: 'dsh' | 'mayfly' | 'node'
  readonly range: string
  /** `true` fits, `false` does not, `undefined` when the range is not checked (dsh) or does not parse. */
  readonly fits: boolean | undefined
}

/**
 * Compare an entry's `engines` ranges with the running Mayfly and Node. The dsh range is shown unchecked: the harness
 * line is not a runtime fact the panel reads.
 * @param entry - the entry.
 * @param versions - the running versions.
 * @returns one check per declared engine.
 */
export function engineChecks(entry: MarketEntry, versions: RuntimeVersions): readonly EngineCheck[] {
  const engines = entry.engines
  if (engines === undefined) return []
  const fit = (range: string, version: string): boolean | undefined => {
    if (semver.validRange(range) === null) return undefined
    return semver.satisfies(version, range, { includePrerelease: true })
  }
  const checks: EngineCheck[] = []
  if (engines.dsh !== undefined) checks.push({ engine: 'dsh', range: engines.dsh, fits: undefined })
  if (engines.mayfly !== undefined) checks.push({ engine: 'mayfly', range: engines.mayfly, fits: fit(engines.mayfly, versions.mayfly) })
  if (engines.node !== undefined) checks.push({ engine: 'node', range: engines.node, fits: fit(engines.node, versions.node) })
  return checks
}

/** Whether a declared engine range excludes the running version. */
export function incompatible(entry: MarketEntry, versions: RuntimeVersions): boolean {
  return engineChecks(entry, versions).some(check => check.fits === false)
}

/**
 * The text a filter matches for a row: the names, both descriptions, the author, what it provides, and the facet tokens
 * `source:` `cat:` `status:` `surface:` `needs:` `kind:` `state:`, so `source:official cat:tools` narrows by facet.
 * @param row - the row.
 * @returns the lower-case-insensitive haystack.
 */
export function rowSearchText(row: MarketRow): string {
  const entry = row.entry
  if (entry === undefined) return `${row.plugin!.name} ${row.plugin!.spec} state:custom installed`
  const surfaces = surfaceFlags(entry)
  const tokens = [
    `source:${entry.source}`, `cat:${entry.category}`, `status:${entry.status}`, `state:${row.state}`,
    ...usefulInTui(entry) ? ['surface:tui'] : [],
    ...usefulOnWeb(entry) ? ['surface:web'] : [],
    ...surfaces.server ? ['surface:server'] : [],
    ...entry.capabilities?.map(need => `needs:${need}`) ?? [],
    ...(entry.provides?.tools?.length ?? 0) > 0 ? ['kind:tool'] : [],
    ...(entry.provides?.commands?.length ?? 0) > 0 ? ['kind:command'] : [],
    ...row.installed ? ['installed'] : [],
  ]
  return [
    entry.displayName, entry.id, entry.description, entry.descriptionZh ?? '', entry.author.name, entry.category,
    ...entry.provides?.tools ?? [], ...entry.provides?.commands ?? [], ...tokens,
  ].join(' ')
}

/**
 * A stand-in entry for an installed package the index does not list, so the installer's removal path can act on it.
 * @param plugin - the installed package.
 * @returns an entry whose only install row is the package.
 */
export function unlistedEntry(plugin: InstalledPlugin): MarketEntry {
  return {
    id: `${UNLISTED_GROUP}:${plugin.name}`, source: 'community', displayName: plugin.name, description: plugin.spec,
    author: { name: plugin.name }, category: UNLISTED_GROUP, status: 'stable', surfaces: { server: {} },
    install: { rows: [{ name: plugin.name, npm: { spec: plugin.spec } }] },
  }
}
