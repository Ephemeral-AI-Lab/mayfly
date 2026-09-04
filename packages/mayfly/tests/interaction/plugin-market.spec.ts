/**
 * Tests for the plugin-market catalog loader: the parse guard, the cache
 * TTL, the raw → jsDelivr fallback chain, custom-URL single-leg fetches,
 * stale serving, offline, and force refresh — all over the scripted
 * `updaterInternals` seams (network, fs, clock, home).
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempTracked, registerTempDirCleanup } from '../core/temp-dir.ts'
import { updaterInternals } from '../../src/interaction/updater/io.ts'
import {
  DEFAULT_MARKET_INDEX_URL,
  loadMarketCatalog,
  marketCachePath,
  MARKET_CACHE_TTL_MS,
} from '../../src/interaction/plugin-market/catalog.ts'
import { parseMarketIndex } from '../../src/interaction/plugin-market/types.ts'

registerTempDirCleanup()

/** The real seams, restored after every test. */
const REAL = { ...updaterInternals }

afterEach(() => {
  Object.assign(updaterInternals, REAL)
  vi.restoreAllMocks()
})

/** A two-entry index document. */
function indexJson(entries: ReadonlyArray<{ id: string }> = [{ id: 'loop' }, { id: 'terminal' }]): string {
  return JSON.stringify({ schemaVersion: 1, generatedAt: '2026-09-04T00:00:00.000Z', entries })
}

/** One test home with a scripted network; `urls` maps URL → body. */
function mountNetwork(urls: Readonly<Record<string, string | Error>>): { home: string, fetches: string[] } {
  const home = mkdtempTracked('mayfly-market-')
  updaterInternals.homedir = () => home
  updaterInternals.env = { DSH_HOME: join(home, '.dsh') }
  updaterInternals.now = () => 10_000_000
  const fetches: string[] = []
  updaterInternals.fetchText = vi.fn(async (url: string) => {
    fetches.push(url)
    const body = urls[url]
    if (body === undefined) throw new Error(`no route for ${url}`)
    if (body instanceof Error) throw body
    return body
  })
  return { home, fetches }
}

describe('parseMarketIndex', () => {
  it('parses a valid document', () => {
    const index = parseMarketIndex(indexJson())
    expect(index.schemaVersion).toBe(1)
    expect(index.entries.map(entry => entry.id)).toEqual(['loop', 'terminal'])
  })

  it('rejects invalid JSON', () => {
    expect(() => parseMarketIndex('{')).toThrow(/not valid JSON/)
  })

  it('rejects a non-object document', () => {
    expect(() => parseMarketIndex('[]')).toThrow(/not an object/)
  })

  it('rejects an unsupported schema version with the upgrade hint', () => {
    expect(() => parseMarketIndex('{"schemaVersion":2,"entries":[]}')).toThrow(/schema version 2 .* update Mayfly/)
  })

  it('rejects a document without entries', () => {
    expect(() => parseMarketIndex('{"schemaVersion":1}')).toThrow(/no entries/)
  })
})

describe('loadMarketCatalog', () => {
  it('fetches the default URL, then the jsDelivr mirror, and caches', async () => {
    const { home, fetches } = mountNetwork({
      [DEFAULT_MARKET_INDEX_URL]: new Error('raw unreachable'),
      'https://cdn.jsdelivr.net/gh/Ephemeral-AI-Lab/dsh-plugins@main/dist/index.json': indexJson(),
    })
    const first = await loadMarketCatalog(DEFAULT_MARKET_INDEX_URL)
    expect(first.status).toBe('fresh')
    expect(fetches).toEqual([DEFAULT_MARKET_INDEX_URL, 'https://cdn.jsdelivr.net/gh/Ephemeral-AI-Lab/dsh-plugins@main/dist/index.json'])
    // The cache slot exists and the second load never touches the network.
    const second = await loadMarketCatalog(DEFAULT_MARKET_INDEX_URL)
    expect(second.status).toBe('fresh')
    expect(fetches).toHaveLength(2)
    expect(marketCachePath()).toBe(join(home, '.dsh', 'storages', 'mayfly-plugin-market', 'cache.json'))
  })

  it('answers from the cache within the TTL without fetching', async () => {
    mountNetwork({})
    updaterInternals.writeTextFile(marketCachePath(), JSON.stringify({ fetchedAt: 9_999_999, text: indexJson() }))
    const result = await loadMarketCatalog(DEFAULT_MARKET_INDEX_URL)
    expect(result.status).toBe('fresh')
    expect(updaterInternals.fetchText).not.toHaveBeenCalled()
  })

  it('refetches past the TTL', async () => {
    const { fetches } = mountNetwork({ [DEFAULT_MARKET_INDEX_URL]: indexJson() })
    updaterInternals.writeTextFile(marketCachePath(), JSON.stringify({ fetchedAt: 1_000_000 - MARKET_CACHE_TTL_MS, text: indexJson() }))
    const result = await loadMarketCatalog(DEFAULT_MARKET_INDEX_URL)
    expect(result.status).toBe('fresh')
    expect(fetches).toEqual([DEFAULT_MARKET_INDEX_URL])
  })

  it('serves stale cache when every leg fails', async () => {
    mountNetwork({})
    updaterInternals.writeTextFile(marketCachePath(), JSON.stringify({ fetchedAt: 0, text: indexJson() }))
    const result = await loadMarketCatalog(DEFAULT_MARKET_INDEX_URL)
    expect(result).toMatchObject({ status: 'stale', message: expect.stringContaining('no route') })
    if (result.status === 'stale') expect(result.index.entries).toHaveLength(2)
  })

  it('reports offline when nothing is cached and every leg fails', async () => {
    const { fetches } = mountNetwork({})
    const result = await loadMarketCatalog(DEFAULT_MARKET_INDEX_URL)
    expect(result).toMatchObject({ status: 'offline', message: expect.stringContaining('cdn.jsdelivr.net') })
    expect(fetches).toHaveLength(2)
  })

  it('fetches exactly the custom URL with no mirror fallback', async () => {
    const { fetches } = mountNetwork({ 'https://example.invalid/market.json': indexJson() })
    const result = await loadMarketCatalog('https://example.invalid/market.json')
    expect(result.status).toBe('fresh')
    expect(fetches).toEqual(['https://example.invalid/market.json'])
  })

  it('force skips a fresh cache', async () => {
    const { fetches } = mountNetwork({ [DEFAULT_MARKET_INDEX_URL]: indexJson([{ id: 'fresh' }]) })
    updaterInternals.writeTextFile(marketCachePath(), JSON.stringify({ fetchedAt: 999_999, text: indexJson() }))
    const result = await loadMarketCatalog(DEFAULT_MARKET_INDEX_URL, true)
    expect(result.status).toBe('fresh')
    expect(fetches).toEqual([DEFAULT_MARKET_INDEX_URL])
    if (result.status === 'fresh') expect(result.index.entries[0]?.id).toBe('fresh')
  })

  it('treats a corrupt cache as absent', async () => {
    const { home } = mountNetwork({})
    updaterInternals.writeTextFile(marketCachePath(), 'not json')
    // A corrupt cache must not crash the stale path.
    const result = await loadMarketCatalog(DEFAULT_MARKET_INDEX_URL)
    expect(result.status).toBe('offline')
    expect(home.length).toBeGreaterThan(0)
  })

  it('rewrites the cache after a successful fetch', async () => {
    mountNetwork({ [DEFAULT_MARKET_INDEX_URL]: indexJson() })
    const before = updaterInternals.readTextFile(marketCachePath())
    expect(before).toBeUndefined()
    await loadMarketCatalog(DEFAULT_MARKET_INDEX_URL)
    const cached = JSON.parse(updaterInternals.readTextFile(marketCachePath()) ?? '{}') as { fetchedAt: number, text: string }
    expect(cached.fetchedAt).toBe(10_000_000)
    expect(parseMarketIndex(cached.text).entries).toHaveLength(2)
  })
})

describe('cache slot hygiene', () => {
  it('reads a cache whose shape is wrong as absent', async () => {
    mountNetwork({ [DEFAULT_MARKET_INDEX_URL]: indexJson() })
    mkdirSync(join(marketCachePath(), '..'), { recursive: true })
    writeFileSync(marketCachePath(), JSON.stringify({ fetchedAt: 'yesterday' }))
    const result = await loadMarketCatalog(DEFAULT_MARKET_INDEX_URL)
    expect(result.status).toBe('fresh')
    rmSync(marketCachePath(), { force: true })
  })
})

describe('readCache shape guard', () => {
  it('treats a scalar cache document as absent', async () => {
    mountNetwork({ [DEFAULT_MARKET_INDEX_URL]: indexJson() })
    updaterInternals.writeTextFile(marketCachePath(), '5')
    const result = await loadMarketCatalog(DEFAULT_MARKET_INDEX_URL)
    expect(result.status).toBe('fresh')
  })
})
