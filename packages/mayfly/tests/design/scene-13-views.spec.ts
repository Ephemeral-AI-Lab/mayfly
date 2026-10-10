/**
 * Scene 13, Status area (roadmap slice 1.10b): the views lane only. The lane owns the tab strip, the rule under the
 * active tab, and the panel's place in status row 2; the rest of the scene (row 1, the editor frame, the panel bodies)
 * belongs to later phases. Each walk is replayed on a real lane through the keys the scene sends, and the footer it
 * draws at every step is compared with its grid golden.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { MayflyStatusService } from '../../../ui/src/provider.ts'
import { ViewsLane } from '../../src/core/views-lane.ts'
import type { MayflyFocusable } from '../../src/core/types.ts'
import { StatusFooterComponent } from '../../src/transcript/status-model.ts'
import { PROBE_PALETTE, expectFrames, probeComponents, type Frame } from './probe.ts'
import { ALT_DOWN, sceneWalks, stepLabel } from './walks.ts'

const WIDTH = 100

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
  const footer = new StatusFooterComponent(new MayflyStatusService(new Context()), probeComponents(), PROBE_PALETTE, () => ({ columns: WIDTH, rows: 30 }), lane)
  return { lane, footer, escapes }
}

/** The steps of each walk at which the lane is entered: Alt+↓ enters, `x` and Esc leave, arrows move inside. */
const ENTERED: Readonly<Record<string, readonly number[]>> = { 'views': [1], 'views-next': [1, 2, 3], 'views-stop': [1, 2], 'views-back': [1] }

describe('scene 13 Status area, the views lane', () => {
  it.each(sceneWalks(13).map(walk => [walk.name, walk] as const))('walk %s paints its grid golden and enters the lane at the agreed steps', async (_name, walk) => {
    const rigged = rig()
    const entered: number[] = []
    const frames: Frame[] = []
    for (const [index, step] of walk.steps.entries()) {
      if (step === ALT_DOWN) expect(rigged.lane.enter()).toBe(true)
      else if (typeof step === 'string' && step !== '\0') rigged.lane.component.handleInput!(step)
      if (rigged.lane.isEntered) entered.push(index)
      frames.push({ label: stepLabel(step), rows: rigged.footer.render(WIDTH), width: WIDTH })
    }
    expect(entered).toEqual(ENTERED[walk.name])
    await expectFrames(`${walk.dir}/${walk.name}`, frames)
  })
})
