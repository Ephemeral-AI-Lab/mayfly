/**
 * User-level provider routes: the `llm-pi-ai` row of the harness home's
 * user patch layer (`$DSH_HOME/cordis.patch.yml`).
 *
 * Provider configuration belongs to the user, not to one dsh profile: the
 * npm-installed `mayfly` profile and every `mayfly-dev` / `mayfly-<tag>`
 * development profile must see the same routes. A native settings write
 * targets the active profile's `cordis.patch.yml`, which is per profile, so
 * this module keeps the canonical copy in the home layer dsh applies after
 * every profile patch and mirrors the same value into the active profile's
 * patch through the native path-op write, so the running tree reloads live.
 *
 * @module @ephemeral-ai/mayfly/interaction/provider-store
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { SettingsDescriptor, SettingsForms, SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { isDeepStrictEqual } from 'node:util'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isMap, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from 'yaml'
import { dshHome } from './updater/profile.ts'

/** The configurable-provider settings namespace Mayfly owns. */
export const PROVIDER_NAMESPACE = 'llm-pi-ai'
/** The home-patch row id; the dsh-base bundle owns this entry. */
const ROW_ID = 'llm-pi-ai'
/** The entry's package name, restored on a fresh home patch row. */
const ROW_NAME = '@deepseek-ai/dsh-llm-pi-ai'
/** The entry's only config key. */
const PROVIDERS_KEY = 'providers'

/** Process seams for the home patch (specs replace fields and restore them). */
export const providerStoreInternals = {
  /** The harness home's user patch layer. */
  homePatchPath: (): string => join(dshHome(), 'cordis.patch.yml'),
  /** Read a text file, `undefined` when missing (never throws). */
  readTextFile: (path: string): string | undefined => {
    try { return readFileSync(path, 'utf8') } catch { return undefined }
  },
  /** Atomically replace a text file, creating parent directories. */
  writeTextFile: (path: string, text: string): void => {
    mkdirSync(dirname(path), { recursive: true })
    const staging = `${path}.mayfly-tmp`
    writeFileSync(staging, text, { mode: 0o600 })
    renameSync(staging, path)
  },
  /** Remove a file; absent is a no-op. */
  removeFile: (path: string): void => {
    rmSync(path, { force: true })
  },
}

/** The `providers` dict of one config-shaped value, or an empty dict. */
function providersOf(value: unknown): Record<string, unknown> {
  const plain = value !== null && typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON === 'function'
    ? (value as { toJSON(): unknown }).toJSON()
    : value
  if (plain === null || typeof plain !== 'object') return {}
  const providers = (plain as { readonly providers?: unknown }).providers
  return providers !== null && typeof providers === 'object' && !Array.isArray(providers)
    ? providers as Record<string, unknown>
    : {}
}

/** Set one leaf path, materializing missing object segments. */
function setPath(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let node = target
  for (const segment of path.slice(0, -1)) {
    const child = node[segment]
    if (child === null || typeof child !== 'object' || Array.isArray(child)) {
      const created: Record<string, unknown> = {}
      node[segment] = created
      node = created
    } else node = child as Record<string, unknown>
  }
  node[path.at(-1)!] = value
}

/** Delete one leaf path; a missing parent is a no-op. */
function unsetPath(target: Record<string, unknown>, path: readonly string[]): void {
  let node = target
  for (const segment of path.slice(0, -1)) {
    const child = node[segment]
    if (child === null || typeof child !== 'object' || Array.isArray(child)) return
    node = child as Record<string, unknown>
  }
  delete node[path.at(-1)!]
}

/**
 * Apply provider path ops to the effective `providers` dict — the exact
 * value the home row stores and the native write restates.
 * @param value - the effective `llm-pi-ai` config value.
 * @param ops - the ordered form edits.
 * @returns the next providers dict, detached from `value`.
 */
export function providerOpsTarget(value: unknown, ops: readonly SettingsPathOp[]): Record<string, unknown> {
  const providers = structuredClone(providersOf(value))
  for (const op of ops) {
    if (op.path[0] !== PROVIDERS_KEY || op.path.length < 2) continue
    const rest = op.path.slice(1)
    if (op.op === 'set') setPath(providers, rest, structuredClone(op.value))
    else unsetPath(providers, rest)
  }
  return providers
}

/** The last top-level `llm-pi-ai` replace row, if the patch has one. */
function providerRow(items: readonly unknown[]): YAMLMap | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (isMap(item) && item.get('id') === ROW_ID && !item.has('insert')) return item
  }
  return undefined
}

/** Parse a home patch into its document and top-level sequence. */
function parsePatch(text: string | undefined): { readonly document: ReturnType<typeof parseDocument>, readonly contents: YAMLSeq } {
  const document = parseDocument(text === undefined || text.trim() === '' ? '[]\n' : text)
  const contents = document.contents
  if (document.errors.length > 0 || !isSeq(contents)) {
    throw new Error(`home patch must be a YAML sequence: ${document.errors[0]?.message ?? 'found another document shape'}`)
  }
  return { document, contents }
}

/**
 * Read the `providers` dict the home patch carries.
 * @param path - the home patch path.
 * @returns the stored providers, or an empty dict.
 */
export function readHomeProviders(path: string): Record<string, unknown> {
  const { contents } = parsePatch(providerStoreInternals.readTextFile(path))
  const row = providerRow(contents.items)
  return row === undefined ? {} : providersOf(row.get('config'))
}

/**
 * Upsert the `llm-pi-ai` row of the home patch with `providers`, preserving
 * every other row and comment.
 * @param path - the home patch path.
 * @param providers - the providers dict to store.
 * @returns the previous file text, `undefined` when the file did not exist.
 */
export function writeHomeProviders(path: string, providers: Readonly<Record<string, unknown>>): string | undefined {
  const before = providerStoreInternals.readTextFile(path)
  const { document, contents } = parsePatch(before)
  const row = providerRow(contents.items)
  if (row === undefined) {
    contents.flow = false
    document.add({ id: ROW_ID, name: ROW_NAME, config: { [PROVIDERS_KEY]: structuredClone(providers) } })
  } else {
    const config = isMap(row.get('config')) ? row.get('config') as YAMLMap : document.createNode({}) as YAMLMap
    config.set(PROVIDERS_KEY, document.createNode(structuredClone(providers)))
    row.set('config', config)
  }
  providerStoreInternals.writeTextFile(path, String(document))
  return before
}

/**
 * Restore the home patch to a previous state.
 * @param path - the home patch path.
 * @param previous - the text `writeHomeProviders` returned; `undefined` removes the file.
 */
export function restoreHome(path: string, previous: string | undefined): void {
  if (previous === undefined) providerStoreInternals.removeFile(path)
  else providerStoreInternals.writeTextFile(path, previous)
}

/** The live `llm-pi-ai` descriptor, or `undefined` when the entry is absent. */
function descriptorOf(settings: SettingsForms): SettingsDescriptor | undefined {
  return settings.describe().find(item => String(item.ns) === PROVIDER_NAMESPACE)
}

/**
 * Persist provider edits to the user-level home patch and mirror them into
 * the active profile through one native path-op write, so a running tree
 * reloads while every other profile boots with the same routes.
 * @param settings - the native settings service.
 * @param ops - the ordered form edits.
 * @param expected - the descriptor revision the edit was read at.
 */
export async function persistProviders(settings: SettingsForms, ops: readonly SettingsPathOp[], expected?: number): Promise<void> {
  if (ops.length === 0) return
  const descriptor = descriptorOf(settings)
  if (descriptor === undefined) throw new Error(`no configurable plugin entry "${PROVIDER_NAMESPACE}"`)
  const target = providerOpsTarget(descriptor.value, ops)
  const path = providerStoreInternals.homePatchPath()
  const before = writeHomeProviders(path, target)
  try {
    await settings.mutate(PROVIDER_NAMESPACE, [{ op: 'set', path: [PROVIDERS_KEY], value: target }], expected)
  } catch (error) {
    restoreHome(path, before)
    throw error
  }
}

/**
 * Merge the active profile's providers into the home patch once, so routes
 * configured before the user-level store existed reach every profile. The
 * home value wins a route-name conflict.
 * @param settings - the native settings service.
 * @param path - the home patch path.
 * @returns whether the home patch changed.
 */
export function migrateProvidersToHome(settings: SettingsForms, path: string): boolean {
  const descriptor = descriptorOf(settings)
  if (descriptor === undefined) return false
  const profile = providersOf(descriptor.value)
  if (Object.keys(profile).length === 0) return false
  const home = readHomeProviders(path)
  const merged = { ...profile, ...home }
  if (isDeepStrictEqual(merged, home)) return false
  writeHomeProviders(path, merged)
  return true
}

/**
 * Schedule the one-time merge after the Loader settles every entry, fenced
 * by the owning fiber's lifetime.
 * @param ctx - the provider commands' context.
 */
export function scheduleProviderMigration(ctx: Context): void {
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort())
  void (async () => {
    try {
      await ctx.get('loader')?.await()
      if (lifetime.signal.aborted) return
      const settings = ctx.get('settings')
      if (settings === undefined) return
      migrateProvidersToHome(settings, providerStoreInternals.homePatchPath())
    } catch (error) {
      ctx.logger.warn(`provider store: ${String(error)}`)
    }
  })()
}
