/**
 * The plugin-market catalog loader: cache-first over the profile storage,
 * with a raw.githubusercontent → jsDelivr fallback chain when the configured
 * index URL is the default one (mainland reachability), and cached data
 * served stale when every fetch fails. All process seams go through
 * `updaterInternals`, so specs script the network and the clock.
 *
 * @module @ephemeral-ai/mayfly/interaction/plugin-market/catalog
 */

import { join } from 'node:path'
import { updaterInternals } from '../updater/io.ts'
import { dshHome } from '../updater/profile.ts'
import { parseMarketIndex, type MarketIndex } from './types.ts'

/** The official index, served straight from the marketplace repository. */
export const DEFAULT_MARKET_INDEX_URL = 'https://raw.githubusercontent.com/Ephemeral-AI-Lab/dsh-plugins/main/dist/index.json'
/** jsDelivr mirror of the same path (the fallback leg of the default chain). */
const JSDELIVR_MARKET_INDEX_URL = 'https://cdn.jsdelivr.net/gh/Ephemeral-AI-Lab/dsh-plugins@main/dist/index.json'

/** How long a cached index stays fresh, in milliseconds. */
export const MARKET_CACHE_TTL_MS = 60 * 60 * 1000
/** Per-URL fetch timeout. */
const FETCH_TIMEOUT_MS = 15_000

/** The cached document plus when it was stored, epoch milliseconds. */
interface CacheDoc {
  readonly fetchedAt: number
  readonly text: string
}

/** Where the cache lives: `$DSH_HOME/storages/mayfly-plugin-market/cache.json`. */
export function marketCachePath(): string {
  return join(dshHome(), 'storages', 'mayfly-plugin-market', 'cache.json')
}

/** The outcome of loading the catalog. */
export type CatalogResult =
  | { readonly status: 'fresh', readonly index: MarketIndex }
  | { readonly status: 'stale', readonly index: MarketIndex, readonly message: string }
  | { readonly status: 'offline', readonly message: string }

/**
 * The URLs to try, in order: a custom setting means exactly that URL; the
 * default means the raw document first and its CDN mirror second.
 */
function fetchChain(indexUrl: string): readonly string[] {
  return indexUrl === DEFAULT_MARKET_INDEX_URL
    ? [DEFAULT_MARKET_INDEX_URL, JSDELIVR_MARKET_INDEX_URL]
    : [indexUrl]
}

/** Try each URL once; the first parseable document wins. */
async function fetchIndex(indexUrl: string): Promise<MarketIndex> {
  const failures: string[] = []
  for (const url of fetchChain(indexUrl)) {
    try {
      const text = await updaterInternals.fetchText(url, FETCH_TIMEOUT_MS)
      return parseMarketIndex(text)
    } catch (error) {
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(failures.join('; '))
}

/** Read the cache document, `undefined` when absent or unparsable. */
function readCache(): CacheDoc | undefined {
  const text = updaterInternals.readTextFile(marketCachePath())
  if (text === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const doc = parsed as Record<string, unknown>
    if (typeof doc.fetchedAt !== 'number' || typeof doc.text !== 'string') return undefined
    return { fetchedAt: doc.fetchedAt, text: doc.text }
  } catch {
    return undefined
  }
}

/** Persist a fetched document to the cache slot. */
function writeCache(text: string): void {
  updaterInternals.writeTextFile(marketCachePath(), `${JSON.stringify({ fetchedAt: updaterInternals.now(), text })}\n`)
}

/**
 * Load the marketplace catalog.
 *
 * Fresh cache answers immediately; a stale cache (or `force`) refetches and
 * falls back to the cached document when every fetch leg fails; with no
 * cache at all, a total fetch failure is offline.
 *
 * @param indexUrl - the configured index URL (the default enables the
 * mirror fallback).
 * @param force - skip the cache read and refetch (`/plugin refresh`).
 * @returns the catalog outcome.
 */
export async function loadMarketCatalog(indexUrl: string, force = false): Promise<CatalogResult> {
  const cached = force ? undefined : readCache()
  if (cached !== undefined && updaterInternals.now() - cached.fetchedAt < MARKET_CACHE_TTL_MS) {
    return { status: 'fresh', index: parseMarketIndex(cached.text) }
  }
  try {
    const index = await fetchIndex(indexUrl)
    writeCache(JSON.stringify(index))
    return { status: 'fresh', index }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (cached !== undefined) {
      return { status: 'stale', index: parseMarketIndex(cached.text), message }
    }
    return { status: 'offline', message }
  }
}
