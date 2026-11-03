/**
 * Native provider settings addressing and endpoint profile helpers.
 * @module @ephemeral-ai/mayfly/remote/features/provider-profile
 */

import type { LlmConfigurableProvider } from '@deepseek-ai/dsh-api-remotes/client'

/** Provider profile fields consumed by Remote forms; unknown fields are preserved. */
export interface RemoteProviderProfile {
  readonly displayName?: string
  readonly api?: string
  readonly baseURL?: string
  readonly apiKeyEnv?: string
  readonly models?: readonly { readonly id?: unknown, readonly [key: string]: unknown }[]
  readonly reasoning?: string
  readonly [key: string]: unknown
}

/** Native settings address owned by the provider adapter. */
export interface RemoteProviderAddress {
  readonly ns: string
  readonly path: readonly string[]
  readonly container?: readonly string[]
  readonly declared?: boolean
  readonly displayName: string
}

/** Derive the conventional write-only credential reference for a route. */
export function deriveRemoteProviderKeyRef(route: string): string {
  return `${route.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/** Normalize an endpoint using the provider's protocol and successful discovery base. */
export function normalizeRemoteProviderBaseURL(protocol: string, entered: string, listingBase?: string): string {
  const trimmed = entered.replace(/\/+$/, '')
  if (protocol === 'anthropic-messages') return trimmed.replace(/\/v1$/, '')
  if (listingBase === `${trimmed}/v1`) return listingBase
  return trimmed
}

/** Read a value below a redacted settings section. */
export function remoteProviderValueAt(value: unknown, path: readonly string[]): unknown {
  let node = value
  for (const segment of path) {
    if (node === null || typeof node !== 'object' || Array.isArray(node) || !Object.hasOwn(node, segment)) return undefined
    node = Reflect.get(node, segment)
  }
  return node
}

/** Read one profile object without exposing any credential value. */
export function remoteProviderProfileAt(value: unknown, path: readonly string[]): RemoteProviderProfile | undefined {
  const profile = remoteProviderValueAt(value, path)
  return profile !== null && typeof profile === 'object' && !Array.isArray(profile)
    ? profile as RemoteProviderProfile
    : undefined
}

/** Resolve a route's adapter-declared settings namespace and path. */
export function remoteProviderAddress(
  directory: readonly LlmConfigurableProvider[],
  route: string,
): RemoteProviderAddress | undefined {
  const entry = directory.find(candidate => candidate.provider === route)
  if (entry === undefined) return undefined
  return {
    ns: entry.settingsNs,
    path: entry.settingsPath,
    ...entry.settingsPath.length === 0 ? {} : { container: entry.settingsPath.slice(0, -1) },
    ...entry.declared === undefined ? {} : { declared: entry.declared },
    displayName: entry.displayName,
  }
}

/** Resolve the route dictionary used for custom provider creation. */
export function remoteProviderContainer(
  directory: readonly LlmConfigurableProvider[],
): { readonly ns: string, readonly path: readonly string[] } | undefined {
  const groups = new Map<string, { readonly ns: string, readonly path: readonly string[], count: number }>()
  for (const entry of directory) {
    if (entry.settingsPath.length < 2) continue
    const path = entry.settingsPath.slice(0, -1)
    const key = JSON.stringify([entry.settingsNs, path])
    const group = groups.get(key)
    if (group === undefined) groups.set(key, { ns: entry.settingsNs, path, count: 1 })
    else group.count += 1
  }
  return [...groups.values()].toSorted((left, right) => right.count - left.count
    || left.ns.localeCompare(right.ns)
    || JSON.stringify(left.path).localeCompare(JSON.stringify(right.path)))[0]
}

/** Candidate OpenAI-style listing bases for one entered endpoint. */
export function remoteProviderDiscoveryBases(baseURL: string): readonly string[] {
  const base = baseURL.replace(/\/+$/, '')
  return [...new Set([base, `${base}/v1`, base.replace(/\/v1$/, '')])]
}

/** Route-id grammar shared by custom provider forms. */
export const REMOTE_PROVIDER_ROUTE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u
