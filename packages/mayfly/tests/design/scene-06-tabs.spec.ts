/**
 * Scene 6, Tabs, wizards, rails (roadmap slice 1.5): the four pages of `ui-preview.mjs`, each built with the real
 * builders and driven with the keys of every golden walk. Every frame is compared cell by cell with the prototype; the
 * rail's form block belongs to slice 1.6 and is covered by the pending ledger.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { walks } from '../../../../script/design-golden-walks.mjs'
import { createRealSurface, parityComponents, readGoldenFrames, type RealSurface } from './parity.ts'
import { PENDING_PARITY, pendingFor } from './pending.ts'
import { badgeWaivers, diffReport, frameDiffs } from './scene.ts'
import { pageNode } from './scene-06.ts'

const NEXT = '\x0e'
const NARROW = '\x17'

/** The rows of the surface itself: the prototype also prints its captions above it. */
const surfaceRows = (rows: readonly string[]): readonly string[] => {
  const start = rows.findIndex(row => row.replace(/\x1b\[[0-9;]*m/gu, '').startsWith('╭'))
  return start < 0 ? rows : rows.slice(start)
}

const surfaces: RealSurface[] = []
afterEach(() => { for (const surface of surfaces.splice(0)) surface.dispose() })

/** The width the prototype draws a page at. */
const pageWidth = (page: number, narrow: boolean): number => page === 3 ? (narrow ? 40 : 76) : 78

function open(page: number, narrow: boolean): RealSurface {
  const surface = createRealSurface(pageNode(page), pageWidth(page, narrow), {
    components: parityComponents(),
    overrides: { onUnhandledEscape: () => {}, escapeHint: 'close' },
  })
  surfaces.push(surface)
  return surface
}

const SCENE_WALKS = walks().filter(walk => walk.scene === 6)

describe('scene 6, Tabs, wizards, rails', () => {
  it('has a ledger entry only for walks the scene has', () => {
    expect(PENDING_PARITY.filter(entry => entry.directory === '06-tabs-wizards-rails').every(entry => SCENE_WALKS.some(walk => walk.name === entry.walk))).toBe(true)
  })

  it.each(SCENE_WALKS.map(walk => [walk.name, walk] as const))('walk %s matches the prototype cell by cell', async (_name, walk) => {
    const frames = readGoldenFrames(walk.dir, walk.name)
    let page = 0
    let narrow = false
    let surface = open(page, narrow)
    const report: string[] = []
    for (const [index, step] of walk.steps.entries()) {
      if (typeof step === 'string' && step !== '\0') {
        if (step === NEXT) { page = (page + 1) % 4; surface = open(page, narrow) }
        else if (step === NARROW) { if (page === 3) { narrow = !narrow; surface = open(page, narrow) } }
        else surface.press(step)
      }
      const owed = pendingFor(walk.dir, walk.name, index)
      const waivers = badgeWaivers(surfaceRows(frames[index]!.rows), surface.render())
      // A pending entry cannot go stale: the frame it covers must still differ.
      if (owed.length > 0) expect((await frameDiffs(surfaceRows(frames[index]!.rows), surface.render(), 96)).length, `${walk.name} frame ${String(index)} is still pending`).toBeGreaterThan(0)
      const diffs = await frameDiffs(surfaceRows(frames[index]!.rows), surface.render(), 96, waivers, owed)
      if (diffs.length > 0) report.push(`frame ${String(index)}:\n${diffReport(diffs)}`)
    }
    expect(report.join('\n')).toBe('')
  })
})
