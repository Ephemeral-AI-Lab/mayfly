/**
 * The marketplace's read-only facts: how each indexed entry (and each installed bundle the index does not list) relates
 * to the profile, which tab holds it, how rows are grouped, and what a filter can match. Installation state comes from
 * `ctx.pluginManager.listBundles()`; the market index is discovery and display metadata only. Pure functions of the
 * index and the native bundle list: no service, no text, no node, and no profile write.
 *
 * @module @ephemeral-ai/mayfly/interaction/plugin-market/model
 */

import semver from 'semver'
import type { BundleInfo } from '@deepseek-ai/dsh-plugin-manager'
import type { MarketEntry, MarketInstallRow } from './types.ts'

/** The panel's tabs: what is installed, what needs attention, what can be added. */
export type MarketTab = 'installed' | 'updates' | 'browse'
export const MARKET_TABS: readonly MarketTab[] = ['installed', 'updates', 'browse']

/** How a tab's rows are grouped under headings (`g` cycles them). */
export type GroupMode = 'category' | 'source' | 'none'
export const GROUP_MODES: readonly GroupMode[] = ['category', 'source', 'none']

/** The one word that says what a row asks of the user. */
export type RowState = 'installed' | 'update' | 'repair' | 'available' | 'deprecated' | 'removed' | 'unlisted'

/** The group an installed bundle the index does not list sits in. */
export const UNLISTED_GROUP = 'unlisted'

/** Which remote a catalog row installs from. */
export type InstallSource = 'npm' | 'github'

/**
 * The pnpm spec for one catalog row from one source. GitHub rows compose the
 * `github:<repo>#<ref>[&path:<subdir>]` grammar the marketplace verified.
 * A row without the requested source has no spec.
 */
export function rowSpec(row: MarketInstallRow, source: InstallSource): string | undefined {
  if (source === 'npm') return row.npm?.spec
  const github = row.github
  if (github === undefined) return undefined
  return `github:${github.repo}#${github.ref}${github.subdir === undefined ? '' : `&path:${github.subdir}`}`
}

/** Whether every row of an entry is installable from the given source. */
export function entrySupportsSource(entry: MarketEntry, source: InstallSource): boolean {
  return entry.install.rows.length > 0 && entry.install.rows.every(row => rowSpec(row, source) !== undefined)
}

/** The preferred source that can install every row, npm first. */
export function defaultInstallSource(entry: MarketEntry): InstallSource | undefined {
  if (entrySupportsSource(entry, 'npm')) return 'npm'
  if (entrySupportsSource(entry, 'github')) return 'github'
  return undefined
}

/** Packages that own a whole automation profile rather than joining a TUI. */
const DEDICATED_PROFILE_PACKAGES = new Set(['@deepseek-ai/dsh-acp'])

/** Why an entry cannot be activated inside the current Mayfly profile. */
export function currentProfileInstallBlock(entry: MarketEntry): string | undefined {
  if (!entry.install.rows.some(row => DEDICATED_PROFILE_PACKAGES.has(row.name))) return undefined
  return 'automation-only ACP server owns stdio; install it in a dedicated non-Mayfly profile'
}

/** Why the marketplace entry cannot be installed from the current catalog. */
export function marketEntryInstallBlock(entry: MarketEntry): string | undefined {
  if (entry.status === 'removed') {
    return `"${entry.displayName}" was removed from the marketplace${entry.statusNote === undefined ? '' : `: ${entry.statusNote}`}`
  }
  return currentProfileInstallBlock(entry)
}

/** The bundle that ships Mayfly itself; `/plugin` never lists or manages it. */
export const MAYFLY_PACKAGE = '@ephemeral-ai/mayfly'

export interface MarketRow {
  /** The entry id, or `unlisted:<package>` for a bundle the index does not list. */
  readonly id: string
  readonly entry?: MarketEntry
  /** The native bundle a package row resolved to, when the manager lists one. */
  readonly bundle?: BundleInfo
  readonly state: RowState
  /** At least one package of the entry is installed in the profile. */
  readonly installed: boolean
  /** Some but not all packages are installed, or an installed bundle is deselected. */
  readonly partial: boolean
  readonly version?: string
  readonly updateVersion?: string
  /** Native selection state of the row's bundle. */
  readonly enabled?: boolean
  /** Native removal availability; false when the manager protects or does not own the bundle. */
  readonly removable?: boolean
}

/** Packages the profile needs to run at all; `/plugin` never lists them as plugins. */
const PROTECTED_PACKAGES = new Set([MAYFLY_PACKAGE, '@ephemeral-ai/mayfly-ui', '@deepseek-ai/dsh-base'])

const SOURCE_ORDER = ['official', 'dsh', 'community'] as const

/** How one marketplace entry relates to the profile's native bundles. */
export interface EntryInstallState {
  /** Every row package is a profile dependency. */
  readonly installed: boolean
  /** Installed version of the first row (display only). */
  readonly version: string | undefined
  /** A newer version is on the registry than the one installed. */
  readonly updateAvailable: boolean
  /** First row version that is newer than its installed counterpart. */
  readonly updateVersion: string | undefined
  /** Every installed row bundle is selected; absent when nothing is installed. */
  readonly enabled: boolean | undefined
  /** Every installed row bundle allows removal. */
  readonly removable: boolean
}

/** The native bundle a package name resolved to, if any. */
function bundleOf(bundles: readonly BundleInfo[], name: string): BundleInfo | undefined {
  return bundles.find(bundle => bundle.name === name)
}

/** The newer version a row can move to: the catalog's registry enrichment, else the native on-demand target. */
export function newerVersion(row: MarketInstallRow, bundle: BundleInfo | undefined, entry: MarketEntry): string | undefined {
  const current = bundle?.version
  const latest = entry.npm?.[row.name]?.latestVersion ?? bundle?.installTarget?.version
  if (current === undefined || latest == null) return undefined
  return semver.valid(latest) !== null && semver.valid(current) !== null && semver.gt(latest, current) ? latest : undefined
}

/**
 * Derive each entry's install state by matching row package names against the native bundles.
 * @param entries - the index entries.
 * @param bundles - the manager's current bundle list.
 * @returns the state per entry id.
 */
export function entryInstallStates(
  entries: readonly MarketEntry[],
  bundles: readonly BundleInfo[],
): Readonly<Record<string, EntryInstallState>> {
  const states: Record<string, EntryInstallState> = {}
  for (const entry of entries) {
    const matched = entry.install.rows.map(row => bundleOf(bundles, row.name))
    const present = matched.filter((bundle): bundle is BundleInfo => bundle?.installed === true)
    const installed = present.length === entry.install.rows.length && present.length > 0
    const version = installed
      ? matched.map(bundle => bundle?.version).find(candidate => candidate !== undefined)
      : undefined
    const updateVersion = installed
      ? entry.install.rows.map((row, index) => newerVersion(row, matched[index], entry)).find((candidate): candidate is string => candidate !== undefined)
      : undefined
    states[entry.id] = {
      installed, version, updateAvailable: updateVersion !== undefined, updateVersion,
      enabled: installed ? present.every(bundle => bundle.enabled) : undefined,
      // A partial install may remove the rows it already carries.
      removable: present.length > 0 && present.every(bundle => bundle.removable),
    }
  }
  return states
}

/**
 * Derive the rows. A removed entry is listed only while the profile still carries it; an installed bundle no entry row
 * names becomes an `unlisted` row.
 * @param entries - the index entries (empty while offline).
 * @param bundles - the native manager's current bundles.
 * @returns the rows in index order, then the unlisted ones.
 */
export function buildRows(entries: readonly MarketEntry[], bundles: readonly BundleInfo[]): readonly MarketRow[] {
  const states = entryInstallStates(entries, bundles)
  const names = new Set(bundles.filter(bundle => bundle.installed).map(bundle => bundle.name))
  const rows: MarketRow[] = []
  const claimed = new Set<string>()
  for (const entry of entries) {
    for (const row of entry.install.rows) claimed.add(row.name)
    const present = entry.install.rows.filter(row => names.has(row.name)).length
    const any = present > 0
    if (entry.status === 'removed' && !any) continue
    const state = states[entry.id]!
    const partial = any && !state.installed
    // A dependency the profile declares but does not select needs a switch-on, not an update.
    const deselected = state.installed && state.enabled === false
    const rowState: RowState = entry.status === 'removed' ? 'removed'
      : entry.status === 'deprecated' ? 'deprecated'
      : !any ? 'available'
      : partial || deselected ? 'repair'
      : state.updateAvailable ? 'update'
      : 'installed'
    const bundle = entry.install.rows.map(row => bundleOf(bundles, row.name)).find(candidate => candidate !== undefined)
    rows.push({
      id: entry.id, entry, ...bundle === undefined ? {} : { bundle }, state: rowState, installed: any, partial,
      ...(state.version === undefined ? {} : { version: state.version }),
      ...(state.updateVersion === undefined ? {} : { updateVersion: state.updateVersion }),
      ...(state.enabled === undefined ? {} : { enabled: state.enabled }),
      removable: state.removable,
    })
  }
  for (const bundle of bundles) {
    if (claimed.has(bundle.name) || PROTECTED_PACKAGES.has(bundle.name) || !bundle.installed) continue
    rows.push({
      id: `${UNLISTED_GROUP}:${bundle.name}`, bundle, state: 'unlisted', installed: true, partial: false,
      ...(bundle.version === undefined ? {} : { version: bundle.version }), enabled: bundle.enabled, removable: bundle.removable,
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
  return row.entry?.displayName ?? row.bundle?.name ?? ''
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

/** One declared engine range, as the catalog supplies it; the native manager owns compatibility, not this display. */
export interface DeclaredEngine {
  readonly engine: 'dsh' | 'mayfly' | 'node'
  readonly range: string
}

/**
 * The entry's declared engine ranges, in display order. These are catalog metadata; the running-version comparison and
 * the compatibility gate belong to `ctx.pluginManager`.
 * @param entry - the entry.
 * @returns one record per declared engine.
 */
export function declaredEngines(entry: MarketEntry): readonly DeclaredEngine[] {
  const engines = entry.engines
  if (engines === undefined) return []
  const declared: DeclaredEngine[] = []
  if (engines.dsh !== undefined) declared.push({ engine: 'dsh', range: engines.dsh })
  if (engines.mayfly !== undefined) declared.push({ engine: 'mayfly', range: engines.mayfly })
  if (engines.node !== undefined) declared.push({ engine: 'node', range: engines.node })
  return declared
}

/** The text a filter matches for a row. */
export function rowSearchText(row: MarketRow): string {
  const entry = row.entry
  if (entry === undefined) {
    const bundle = row.bundle
    return [
      bundle?.name ?? '', bundle?.source ?? '', bundle?.description ?? '',
      ...typeof bundle?.meta?.title === 'string' ? [bundle.meta.title] : [],
      ...typeof bundle?.meta?.description === 'string' ? [bundle.meta.description] : [],
      'state:custom installed',
    ].join(' ')
  }
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
