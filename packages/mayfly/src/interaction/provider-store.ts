/**
 * Provider-route addressing over the native configurable-provider directory.
 *
 * A route's settings namespace and profile path are declared by the adapter
 * that owns it (`LlmConfigurableProvider.settingsNs` / `settingsPath`); no
 * Mayfly-side plugin id, package name, row id, or config key is assumed. The
 * only write path is `ctx.settings.mutate`, addressed with those native facts.
 * A route whose adapter declares no path cannot be edited through this module,
 * and callers report that instead of writing a profile document by hand.
 *
 * @module @ephemeral-ai/mayfly/interaction/provider-store
 */
import type { Context } from '@deepseek-ai/cordis'
import type { LlmConfigurableProvider } from '@deepseek-ai/dsh-llm'
import type { SettingsDescriptor, SettingsForms, SettingsPathOp } from '@deepseek-ai/dsh-settings'
import type { ProviderProfile } from './provider-profile.ts'

/** One configurable route's native settings address. */
export interface ProviderAddress {
  /** Namespace of the profile entry whose config carries this route. */
  readonly ns: string
  /** Path from the namespace's section root to this route's profile object. */
  readonly path: readonly string[]
  /** Path from the namespace's section root to the dict of route profiles, when the adapter names one. */
  readonly container: readonly string[] | undefined
  /** The adapter's own statement that configuration alone declared this route. */
  readonly declared: boolean | undefined
  /** Human-readable route name the adapter published. */
  readonly displayName: string
}

/** The native settings namespace and route-dict path a new route can join. */
export interface ProviderContainer {
  /** Namespace of the profile entry whose config carries provider routes. */
  readonly ns: string
  /** Path from the namespace's section root to the dict of route profiles. */
  readonly container: readonly string[]
}

/** The routes the native LLM registry currently declares configurable. */
export function providerDirectory(ctx: Context): readonly LlmConfigurableProvider[] {
  return ctx.get('llm')?.listConfigurableProviders() ?? []
}

/** Whether two native settings paths name the same location. */
export function sameProviderPath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index])
}

/**
 * Resolve one route's native settings address.
 * @param ctx - context carrying the native LLM registry.
 * @param route - provider route key.
 * @returns the declared address, or undefined when no adapter declares the route.
 */
export function providerAddress(ctx: Context, route: string): ProviderAddress | undefined {
  const entry = providerDirectory(ctx).find(candidate => candidate.provider === route)
  if (entry === undefined) return undefined
  const path = entry.settingsPath ?? []
  return {
    ns: entry.settingsNs,
    path,
    container: path.length === 0 ? undefined : path.slice(0, -1),
    declared: entry.declared,
    displayName: entry.displayName,
  }
}

/**
 * Resolve the native settings location a newly added route can join. Adapters
 * that own a dict of routes declare a non-empty per-route path; entries are
 * grouped by namespace and dict path, and the largest group wins (a catalog
 * of installed routes is the stable container). Ties resolve lexically so a
 * composition with several candidate adapters still answers deterministically.
 * @param ctx - context carrying the native LLM registry.
 * @returns the container, or undefined when no adapter declares a route dict.
 */
export function providerContainer(ctx: Context): ProviderContainer | undefined {
  const groups = new Map<string, { readonly ns: string, readonly container: readonly string[], count: number }>()
  for (const entry of providerDirectory(ctx)) {
    const path = entry.settingsPath ?? []
    if (path.length < 2) continue
    const container = path.slice(0, -1)
    const key = JSON.stringify([entry.settingsNs, container])
    const group = groups.get(key)
    if (group === undefined) groups.set(key, { ns: entry.settingsNs, container, count: 1 })
    else group.count += 1
  }
  return [...groups.values()]
    .toSorted((left, right) => right.count - left.count
      || left.ns.localeCompare(right.ns)
      || JSON.stringify(left.container).localeCompare(JSON.stringify(right.container)))
    .map(({ ns, container }) => ({ ns, container }))[0]
}

/**
 * Read one native settings path.
 * @param value - a namespace's resolved or stored section.
 * @param path - segments below that section.
 * @returns the value at the path, or undefined when a segment is missing.
 */
export function providerValueAt(value: unknown, path: readonly string[]): unknown {
  let node = value
  for (const segment of path) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined
    if (!Object.hasOwn(node, segment)) return undefined
    node = (node as Record<string, unknown>)[segment]
  }
  return node
}

/**
 * Read one route's profile object from a native settings value.
 * @param value - a namespace's resolved or stored section.
 * @param path - the route's native settings path.
 * @returns the profile object, or undefined when no profile object is stored there.
 */
export function providerProfileAt(value: unknown, path: readonly string[]): ProviderProfile | undefined {
  const profile = providerValueAt(value, path)
  return profile !== null && typeof profile === 'object' && !Array.isArray(profile)
    ? profile as ProviderProfile
    : undefined
}

/** The live descriptor of one native settings namespace. */
export function providerDescriptor(settings: SettingsForms, ns: string): SettingsDescriptor | undefined {
  return settings.describe().find(item => String(item.ns) === ns)
}

/**
 * Persist ordered path edits through the native settings service. This is the
 * module's only write path; a missing namespace is an explicit refusal.
 * @param settings - the native settings service.
 * @param ns - the profile entry namespace the paths address.
 * @param ops - ordered, namespace-rooted edits.
 * @param expected - descriptor revision the edit was read at.
 * @throws when the namespace is not described, or the native write refuses.
 */
export async function persistProviders(
  settings: SettingsForms,
  ns: string,
  ops: readonly SettingsPathOp[],
  expected?: number,
): Promise<void> {
  if (ops.length === 0) return
  if (providerDescriptor(settings, ns) === undefined) {
    throw new Error(`no configurable plugin entry "${ns}"`)
  }
  await settings.mutate(ns, ops, expected)
}
