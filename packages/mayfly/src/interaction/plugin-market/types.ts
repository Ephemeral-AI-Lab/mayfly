/**
 * The marketplace index document types (`dist/index.json` from the
 * Ephemeral-AI-Lab/dsh-plugins repository) and its parse guard. The index is
 * discovery- and install-time metadata only: it never participates in
 * runtime loading, capability negotiation, or admission — the runtime
 * contract of every plugin remains its package plus `cordis.patch.yml`.
 *
 * @module @ephemeral-ai/mayfly/interaction/plugin-market/types
 */

/** One install unit of a marketplace entry. */
export interface MarketInstallRow {
  /** cordis patch row id (required by `profile-patch` activation). */
  readonly id?: string
  /** Runtime package name — the reconcile key against the profile manifest. */
  readonly name: string
  /** How the package becomes part of the profile. */
  readonly activation?: 'bundle' | 'profile-patch'
  /** Default config for a `profile-patch` row. */
  readonly config?: Readonly<Record<string, unknown>>
  /** npm install spec, e.g. `dsh-loop` or `@scope/pkg@1.2.3`. */
  readonly npm?: { readonly spec: string }
  /** GitHub install source; monorepos carry a `subdir`. */
  readonly github?: { readonly repo: string, readonly ref: string, readonly subdir?: string }
}

/** Registry enrichment for one row package, absent for GitHub-only rows. */
export interface MarketNpmInfo {
  readonly latestVersion: string | null
  readonly integrity?: string | null
  readonly publishedAt?: string | null
  readonly downloadsMonth?: number | null
}

/** What the plugin contributes; frontend usefulness is derived, not declared. */
export interface MarketSurfaces {
  readonly server?: Readonly<Record<string, never>>
  readonly web?: { readonly clientModule: boolean }
  readonly tui?: { readonly contributions: readonly string[] }
}

/** One marketplace listing. */
export interface MarketEntry {
  readonly id: string
  readonly source: 'official' | 'dsh' | 'community'
  readonly displayName: string
  readonly description: string
  readonly descriptionZh?: string
  readonly author: { readonly name: string, readonly url?: string }
  readonly links?: { readonly repo?: string, readonly docs?: string, readonly npm?: string }
  readonly license?: string
  readonly category: string
  readonly status: 'stable' | 'beta' | 'unstable' | 'deprecated' | 'removed'
  readonly statusNote?: string
  readonly surfaces: MarketSurfaces
  readonly provides?: { readonly tools?: readonly string[], readonly commands?: readonly string[] }
  readonly install: { readonly rows: readonly MarketInstallRow[], readonly allowBuilds?: readonly string[] }
  readonly engines?: { readonly dsh?: string, readonly mayfly?: string, readonly node?: string }
  readonly capabilities?: readonly string[]
  readonly verified?: {
    readonly at: string
    readonly packages: readonly { readonly name: string, readonly version: string, readonly integrity?: string }[]
  }
  /** npm enrichment keyed by row package name (build-time, from the registry). */
  readonly npm?: Readonly<Record<string, MarketNpmInfo>>
  readonly readmeExcerpt?: string | null
}

/** The whole index document. */
export interface MarketIndex {
  readonly schemaVersion: number
  readonly generatedAt?: string
  readonly entries: readonly MarketEntry[]
}

/** The index schema version this consumer understands. */
export const MARKET_INDEX_SCHEMA_VERSION = 1

/**
 * Parse and guard an index document. Unknown schema versions reject loudly
 * instead of rendering half-understood entries.
 * @param text - the raw `index.json` body.
 * @returns the parsed index.
 * @throws on JSON errors, an unsupported schema version, or a missing entries
 * array.
 */
export function parseMarketIndex(text: string): MarketIndex {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    /* v8 ignore next -- JSON.parse only throws SyntaxError instances */
    throw new Error(`market index is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('market index is not an object')
  const index = parsed as Record<string, unknown>
  if (index.schemaVersion !== MARKET_INDEX_SCHEMA_VERSION) {
    throw new Error(`market index schema version ${String(index.schemaVersion)} is not supported (expected ${String(MARKET_INDEX_SCHEMA_VERSION)}) — update Mayfly`)
  }
  if (!Array.isArray(index.entries)) throw new Error('market index has no entries array')
  const generatedAt = typeof index.generatedAt === 'string' ? index.generatedAt : undefined
  return generatedAt === undefined
    ? { schemaVersion: MARKET_INDEX_SCHEMA_VERSION, entries: index.entries as readonly MarketEntry[] }
    : { schemaVersion: MARKET_INDEX_SCHEMA_VERSION, generatedAt, entries: index.entries as readonly MarketEntry[] }
}
