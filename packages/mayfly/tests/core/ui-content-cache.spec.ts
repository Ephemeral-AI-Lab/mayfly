/**
 * `MayflyContentCache` (core/ui-content-cache.ts): the shared store of painted segment rows, and the single bound on
 * derived-row memory. Rows return while they are live, recent entries survive an over-budget burst, and cold bytes
 * are evicted oldest-first.
 *
 * @module @ephemeral-ai/mayfly/core/tests/ui-content-cache
 */

import { describe, expect, it } from 'vitest'
import { MAYFLY_CONTENT_CACHE_KEEP, MayflyContentCache, paintedRowsBytes } from '../../src/core/ui-content-cache.ts'

const rows = (text: string, count: number): readonly string[] => Array.from({ length: count }, (_, index) => `${text}${String(index)}`)

describe('MayflyContentCache', () => {
  it('returns stored rows and prices them by paintedRowsBytes', () => {
    const cache = new MayflyContentCache()
    const painted = rows('row', 3)
    cache.put('k', painted, paintedRowsBytes(painted))
    expect(cache.get('k')).toBe(painted)
    expect(cache.get('missing')).toBeUndefined()
    expect(paintedRowsBytes(['abcd', 'ef'])).toBe(64 + 4 * 2 + 40 + 2 * 2 + 40)
  })

  it('replaces a key under its new byte cost', () => {
    const cache = new MayflyContentCache(200)
    cache.put('k', rows('a', 1), 100)
    cache.put('k', rows('b', 1), 60)
    const [entry] = cache.get('k')!
    expect(entry).toBe('b0')
    // 60 + the next put's 60 exceeds the 200 budget only once both are held.
    cache.put('j', rows('c', 1), 60)
    expect(cache.get('j')).toBeDefined()
  })

  it('evicts the coldest entries over the byte budget and keeps the newest window working set', () => {
    const cache = new MayflyContentCache(MAYFLY_CONTENT_CACHE_KEEP + 10)
    // Fill past the keep floor with one-unit entries, then push over the byte budget.
    for (let index = 0; index < MAYFLY_CONTENT_CACHE_KEEP + 20; index += 1) cache.put(`k${String(index)}`, ['x'], 1)
    expect(cache.get('k0')).toBeUndefined()
    // The freshest KEEP entries are never evicted, however large the byte pressure.
    for (let index = MAYFLY_CONTENT_CACHE_KEEP; index < MAYFLY_CONTENT_CACHE_KEEP + 20; index += 1) {
      expect(cache.get(`k${String(index)}`)).toEqual(['x'])
    }
  })

  it('spares a refreshed entry when the next put evicts past the byte budget', () => {
    const cache = new MayflyContentCache(MAYFLY_CONTENT_CACHE_KEEP + 2)
    for (let index = 0; index < MAYFLY_CONTENT_CACHE_KEEP + 2; index += 1) cache.put(`k${String(index)}`, ['x'], 1)
    cache.get('k0')
    cache.put('knew', ['n'], 1)
    // Over budget with more than KEEP entries: the coldest falls — 'k1', since 'k0' refreshed to the newest end.
    expect(cache.get('k1')).toBeUndefined()
    expect(cache.get('k0')).toEqual(['x'])
    expect(cache.get('knew')).toEqual(['n'])
  })
})
