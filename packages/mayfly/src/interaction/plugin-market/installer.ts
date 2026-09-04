/**
 * The plugin-market installer: everything that touches the profile. Install
 * and removal shell out to `dsh plugin --profile <name> add|remove <specs>`
 * (which forwards verbatim to pnpm) exactly like the updater's swap does;
 * `profile-patch` rows additionally append to — and remove from — the
 * profile's `cordis.patch.yml`, and declared `allowBuilds` names are merged
 * into the profile's `pnpm-workspace.yaml` before pnpm runs. Installed-state
 * reads parse the profile `package.json` the same way the updater does.
 *
 * @module @ephemeral-ai/mayfly/interaction/plugin-market/installer
 */

import { join } from 'node:path'
import { updaterInternals, type SpawnOutcome } from '../updater/io.ts'
import type { MarketEntry, MarketInstallRow } from './types.ts'

/** Install ceiling, matching the updater's install timeout. */
const INSTALL_TIMEOUT_MS = 1_200_000

/** One plugin the profile actually carries. */
export interface InstalledPlugin {
  /** Runtime package name. */
  readonly name: string
  /** The dependency spec in the profile manifest. */
  readonly spec: string
  /** Installed version from node_modules, when resolvable. */
  readonly version: string | undefined
}

/** Which remote a spec should come from. */
export type InstallSource = 'npm' | 'github'

/**
 * The pnpm spec for one row from one source. GitHub rows compose the
 * `github:<repo>#<ref>[&path:<subdir>]` grammar the marketplace verified.
 * A row without the requested source has no spec.
 */
export function rowSpec(row: MarketInstallRow, source: InstallSource): string | undefined {
  if (source === 'npm') return row.npm?.spec
  const github = row.github
  if (github === undefined) return undefined
  return `github:${github.repo}#${github.ref}${github.subdir === undefined ? '' : `&path:${github.subdir}`}`
}

/** Whether an entry is installable from the given source at all. */
export function entrySupportsSource(entry: MarketEntry, source: InstallSource): boolean {
  return entry.install.rows.some(row => rowSpec(row, source) !== undefined)
}

/** The pnpm error signature the allowBuilds hint keys on. */
const ALLOW_BUILDS_HINT = 'allowBuilds'

/** Render a spawn failure with the allowBuilds follow-up when pnpm raised it. */
function describeFailure(target: string, outcome: SpawnOutcome): string {
  const tail = [outcome.stdout, outcome.stderr].join('\n').split('\n').filter(line => line.trim() !== '').slice(-4).join(' | ')
  const hint = tail.includes(ALLOW_BUILDS_HINT)
    ? ' — pnpm blocked a build script; add the package to allowBuilds in the profile pnpm-workspace.yaml and retry'
    : ''
  if (outcome.spawnError !== undefined) return `${target} failed to start: ${outcome.spawnError}`
  if (outcome.timedOut) return `${target} timed out`
  return `${target} failed: ${tail}${hint}`
}

/**
 * Merge the entry's `allowBuilds` names into the profile workspace file so
 * pnpm may run exactly those build scripts (native addons). Idempotent.
 */
function ensureAllowBuilds(root: string, names: readonly string[]): void {
  if (names.length === 0) return
  const path = join(root, 'pnpm-workspace.yaml')
  const existing = updaterInternals.readTextFile(path) ?? ''
  const missing = names.filter(name =>
    !new RegExp(`^\\s*"?(?:${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})"?\\s*:\\s*true\\s*$`, 'm').test(existing))
  if (missing.length === 0) return
  let block = existing.length > 0 && !existing.endsWith('\n') ? `${existing}\n` : existing
  if (!/^allowBuilds:/m.test(existing)) block += 'allowBuilds:\n'
  for (const name of missing) block += `  ${JSON.stringify(name)}: true\n`
  updaterInternals.writeTextFile(path, block)
}

/** Render one `- id: … name: …` block for the profile patch. */
function renderPatchRow(row: MarketInstallRow): string {
  const id = row.id ?? row.name
  const config = row.config === undefined ? '' : `  config:\n${Object.entries(row.config)
    .map(([key, value]) => `    ${key}: ${JSON.stringify(value)}`).join('\n')}\n`
  return `- id: ${id}\n  name: ${JSON.stringify(row.name)}\n${config}`
}

/**
 * Append the entry's `profile-patch` rows to the profile's user patch layer.
 * The file is a top-level YAML sequence (dsh writes an empty one on profile
 * init), so an `[]` body is replaced and anything else gains blocks at the
 * end.
 */
function appendProfilePatchRows(root: string, rows: readonly MarketInstallRow[]): void {
  if (rows.length === 0) return
  const path = join(root, 'cordis.patch.yml')
  const existing = updaterInternals.readTextFile(path) ?? ''
  const body = existing.trim() === '[]' || existing.trim() === ''
    ? `${existing.replace(/\[\]\s*$/, '').trimEnd()}\n`
    : existing.endsWith('\n') ? existing : `${existing}\n`
  updaterInternals.writeTextFile(path, body + rows.map(renderPatchRow).join(''))
}

/** Strip either YAML quoting style from a scalar so hand-written single
 * quotes and the installer's JSON double quotes compare equal. */
function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"')))) {
    return value.slice(1, -1)
  }
  return value
}

/** Remove this entry's `profile-patch` blocks from the user patch layer. */
function removeProfilePatchRows(root: string, rows: readonly MarketInstallRow[]): void {
  /* v8 ignore next -- the manifest schema guarantees at least one row */
  if (rows.length === 0) return
  const path = join(root, 'cordis.patch.yml')
  const existing = updaterInternals.readTextFile(path)
  if (existing === undefined) return
  const names = new Set(rows.map(row => row.name))
  // Blocks start at a `- ` line and run to the next one; a block is ours when
  // any of its lines names one of our packages.
  const lines = existing.split('\n')
  const kept: string[] = []
  let block: string[] = []
  const flush = (): void => {
    if (block.length === 0) return
    const isOurs = block.some(line => {
      const quoted = line.match(/name:\s*(.+?)\s*$/)?.[1]
      return quoted !== undefined && names.has(unquote(quoted))
    })
    if (!isOurs) kept.push(...block)
    block = []
  }
  for (const line of lines) {
    if (/^-\s/.test(line)) flush()
    block.push(line)
  }
  flush()
  updaterInternals.writeTextFile(path, kept.join('\n'))
}

/** The outcome of an install or removal. */
export type InstallOutcome =
  | { readonly kind: 'success' }
  | { readonly kind: 'error', readonly text: string }

/** Everything an install or removal needs to run. */
export interface InstallerInput {
  /** The dsh CLI binary (`findDshBin()`). */
  readonly dshBin: string
  /** The profile name the launcher runs under. */
  readonly profile: string
  /** The profile workspace root. */
  readonly root: string
  /** The marketplace entry. */
  readonly entry: MarketEntry
  /** Which remote specs come from. */
  readonly source: InstallSource
}

/**
 * Install one entry: allowBuilds first, then one `dsh plugin add` carrying
 * every row's spec together (sibling rows satisfy each other's peers), then
 * the `profile-patch` rows into the user patch layer.
 */
export async function installEntry(input: InstallerInput): Promise<InstallOutcome> {
  const rows = input.entry.install.rows
  const specs = rows.map(row => rowSpec(row, input.source)).filter((spec): spec is string => spec !== undefined)
  if (specs.length === 0) {
    return { kind: 'error', text: `"${input.entry.displayName}" has no ${input.source} install source` }
  }
  ensureAllowBuilds(input.root, input.entry.install.allowBuilds ?? [])
  const outcome = await updaterInternals.spawnOnce(input.dshBin,
    ['plugin', '--profile', input.profile, 'add', ...specs],
    { cwd: input.root, timeoutMs: INSTALL_TIMEOUT_MS })
  if (outcome.code !== 0) {
    return { kind: 'error', text: describeFailure(`installing "${input.entry.displayName}"`, outcome) }
  }
  appendProfilePatchRows(input.root, rows.filter(row => row.activation === 'profile-patch'))
  return { kind: 'success' }
}

/** Remove one entry: one `dsh plugin remove` for every row name, then the
 * installer-written patch rows leave the user layer with it. */
export async function uninstallEntry(input: InstallerInput): Promise<InstallOutcome> {
  const names = input.entry.install.rows.map(row => row.name)
  const outcome = await updaterInternals.spawnOnce(input.dshBin,
    ['plugin', '--profile', input.profile, 'remove', ...names],
    { cwd: input.root, timeoutMs: INSTALL_TIMEOUT_MS })
  if (outcome.code !== 0) {
    return { kind: 'error', text: describeFailure(`removing "${input.entry.displayName}"`, outcome) }
  }
  removeProfilePatchRows(input.root, input.entry.install.rows)
  return { kind: 'success' }
}

/** The bundle that ships Mayfly itself; `/plugin` never manages it. */
export const MAYFLY_PACKAGE = '@ephemeral-ai/mayfly'

/**
 * Read the plugins the profile carries: every dependency of the profile
 * manifest except Mayfly itself, with the installed version from
 * node_modules when present. This is the updater's `readProfileFacts`
 * reading discipline, kept local so `/plugin` owns only its own rows.
 */
export function readInstalledPlugins(root: string): readonly InstalledPlugin[] {
  const manifestText = updaterInternals.readTextFile(join(root, 'package.json'))
  if (manifestText === undefined) return []
  let dependencies: unknown
  try {
    const parsed: unknown = JSON.parse(manifestText)
    if (typeof parsed !== 'object' || parsed === null) return []
    dependencies = (parsed as Record<string, unknown>).dependencies
  } catch {
    return []
  }
  if (typeof dependencies !== 'object' || dependencies === null) return []
  const plugins: InstalledPlugin[] = []
  for (const [name, spec] of Object.entries(dependencies as Record<string, unknown>)) {
    if (name === MAYFLY_PACKAGE || typeof spec !== 'string') continue
    plugins.push({ name, spec, version: readInstalledVersion(join(root, 'node_modules', name, 'package.json')) })
  }
  return plugins
}

/** Read one installed package's version through the fs seam. */
function readInstalledVersion(manifestPath: string): string | undefined {
  const text = updaterInternals.readTextFile(manifestPath)
  if (text === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const version = (parsed as Record<string, unknown>).version
    return typeof version === 'string' ? version : undefined
  } catch {
    return undefined
  }
}

/** How one marketplace entry relates to the profile. */
export interface EntryInstallState {
  /** All of the entry's row packages are profile dependencies. */
  readonly installed: boolean
  /** Installed version of the first row (display only). */
  readonly version: string | undefined
  /** A newer version is on the registry than the one installed. */
  readonly updateAvailable: boolean
}

/**
 * Derive each entry's install state by matching row package names against
 * the profile's dependencies.
 */
export function entryInstallStates(
  entries: readonly MarketEntry[],
  installed: readonly InstalledPlugin[],
): Readonly<Record<string, EntryInstallState>> {
  const byName = new Map(installed.map(plugin => [plugin.name, plugin]))
  const states: Record<string, EntryInstallState> = {}
  for (const entry of entries) {
    const present = entry.install.rows.filter(row => byName.has(row.name))
    const installed = present.length === entry.install.rows.length && present.length > 0
    const version = installed === true
      ? present.map(row => byName.get(row.name)).find(plugin => plugin?.version !== undefined)?.version
      : undefined
    const first = entry.install.rows[0]
    const info = first === undefined ? undefined : entry.npm?.[first.name]
    const updateAvailable = installed === true && info?.latestVersion != null && version !== undefined && version !== info.latestVersion
    states[entry.id] = { installed, version, updateAvailable }
  }
  return states
}
