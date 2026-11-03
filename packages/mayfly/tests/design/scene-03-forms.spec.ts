/**
 * Scenes 3, 4, and 12 (roadmap slice 1.6, Forms): the field kinds with their group headings, help lines, marks and
 * units, the buttons, the `unsaved changes` badge, and a textarea that opens its box. Each scene is built with the real
 * builders and driven with the keys of every walk; every frame, the host's reply under the bottom rule included, is
 * compared with its grid golden.
 */
import { afterEach, describe, it } from 'vitest'
import { createRealSurface, expectFrames, probeComponents, type Frame, type RealSurface } from './probe.ts'
import { sceneWalks, stepLabel } from './walks.ts'
import { scene12, scene3, scene4 } from './scene-03.ts'

const SCENES = [
  { scene: 3, node: scene3, width: 76 },
  { scene: 4, node: scene4, width: 76 },
  { scene: 12, node: scene12, width: 90 },
] as const

const surfaces: RealSurface[] = []
afterEach(() => { for (const surface of surfaces.splice(0)) surface.dispose() })

function open(scene: typeof SCENES[number]): RealSurface {
  const surface = createRealSurface(scene.node(), scene.width, {
    components: probeComponents(),
    overrides: { onUnhandledEscape: () => {}, escapeHint: 'close' },
  })
  surfaces.push(surface)
  return surface
}

/** The host's reply to a submitted form lands on a later turn; each frame is painted after it. */
const settle = async (): Promise<void> => { await new Promise<void>(resolve => setTimeout(resolve, 0)); await new Promise<void>(resolve => setTimeout(resolve, 0)) }

describe.each(SCENES)('scene $scene', scene => {
  it.each(sceneWalks(scene.scene).map(walk => [walk.name, walk] as const))('walk %s paints its grid golden', async (_name, walk) => {
    const surface = open(scene)
    const frames: Frame[] = []
    for (const step of walk.steps) {
      if (typeof step === 'string' && step !== '\0') { surface.press(step); await settle() }
      frames.push({ label: stepLabel(step), rows: surface.render(), width: scene.width })
    }
    await expectFrames(`${walk.dir}/${walk.name}`, frames)
  })
})
