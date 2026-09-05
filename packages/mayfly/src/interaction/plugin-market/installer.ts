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
import { isMap, isSeq, parseDocument, type YAMLMap } from 'yaml'
import { updaterInternals, type SpawnOutcome } from '../updater/io.ts'
import { compareVersions } from '../updater/version.ts'
import type { MarketEntry, MarketInstallRow } from './types.ts'

/** Install ceiling, matching the updater's install timeout. */
const INSTALL_TIMEOUT_MS = 1_200_000
/** Fresh-process import ceiling for the newly installed entry points. */
const IMPORT_TIMEOUT_MS = 30_000
/** Profile files restored when a new plugin fails its compatibility check. */
const TRANSACTION_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml'] as const

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

/** Text for filesystem and YAML failures. */
function errorText(error: unknown): string {
  /* v8 ignore next -- the default filesystem and YAML seams throw Error instances */
  return error instanceof Error ? error.message : String(error)
}

/**
 * Merge the entry's `allowBuilds` names into the profile workspace file so
 * pnpm may run exactly those build scripts (native addons). Idempotent.
 */
function ensureAllowBuilds(root: string, names: readonly string[]): void {
  if (names.length === 0) return
  const path = join(root, 'pnpm-workspace.yaml')
  const existing = updaterInternals.readTextFile(path)
  const doc = parseDocument(existing?.trim() === '' || existing === undefined ? '{}\n' : existing)
  if (doc.errors.length > 0 || !isMap(doc.contents)) {
    throw new Error(`pnpm-workspace.yaml must be a YAML mapping: ${doc.errors[0]?.message ?? 'found another document shape'}`)
  }
  const allowBuilds = doc.get('allowBuilds', true)
  if (allowBuilds !== undefined && !isMap(allowBuilds)) {
    throw new Error('pnpm-workspace.yaml allowBuilds must be a mapping')
  }
  let changed = false
  for (const name of names) {
    if (doc.getIn(['allowBuilds', name]) === true) continue
    doc.setIn(['allowBuilds', name], true)
    changed = true
  }
  if (changed) {
    doc.contents.flow = false
    updaterInternals.writeTextFile(path, String(doc))
  }
}

/** A validated user-patch edit, applied only after the package operation. */
interface PatchEdit {
  readonly path: string
  readonly text: string
}

interface FileSnapshot {
  readonly path: string
  readonly text: string | undefined
}

/** Capture the complete manifest/config boundary changed by installation. */
function snapshotTransactionFiles(root: string): readonly FileSnapshot[] {
  return TRANSACTION_FILES.map(file => {
    const path = join(root, file)
    return { path, text: updaterInternals.readTextFile(path) }
  })
}

/** Restore captured files, removing ones that did not exist before. */
function restoreTransactionFiles(files: readonly FileSnapshot[]): void {
  for (const file of files) {
    if (file.text === undefined) updaterInternals.removeFile(file.path)
    else updaterInternals.writeTextFile(file.path, file.text)
  }
}

/** Import every new package root in a fresh Node process. */
async function importInstalledRows(root: string, rows: readonly MarketInstallRow[]): Promise<SpawnOutcome> {
  const script = [
    "const { createRequire } = await import('node:module')",
    "const { join } = await import('node:path')",
    "const { pathToFileURL } = await import('node:url')",
    "const req = createRequire(join(process.cwd(), 'package.json'))",
    `for (const name of ${JSON.stringify(rows.map(row => row.name))}) await import(pathToFileURL(req.resolve(name)).href)`,
  ].join('\n')
  return updaterInternals.spawnOnce(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root,
    timeoutMs: IMPORT_TIMEOUT_MS,
  })
}

/** Collect and validate every row nested under a top-level `insert` patch. */
function insertionRows(items: readonly unknown[]): YAMLMap[] {
  const rows: YAMLMap[] = []
  for (const item of items) {
    if (!isMap(item) || !item.has('insert')) continue
    const insert = item.get('insert', true)
    if (!isSeq(insert)) throw new Error('cordis.patch.yml insert must be a YAML sequence')
    for (const row of insert.items) {
      if (!isMap(row)) throw new Error('cordis.patch.yml insert entries must be mappings')
      rows.push(row as YAMLMap)
    }
  }
  return rows
}

/** Prepare idempotent `profile-patch` row insertion without writing it yet. */
function prepareProfilePatchRows(root: string, rows: readonly MarketInstallRow[]): PatchEdit | undefined {
  if (rows.length === 0) return undefined
  const path = join(root, 'cordis.patch.yml')
  const existing = updaterInternals.readTextFile(path)
  const doc = parseDocument(existing?.trim() === '' || existing === undefined ? '[]\n' : existing)
  if (doc.errors.length > 0 || !isSeq(doc.contents)) {
    throw new Error(`cordis.patch.yml must be a YAML sequence: ${doc.errors[0]?.message ?? 'found another document shape'}`)
  }
  const existingRows = insertionRows(doc.contents.items)
  const added: Array<{ id: string, name: string, config?: Readonly<Record<string, unknown>> }> = []
  for (const row of rows) {
    const id = row.id ?? row.name
    const present = existingRows.find(item => (item.get('id') as unknown) === id)
    if (present !== undefined) {
      if ((present.get('name') as unknown) === row.name) continue
      throw new Error(`cordis.patch.yml already has id ${JSON.stringify(id)} for another package`)
    }
    added.push({ id, name: row.name, ...(row.config === undefined ? {} : { config: row.config }) })
  }
  if (added.length > 0) {
    doc.add({ insert: added })
    doc.contents.flow = false
    return { path, text: String(doc) }
  }
  return undefined
}

/** Prepare removal of this entry's exact `id + name` rows without writing. */
function prepareProfilePatchRemoval(root: string, rows: readonly MarketInstallRow[]): PatchEdit | undefined {
  /* v8 ignore next -- the manifest schema guarantees at least one row */
  if (rows.length === 0) return undefined
  const path = join(root, 'cordis.patch.yml')
  const existing = updaterInternals.readTextFile(path)
  if (existing === undefined) return undefined
  const doc = parseDocument(existing)
  if (doc.errors.length > 0 || !isSeq(doc.contents)) {
    throw new Error(`cordis.patch.yml must be a YAML sequence: ${doc.errors[0]?.message ?? 'found another document shape'}`)
  }
  const keys = new Set(rows.map(row => `${row.id ?? row.name}\0${row.name}`))
  insertionRows(doc.contents.items)
  let changed = false
  doc.contents.items = doc.contents.items.filter(item => {
    if (!isMap(item) || !item.has('insert')) return true
    const insert = item.get('insert', true)
    /* v8 ignore next -- insertionRows validated this exact node above */
    if (!isSeq(insert)) return true
    const kept = insert.items.filter(row => {
      /* v8 ignore next -- insertionRows validated every nested row above */
      if (!isMap(row)) return true
      return !keys.has(`${String((row.get('id') as unknown) ?? '')}\0${String((row.get('name') as unknown) ?? '')}`)
    })
    if (kept.length === insert.items.length) return true
    changed = true
    insert.items = kept
    if (kept.length > 0) return true
    item.delete('insert')
    return item.items.length > 0
  })
  if (!changed) return undefined
  return { path, text: String(doc) }
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
  /** Optional progress sink for the interactive browser. */
  readonly onProgress?: (phase: 'verify' | 'rollback') => void
}

/** Remove a newly installed entry and restore its pre-install files. */
async function rollbackInstall(
  input: InstallerInput,
  names: readonly string[],
  files: readonly FileSnapshot[],
  reason: string,
): Promise<InstallOutcome> {
  input.onProgress?.('rollback')
  const removal = await updaterInternals.spawnOnce(input.dshBin,
    ['plugin', '--profile', input.profile, 'remove', ...names],
    { cwd: input.root, timeoutMs: INSTALL_TIMEOUT_MS })
  let restoreError: string | undefined
  try {
    restoreTransactionFiles(files)
  } catch (error) {
    restoreError = errorText(error)
  }
  if (removal.code !== 0 || restoreError !== undefined) {
    const details = [removal.code === 0 ? undefined : describeFailure('automatic rollback', removal), restoreError === undefined ? undefined : `restoring profile files failed: ${restoreError}`]
      .filter((detail): detail is string => detail !== undefined).join('; ')
    return { kind: 'error', text: `${reason}; rollback incomplete: ${details}` }
  }
  return { kind: 'error', text: `${reason}; changes rolled back` }
}

/**
 * Install one entry: allowBuilds first, then one `dsh plugin add` carrying
 * every row's spec together (sibling rows satisfy each other's peers), then
 * the `profile-patch` rows into the user patch layer.
 */
export async function installEntry(input: InstallerInput): Promise<InstallOutcome> {
  const blocked = marketEntryInstallBlock(input.entry)
  if (blocked !== undefined) return { kind: 'error', text: blocked }
  const rows = input.entry.install.rows
  const installedNames = new Set(readInstalledPlugins(input.root).map(plugin => plugin.name))
  if (rows.some(row => installedNames.has(row.name))) {
    return { kind: 'error', text: `"${input.entry.displayName}" is already or partially installed; uninstall it before reinstalling` }
  }
  const specs = rows.map(row => rowSpec(row, input.source)).filter((spec): spec is string => spec !== undefined)
  if (specs.length !== rows.length || specs.length === 0) {
    return { kind: 'error', text: `"${input.entry.displayName}" has no ${input.source} install source` }
  }
  const files = snapshotTransactionFiles(input.root)
  let patchEdit: PatchEdit | undefined
  try {
    patchEdit = prepareProfilePatchRows(input.root, rows.filter(row => row.activation === 'profile-patch'))
    ensureAllowBuilds(input.root, input.entry.install.allowBuilds ?? [])
  } catch (error) {
    return { kind: 'error', text: `preparing "${input.entry.displayName}" failed: ${errorText(error)}` }
  }
  const outcome = await updaterInternals.spawnOnce(input.dshBin,
    ['plugin', '--profile', input.profile, 'add', ...specs],
    { cwd: input.root, timeoutMs: INSTALL_TIMEOUT_MS })
  if (outcome.code !== 0) {
    restoreTransactionFiles(files)
    return { kind: 'error', text: describeFailure(`installing "${input.entry.displayName}"`, outcome) }
  }
  input.onProgress?.('verify')
  const imported = await importInstalledRows(input.root, rows)
  if (imported.code !== 0) {
    return rollbackInstall(input, rows.map(row => row.name), files, describeFailure(`checking "${input.entry.displayName}" compatibility`, imported))
  }
  try {
    if (patchEdit !== undefined) updaterInternals.writeTextFile(patchEdit.path, patchEdit.text)
  } catch (error) {
    return rollbackInstall(input, rows.map(row => row.name), files, `activating "${input.entry.displayName}" failed: ${errorText(error)}`)
  }
  return { kind: 'success' }
}

/** Remove one entry: one `dsh plugin remove` for every row name, then the
 * installer-written patch rows leave the user layer with it. */
export async function uninstallEntry(input: InstallerInput): Promise<InstallOutcome> {
  const installedNames = new Set(readInstalledPlugins(input.root).map(plugin => plugin.name))
  const names = input.entry.install.rows.map(row => row.name).filter(name => installedNames.has(name))
  if (names.length === 0) return { kind: 'error', text: `"${input.entry.displayName}" is not installed in this profile` }
  let patchEdit: PatchEdit | undefined
  try {
    patchEdit = prepareProfilePatchRemoval(input.root, input.entry.install.rows)
  } catch (error) {
    return { kind: 'error', text: `preparing removal of "${input.entry.displayName}" failed: ${errorText(error)}` }
  }
  const outcome = await updaterInternals.spawnOnce(input.dshBin,
    ['plugin', '--profile', input.profile, 'remove', ...names],
    { cwd: input.root, timeoutMs: INSTALL_TIMEOUT_MS })
  if (outcome.code !== 0) {
    return { kind: 'error', text: describeFailure(`removing "${input.entry.displayName}"`, outcome) }
  }
  try {
    if (patchEdit !== undefined) updaterInternals.writeTextFile(patchEdit.path, patchEdit.text)
  } catch (error) {
    return { kind: 'error', text: `packages removed but cleaning up "${input.entry.displayName}" failed: ${errorText(error)}` }
  }
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
    /* v8 ignore next -- the manifest schema guarantees at least one row */
    const info = first === undefined ? undefined : entry.npm?.[first.name]
    const updateAvailable = installed === true && info?.latestVersion != null && version !== undefined
      && compareVersions(info.latestVersion, version) > 0
    states[entry.id] = { installed, version, updateAvailable }
  }
  return states
}
