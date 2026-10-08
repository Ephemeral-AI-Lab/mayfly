/**
 * Scene 15, Editor (roadmap slice 1.9b): the prompt alone. Every golden walk is replayed with the real keys through
 * the real compiler, and the frame the prompt draws (the right-titled surface with its input row, recall corner,
 * completion list, and key line) is compared cell by cell with the prototype at 96, 60, and 40 columns. The queue line
 * and the scene caption above the frame belong to the Editor component of Phase 5 (`pending.ts`).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { walks } from '../../../../script/design-golden-walks.mjs'
import { readGoldenFrames } from './parity.ts'
import { PENDING_PARITY, pendingFor } from './pending.ts'
import { diffReport, frameDiffs } from './scene.ts'
import { editorHost, type EditorHost } from './scene-15.ts'

const SCENE_WALKS = walks().filter(walk => walk.scene === 15)
const hosts: EditorHost[] = []
afterEach(() => { for (const host of hosts.splice(0)) host.dispose() })

/** The rows above the frame: the caption, a blank row, and the queue line, which the Editor component of Phase 5 draws. */
const ABOVE = ['', '', ''] as const

describe('scene 15, Editor', () => {
  it('has a ledger only for frames the walks have', () => {
    for (const entry of PENDING_PARITY.filter(candidate => candidate.directory === '15-editor')) {
      const walk = SCENE_WALKS.find(candidate => candidate.name === entry.walk)
      expect(walk, entry.walk).toBeDefined()
      expect(Math.max(...entry.frames), entry.walk).toBeLessThan(walk!.steps.length)
    }
  })

  it.each(SCENE_WALKS.map(walk => [walk.name, walk] as const))('walk %s matches the prototype cell by cell', async (_name, walk) => {
    const frames = readGoldenFrames(walk.dir, walk.name)
    const host = editorHost()
    hosts.push(host)
    for (const [index, step] of walk.steps.entries()) {
      if (typeof step === 'string' && step !== '\0') host.press(step)
      const owed = pendingFor(walk.dir, walk.name, index)
      const rows = [...ABOVE, ...host.render()]
      // A pending entry cannot go stale: the rows it covers must still differ.
      expect((await frameDiffs(frames[index]!.rows, rows, 96)).every(diff => diff.row <= 2), `${walk.name} frame ${String(index)}`).toBe(true)
      expect(owed.length).toBeGreaterThan(0)
      const diffs = await frameDiffs(frames[index]!.rows, rows, 96, [], owed)
      expect(diffReport(diffs), `${walk.name} frame ${String(index)} at ${String(host.width())} columns`).toBe('')
    }
  })
})
