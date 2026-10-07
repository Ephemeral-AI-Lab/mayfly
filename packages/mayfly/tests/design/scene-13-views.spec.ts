/**
 * Scene 13, Status area (roadmap slice 1.10b): the views lane only. The lane owns the tab strip, the rule under the
 * active tab, and the panel's place in status row 2; everything else in the scene (row 1, the editor frame, the idle
 * row 2 with its right cue, and the panel bodies) belongs to a later phase and is listed in `pending.ts`. Each golden
 * walk is replayed on a real lane through the keys the scene sends, and every frame is compared cell by cell wherever
 * no ledger entry covers it.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { MayflyStatusService } from '../../../ui/src/provider.ts'
import { walks } from '../../../../script/design-golden-walks.mjs'
import { ViewsLane } from '../../src/core/views-lane.ts'
import type { MayflyFocusable } from '../../src/core/types.ts'
import { StatusFooterComponent } from '../../src/transcript/status-model.ts'
import { diffReport, frameDiffs, goldenRows } from './scene.ts'
import { PROBE_PALETTE, parityComponents } from './parity.ts'
import { PENDING_PARITY, pendingFor } from './pending.ts'

const WIDTH = 100
const ALT_DOWN = '\x1b[1;3B'
const SCENE_WALKS = walks().filter(walk => walk.scene === 13 && walk.name.startsWith('views'))

/** Row 2's four views as the scene prints them: summaries, tab titles and counts. */
const VIEWS = [
  { id: 'agents', title: 'Agents', count: 5, summary: 'Agents 5 ● 1 waiting' },
  { id: 'jobs', title: 'Jobs', count: 3, summary: 'Jobs 3 ⏵ 2 running' },
  { id: 'goal', title: 'Goal', summary: 'Goal ● 2/8' },
  { id: 'todo', title: 'Todo', count: '4/6', summary: 'Todo 4/6 ● Bump changelog' },
] as const

interface Rig {
  readonly lane: ViewsLane
  readonly footer: StatusFooterComponent
  readonly escapes: number[]
}

function rig(): Rig {
  const lane = new ViewsLane()
  const escapes: number[] = []
  const focus = (component: MayflyFocusable): void => { component.focused = true }
  lane.bind({
    colors: PROBE_PALETTE,
    focus,
    release: () => { escapes.push(1); lane.component.focused = false; lane.focusLost() },
    requestRender: () => {},
    viewport: () => ({ columns: WIDTH, rows: 30 }),
  })
  for (const [index, view] of VIEWS.entries()) {
    const panel: MayflyFocusable = { focused: false, render: () => [`  ${view.title} panel`], invalidate: () => {}, handleInput: data => { if (data === '\x1b') lane.leave() } }
    lane.register({
      id: view.id, title: view.title, priority: index,
      summary: { node: { kind: 'text', content: view.summary }, ...('count' in view ? { count: view.count } : {}) },
    }).setPanel(panel, panel)
  }
  const footer = new StatusFooterComponent(new MayflyStatusService(new Context()), parityComponents(), PROBE_PALETTE, () => ({ columns: WIDTH, rows: 30 }), lane)
  return { lane, footer, escapes }
}

/** The scene frame the lane can draw: nothing above row 2, then row 2 or the entered panel. */
function laneFrame(rigged: Rig): string[] {
  return ['', '', '', '', '', '', '', '', ...rigged.footer.render(WIDTH)]
}

describe('scene 13 Status area, the views lane', () => {
  it('has a ledger only for frames the walks have', () => {
    for (const entry of PENDING_PARITY.filter(candidate => candidate.directory === '13-status-area')) {
      const walk = SCENE_WALKS.find(candidate => candidate.name === entry.walk)
      expect(walk, entry.walk).toBeDefined()
      expect(Math.max(...entry.frames), entry.walk).toBeLessThan(walk!.steps.length)
    }
  })

  it.each(SCENE_WALKS.map(walk => [walk.name, walk] as const))('walk %s matches the prototype wherever the lane draws', async (_name, walk) => {
    const rigged = rig()
    const entered: boolean[] = []
    for (const [index, step] of walk.steps.entries()) {
      if (step === ALT_DOWN) expect(rigged.lane.enter()).toBe(true)
      else if (typeof step === 'string' && step !== '\0') rigged.lane.component.handleInput(step)
      entered.push(rigged.lane.isEntered)
      const diffs = await frameDiffs(goldenRows(walk.dir, walk.name, index), laneFrame(rigged), WIDTH, [], pendingFor(walk.dir, walk.name, index))
      expect(diffReport(diffs), `${walk.name} frame ${String(index)}`).toBe('')
    }
    // The ledger names the frames in which the lane is entered; the walk must agree.
    const ledger = PENDING_PARITY.find(entry => entry.directory === walk.dir && entry.walk === walk.name && entry.rows?.[0] === 10)!
    expect(entered.flatMap((flag, index) => flag ? [index] : [])).toEqual([...ledger.frames])
  })

})
