/**
 * Scene 6, Tabs, wizards, rails (roadmap slice 1.5): the four pages of the scene, each built with the real builders and
 * driven with the keys of every walk; every frame is compared with its grid golden.
 */
import { afterEach, describe, it } from 'vitest'
import { createRealSurface, expectFrames, probeComponents, type Frame, type RealSurface } from './probe.ts'
import { NARROW, NEXT, sceneWalks, stepLabel } from './walks.ts'
import { pageNode } from './scene-06.ts'

const surfaces: RealSurface[] = []
afterEach(() => { for (const surface of surfaces.splice(0)) surface.dispose() })

/** The width a page is drawn at. */
const pageWidth = (page: number, narrow: boolean): number => page === 3 ? (narrow ? 40 : 76) : 78

function open(page: number, narrow: boolean): RealSurface {
  const surface = createRealSurface(pageNode(page), pageWidth(page, narrow), {
    components: probeComponents(),
    overrides: { onUnhandledEscape: () => {}, escapeHint: 'close' },
  })
  surfaces.push(surface)
  return surface
}

describe('scene 6, Tabs, wizards, rails', () => {
  it.each(sceneWalks(6).map(walk => [walk.name, walk] as const))('walk %s paints its grid golden', async (_name, walk) => {
    let page = 0
    let narrow = false
    let surface = open(page, narrow)
    const frames: Frame[] = []
    for (const step of walk.steps) {
      if (typeof step === 'string' && step !== '\0') {
        if (step === NEXT) { page = (page + 1) % 4; surface = open(page, narrow) }
        else if (step === NARROW) { if (page === 3) { narrow = !narrow; surface = open(page, narrow) } }
        else surface.press(step)
      }
      frames.push({ label: stepLabel(step), rows: surface.render(), width: pageWidth(page, narrow) })
    }
    await expectFrames(`${walk.dir}/${walk.name}`, frames)
  })
})
