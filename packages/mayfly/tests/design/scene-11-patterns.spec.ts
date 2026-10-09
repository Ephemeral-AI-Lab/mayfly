/**
 * Scene 11, Patterns (roadmap slices 1.5 and 1.8b): `patterns.decisionPanel`, `railPanel`, `splitView`, and `statusPage`
 * called with the props the prototype passes, each page driven with the keys of every golden walk and compared cell by
 * cell with the prototype.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { walks } from '../../../../script/design-golden-walks.mjs'
import { createRealSurface, parityComponents, readGoldenFrames, type ParityWaiver, type RealSurface } from './parity.ts'
import { PENDING_PARITY, pendingFor } from './pending.ts'
import { badgeWaivers, diffReport, frameDiffs } from './scene.ts'
import { pageNode, pageWidth } from './scene-11.ts'

const NEXT = '\x0e'
const strip = (row: string): string => row.replace(/\x1b\[[0-9;]*m/gu, '')

/** The rows of the page itself: the prototype also prints its caption and a blank row above it. */
const bodyRows = (rows: readonly string[]): readonly string[] => {
  const start = rows.findIndex(row => strip(row).startsWith('╭'))
  if (start >= 0) return rows.slice(start)
  const blank = rows.findIndex(row => strip(row).trim() === '')
  return blank < 0 ? rows : rows.slice(blank + 1)
}

/** Δ30 and Δ31: the decision card's hint row, which holds three fragments and no printable accelerator beside the note field. */
const HINT_ROW: readonly ParityWaiver[] = [{ delta: 'Δ30', rows: [7, 7] }, { delta: 'Δ31', rows: [7, 7] }]

const surfaces: RealSurface[] = []
afterEach(() => { for (const surface of surfaces.splice(0)) surface.dispose() })

function open(page: number): RealSurface {
  const surface = createRealSurface(pageNode(page), pageWidth(page), {
    components: parityComponents(),
    overrides: { onUnhandledEscape: () => {}, escapeHint: 'close' },
  })
  surfaces.push(surface)
  return surface
}

const SCENE_WALKS = walks().filter(walk => walk.scene === 11)

describe('scene 11, Patterns', () => {
  it('has a ledger entry only for walks the scene has', () => {
    expect(PENDING_PARITY.filter(entry => entry.directory === '11-patterns').every(entry => SCENE_WALKS.some(walk => walk.name === entry.walk))).toBe(true)
  })

  it.each(SCENE_WALKS.map(walk => [walk.name, walk] as const))('walk %s matches the prototype cell by cell', async (_name, walk) => {
    const frames = readGoldenFrames(walk.dir, walk.name)
    let page = 0
    let surface = open(page)
    const report: string[] = []
    for (const [index, step] of walk.steps.entries()) {
      if (typeof step === 'string' && step !== '\0') {
        if (step === NEXT) { page = (page + 1) % 4; surface = open(page) }
        else surface.press(step)
      }
      const golden = bodyRows(frames[index]!.rows)
      const owed = pendingFor(walk.dir, walk.name, index)
      const waivers = [...badgeWaivers(golden, surface.render()), ...page === 0 ? HINT_ROW : []]
      if (owed.length > 0) expect((await frameDiffs(golden, surface.render(), 100)).length, `${walk.name} frame ${String(index)} is still pending`).toBeGreaterThan(0)
      const diffs = await frameDiffs(golden, surface.render(), 100, waivers, owed)
      if (diffs.length > 0) report.push(`frame ${String(index)}:\n${diffReport(diffs)}`)
    }
    expect(report.join('\n')).toBe('')
  })
})

describe('scene 11, Patterns, page 1: the differences the ledger of deltas names', () => {
  const hintRow = (surface: RealSurface): string => strip(surface.render().at(-2)!).replace(/[│╭╮╰╯]/gu, '').trim()

  it('Δ30: a card framed at 80 columns hints three fragments, and Esc rejects', () => {
    const surface = open(0)
    expect(hintRow(surface)).toBe('Enter choose · c copy name · Esc reject')
  })

  it('Δ31: the c accelerator runs from the choices, and is neither bound nor hinted once the note field holds focus', () => {
    const events: string[] = []
    const surface = createRealSurface(pageNode(0), 80, { components: parityComponents(), events: event => { events.push(event.kind === 'activate' ? event.actionId : event.kind) } })
    surfaces.push(surface)
    surface.press('c')
    expect(events).toContain('copy')
    events.length = 0
    for (let index = 0; index < 3; index += 1) surface.press('\x1b[B')
    expect(hintRow(surface)).toBe('↑/↓ fields · Enter edit · Esc back')
    surface.press('c')
    expect(events).not.toContain('copy')
  })
})

