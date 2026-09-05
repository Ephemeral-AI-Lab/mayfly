/**
 * The marketplace index document types (`dist/index.json` from the
 * Ephemeral-AI-Lab/dsh-plugins repository) and its parse guard. The index is
 * discovery- and install-time metadata only: it never participates in
 * runtime loading, capability negotiation, or admission — the runtime
 * contract of every plugin remains its package plus `cordis.patch.yml`.
 *
 * @module @ephemeral-ai/mayfly/interaction/plugin-market/types
 */

import { z } from 'zod'

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
    readonly packages: readonly { readonly name: string, readonly version: string, readonly integrity?: string | null }[]
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

const installRowSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().regex(/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-._~]+$/u),
  activation: z.enum(['bundle', 'profile-patch']).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  npm: z.object({ spec: z.string().min(1) }).strict().optional(),
  github: z.object({
    repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
    ref: z.string().min(1).max(80),
    subdir: z.string().regex(/^[^/].*$/u).optional(),
  }).strict().optional(),
}).strict().refine(row => row.npm !== undefined || row.github !== undefined, {
  message: 'install row needs an npm or github source',
})

const npmInfoSchema = z.object({
  latestVersion: z.string().nullable(),
  integrity: z.string().nullable().optional(),
  publishedAt: z.string().nullable().optional(),
  downloadsMonth: z.number().nullable().optional(),
})

const entrySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/u).max(64),
  source: z.enum(['official', 'dsh', 'community']),
  displayName: z.string().min(1).max(64),
  description: z.string().min(1).max(300),
  descriptionZh: z.string().min(1).max(300).optional(),
  author: z.object({ name: z.string().min(1), url: z.string().optional() }).strict(),
  links: z.object({ repo: z.string().optional(), docs: z.string().optional(), npm: z.string().optional() }).strict().optional(),
  license: z.string().optional(),
  category: z.string().min(1),
  status: z.enum(['stable', 'beta', 'unstable', 'deprecated', 'removed']),
  statusNote: z.string().optional(),
  surfaces: z.object({
    server: z.object({}).strict().optional(),
    web: z.object({ clientModule: z.boolean() }).strict().optional(),
    tui: z.object({ contributions: z.array(z.string()) }).strict().optional(),
  }).strict().refine(value => value.server !== undefined || value.web !== undefined || value.tui !== undefined, {
    message: 'at least one surface is required',
  }),
  provides: z.object({
    tools: z.array(z.string()).optional(),
    commands: z.array(z.string()).optional(),
  }).strict().optional(),
  install: z.object({
    rows: z.array(installRowSchema).min(1),
    allowBuilds: z.array(z.string().min(1)).min(1).optional(),
  }).strict(),
  engines: z.object({ dsh: z.string().optional(), mayfly: z.string().optional(), node: z.string().optional() }).strict().nullish()
    .transform(value => value ?? undefined),
  capabilities: z.array(z.string()).optional(),
  verified: z.object({
    at: z.string(),
    packages: z.array(z.object({
      name: z.string(),
      version: z.string(),
      integrity: z.string().nullable().optional(),
    }).strict()),
  }).strict().optional(),
  npm: z.record(z.string(), npmInfoSchema).optional(),
  readmeExcerpt: z.string().nullable().optional(),
})

const indexSchema = z.object({
  schemaVersion: z.literal(MARKET_INDEX_SCHEMA_VERSION),
  generatedAt: z.string().optional(),
  entries: z.array(entrySchema),
})

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
  const record = parsed as Record<string, unknown>
  if (record.schemaVersion !== MARKET_INDEX_SCHEMA_VERSION) {
    throw new Error(`market index schema version ${String(record.schemaVersion)} is not supported (expected ${String(MARKET_INDEX_SCHEMA_VERSION)}) — update Mayfly`)
  }
  if (!Array.isArray(record.entries)) throw new Error('market index has no entries array')
  const result = indexSchema.safeParse(parsed)
  if (!result.success) {
    const issue = result.error.issues[0]!
    throw new Error(`market index is invalid at ${issue.path.join('.')}: ${issue.message}`)
  }
  const ids = new Set<string>()
  for (const entry of result.data.entries) {
    if (ids.has(entry.id)) throw new Error(`market index repeats entry id ${entry.id}`)
    ids.add(entry.id)
  }
  return result.data as MarketIndex
}
