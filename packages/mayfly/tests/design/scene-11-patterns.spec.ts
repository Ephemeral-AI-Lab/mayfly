/**
 * Scene 11, Patterns, page 2 (roadmap slice 1.5): `railPanel`, a rail of labels on the left and live content on the
 * right, built here from the same `ui.*` nodes the pattern will compose (slice 1.8b adds `patterns.railPanel` and the
 * other three pages). The rail's labels, counts, and cursor arrow are slice 1.5's; the pattern call is 1.8b's.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createRealSurface, parityComponents, readGoldenFrames, type RealSurface } from './parity.ts'
import { PENDING_PARITY, pendingFor } from './pending.ts'
import { diffReport, frameDiffs } from './scene.ts'
import { railPanelNode } from './scene-06.ts'

const surfaces: RealSurface[] = []
afterEach(() => { for (const surface of surfaces.splice(0)) surface.dispose() })

const surfaceRows = (rows: readonly string[]): readonly string[] => {
  const start = rows.findIndex(row => row.replace(/\x1b\[[0-9;]*m/gu, '').startsWith('╭'))
  return start < 0 ? rows : rows.slice(start)
}

describe('scene 11, Patterns, page 2: railPanel', () => {
  it('draws the rail, its counts and cursor, and the live list as the prototype does', async () => {
    const surface = createRealSurface(railPanelNode(), 80, { components: parityComponents(), overrides: { onUnhandledEscape: () => {}, escapeHint: 'close' } })
    surfaces.push(surface)
    for (const walk of ['page-2', 'pages']) {
      const frame = readGoldenFrames('11-patterns', walk)[1]!
      expect(diffReport(await frameDiffs(surfaceRows(frame.rows), surface.render(), 96, [], pendingFor('11-patterns', walk, 1)))).toBe('')
    }
  })

  it('leaves the other pages to slice 1.8b in the ledger', () => {
    const owed = PENDING_PARITY.filter(entry => entry.directory === '11-patterns')
    expect(owed.length).toBeGreaterThan(0)
    expect(owed.every(entry => entry.slice === '1.8b')).toBe(true)
    for (const walk of ['page-2', 'pages']) expect(pendingFor('11-patterns', walk, 1)).toEqual([])
  })
})
