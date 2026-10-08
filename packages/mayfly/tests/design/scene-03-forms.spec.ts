/**
 * Scenes 3, 4, and 12 (roadmap slice 1.6, Forms): the field kinds with their group headings, help lines, marks and
 * units, the buttons, the `unsaved changes` badge, and a textarea that opens its box. Each scene is built with the real
 * builders and driven with the keys of every golden walk; every frame is compared cell by cell with the prototype.
 *
 * The prototype also prints a caption above the surface (and scene 12 a status row below it); those belong to other
 * slices, so the comparison starts at the surface's top rule and ends at its bottom rule. The prototype draws a host
 * reply inside the surface; the renderer draws it under the bottom rule, so the reply is compared as text.
 * Two accepted differences apply (`deltas.ts`): the cursor glyph `▌` (Δ27) and the dirty badge in scenes 4 and 12 (Δ28).
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { MayflyUiEvent } from '../../../ui/src/index.ts'
import { walks } from '../../../../script/design-golden-walks.mjs'
import { createRealSurface, parityComponents, readGoldenFrames, type ParityWaiver, type RealSurface } from './parity.ts'
import { PENDING_PARITY, PENDING_WALKS, pendingFor, pendingWalk } from './pending.ts'
import { diffReport, frameDiffs } from './scene.ts'
import { scene12, scene3, scene4 } from './scene-03.ts'

const plain = (row: string): string => row.replace(/\x1b\[[0-9;]*m/gu, '').replace(/\x1b_[^\x07]*\x07/gu, '')

/** The rows of the surface itself: from its top rule to its bottom rule. */
const surfaceRows = (rows: readonly string[]): readonly string[] => {
  const start = rows.findIndex(row => plain(row).startsWith('╭'))
  const end = rows.findIndex(row => plain(row).startsWith('╰'))
  return start < 0 || end < 0 ? rows : rows.slice(start, end + 1)
}

/** The prototype's host reply, drawn inside the surface as `│ ⚠ message`; the renderer draws it under the bottom rule. */
const FOOTER = /^│ ([⚠✗✓ℹ] .*?)\s*│$/u
const footerOf = (rows: readonly string[]): string | undefined => rows.map(row => FOOTER.exec(plain(row))?.[1]).find(text => text !== undefined)
const withoutFooter = (rows: readonly string[]): readonly string[] => rows.filter(row => !FOOTER.test(plain(row)))
const feedbackOf = (rows: readonly string[]): string | undefined => {
  const end = rows.findIndex(row => plain(row).startsWith('╰'))
  const text = end < 0 ? undefined : rows.slice(end + 1).map(plain).join('').trim()
  return text === '' ? undefined : text
}

/** Δ27: the cells of the prototype's `▌`. */
function cursorWaivers(golden: readonly string[]): ParityWaiver[] {
  return golden.flatMap((row, index) => Array.from(plain(row)).flatMap((ch, col) => ch === '▌' ? [{ delta: 'Δ27', rows: [index, index] as const, cols: [col, col] as const }] : []))
}

/** Δ28: the badge the renderer adds to a dirty surface the prototype did not badge. */
function badgeWaivers(golden: readonly string[], actual: readonly string[]): ParityWaiver[] {
  const text = plain(actual[0] ?? '')
  const at = text.indexOf('unsaved changes')
  return at < 0 || plain(golden[0] ?? '').includes('unsaved changes') ? [] : [{ delta: 'Δ28', rows: [0, 0], cols: [at - 1, at + 'unsaved changes'.length] }]
}

const SCENES = [
  { scene: 3, node: scene3, width: 76 },
  { scene: 4, node: scene4, width: 76 },
  { scene: 12, node: scene12, width: 90 },
] as const

const surfaces: RealSurface[] = []
afterEach(() => { for (const surface of surfaces.splice(0)) surface.dispose() })

function open(scene: typeof SCENES[number]) {
  const events: MayflyUiEvent[] = []
  const surface = createRealSurface(scene.node(), scene.width, {
    components: parityComponents(),
    events: event => events.push(event),
    overrides: { onUnhandledEscape: () => {}, escapeHint: 'close' },
  })
  surfaces.push(surface)
  return { surface, events }
}

/** The host's reply to a submitted form lands on a later turn; the prototype paints before it. */
const settle = async (): Promise<void> => { await new Promise<void>(resolve => setTimeout(resolve, 0)); await new Promise<void>(resolve => setTimeout(resolve, 0)) }

describe.each(SCENES)('scene $scene', scene => {
  const sceneWalks = walks().filter(walk => walk.scene === scene.scene)

  it('has a ledger entry only for walks the scene has', () => {
    expect(PENDING_WALKS.filter(entry => entry.scene === scene.scene).every(entry => sceneWalks.some(walk => walk.name === entry.walk))).toBe(true)
    expect(PENDING_PARITY.filter(entry => entry.directory.startsWith(String(scene.scene).padStart(2, '0'))).every(entry => sceneWalks.some(walk => walk.name === entry.walk))).toBe(true)
  })

  it.each(sceneWalks.map(walk => [walk.name, walk] as const))('walk %s matches the prototype cell by cell, or is pending', async (_name, walk) => {
    const frames = readGoldenFrames(walk.dir, walk.name)
    const { surface } = open(scene)
    let differs = false
    const report: string[] = []
    for (const [index, step] of walk.steps.entries()) {
      if (typeof step === 'string' && step !== '\0') { surface.press(step); await settle() }
      const all = surface.render()
      const golden = surfaceRows(frames[index]!.rows)
      const expected = withoutFooter(golden)
      const actual = surfaceRows(all)
      const owed = pendingFor(walk.dir, walk.name, index)
      // A pending entry cannot go stale: the frame it covers must still differ.
      if (owed.length > 0) expect((await frameDiffs(expected, actual, 96)).length, `${walk.name} frame ${String(index)} is still pending`).toBeGreaterThan(0)
      const diffs = await frameDiffs(expected, actual, 96, [...cursorWaivers(golden), ...badgeWaivers(expected, actual)], owed)
      if (diffs.length > 0) { differs = true; report.push(`frame ${String(index)}:\n${diffReport(diffs)}`) }
      const feedback = feedbackOf(all)
      if (feedback !== footerOf(golden) && owed.length === 0) { differs = true; report.push(`frame ${String(index)}: host reply ${JSON.stringify(feedback)} != ${JSON.stringify(footerOf(golden))}`) }
    }
    expect(differs, `${pendingWalk(scene.scene, walk.name)?.reason ?? 'a matched walk'}\n${report.join('\n')}`).toBe(pendingWalk(scene.scene, walk.name) !== undefined)
  })
})
