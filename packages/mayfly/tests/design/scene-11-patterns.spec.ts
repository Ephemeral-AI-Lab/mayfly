/**
 * Scene 11, Patterns (roadmap slices 1.5 and 1.8b): `patterns.decisionPanel`, `railPanel`, `splitView`, and `statusPage`
 * called with the scene's props, each page driven with the keys of every walk and compared with its grid golden.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createRealSurface, expectFrames, probeComponents, type Frame, type RealSurface } from './probe.ts'
import { NEXT, sceneWalks, stepLabel } from './walks.ts'
import { pageNode, pageWidth } from './scene-11.ts'

const strip = (row: string): string => row.replace(/\x1b\[[0-9;]*m/gu, '')

const surfaces: RealSurface[] = []
afterEach(() => { for (const surface of surfaces.splice(0)) surface.dispose() })

function open(page: number): RealSurface {
  const surface = createRealSurface(pageNode(page), pageWidth(page), {
    components: probeComponents(),
    overrides: { onUnhandledEscape: () => {}, escapeHint: 'close' },
  })
  surfaces.push(surface)
  return surface
}

describe('scene 11, Patterns', () => {
  it.each(sceneWalks(11).map(walk => [walk.name, walk] as const))('walk %s paints its grid golden', async (_name, walk) => {
    let page = 0
    let surface = open(page)
    const frames: Frame[] = []
    for (const step of walk.steps) {
      if (typeof step === 'string' && step !== '\0') {
        if (step === NEXT) { page = (page + 1) % 4; surface = open(page) }
        else surface.press(step)
      }
      frames.push({ label: stepLabel(step), rows: surface.render(), width: pageWidth(page) })
    }
    await expectFrames(`${walk.dir}/${walk.name}`, frames)
  })
})

describe('scene 11, Patterns, page 1: the decision card\'s keys', () => {
  const hintRow = (surface: RealSurface): string => strip(surface.render().at(-2)!).replace(/[│╭╮╰╯]/gu, '').trim()

  it('Δ31: a card framed at 80 columns hints three fragments, and Esc rejects', () => {
    const surface = open(0)
    expect(hintRow(surface)).toBe('Enter choose · c copy name · Esc reject')
  })

  it('Δ32: the c accelerator runs from the choices, and is neither bound nor hinted once the note field holds focus', () => {
    const events: string[] = []
    const surface = createRealSurface(pageNode(0), 80, { components: probeComponents(), events: event => { events.push(event.kind === 'activate' ? event.actionId : event.kind) } })
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

