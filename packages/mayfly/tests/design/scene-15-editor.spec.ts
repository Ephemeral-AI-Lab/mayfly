/**
 * Scene 15, Editor (roadmap slice 1.9b): the prompt alone. Every walk is replayed with the real keys through the real
 * compiler, and the frame the prompt draws (the right-titled surface with its input row, recall corner, completion
 * list, and key line) at 96, 60, and 40 columns is compared with its grid golden. The queue line and the scene caption
 * above the frame belong to the Editor component of Phase 5.
 */
import { afterEach, describe, it } from 'vitest'
import { expectFrames, type Frame } from './probe.ts'
import { sceneWalks, stepLabel } from './walks.ts'
import { editorHost, type EditorHost } from './scene-15.ts'

const hosts: EditorHost[] = []
afterEach(() => { for (const host of hosts.splice(0)) host.dispose() })

describe('scene 15, Editor', () => {
  it.each(sceneWalks(15).map(walk => [walk.name, walk] as const))('walk %s paints its grid golden', async (_name, walk) => {
    const host = editorHost()
    hosts.push(host)
    const frames: Frame[] = []
    for (const step of walk.steps) {
      if (typeof step === 'string' && step !== '\0') host.press(step)
      frames.push({ label: stepLabel(step), rows: host.render(), width: host.width() })
    }
    await expectFrames(`${walk.dir}/${walk.name}`, frames)
  })
})
