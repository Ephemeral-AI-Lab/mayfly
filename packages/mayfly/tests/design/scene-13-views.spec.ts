/**
 * Scene 13, Status area (roadmap slice 1.10b, restated by Phase 5): the views lane and the footer that shows its items. The
 * footer is the one status row (`buildStatusFooter`, compiled by the real compiler under the probe palette) with a heavy line
 * under the entered item's words; the panel opens under it. The rest of the scene (the facts of the row, the editor frame, the panel
 * bodies) is the transcript's. Each walk is replayed on a real lane through the keys the scene sends, and the footer and panel it
 * draws at every step are compared with its grid golden.
 */
import { describe, expect, it } from 'vitest'
import type { MayflyStatusEntry } from '../../../ui/src/index.ts'
import { ViewsLane } from '../../src/core/views-lane.ts'
import type { MayflyFocusable } from '../../src/core/types.ts'
import { compileMayflyUiNode } from '../../src/core/ui-compiler.ts'
import { buildStatusFooter } from '../../src/transcript/status-rows.ts'
import { PROBE_PALETTE, expectFrames, probeComponents, type Frame } from './probe.ts'
import { ALT_DOWN, sceneWalks, stepLabel } from './walks.ts'

const WIDTH = 100

/** The four views as the scene prints them: the items of the status row. */
const VIEWS = [
  { id: 'agents', summary: '● agents 1/5 41s' },
  { id: 'jobs', summary: '● jobs 3 12s' },
  { id: 'goal', summary: '● goal 2/8 1m 59s' },
  { id: 'todo', summary: '● todo 4/6 4m 12s' },
] as const

interface Rig {
  readonly lane: ViewsLane
  /** The footer at the lane's present state, and the panel under it while a view is entered. */
  rows(): string[]
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
    const panel: MayflyFocusable = { focused: false, render: () => [`  ${view.id} panel`], invalidate: () => {}, handleInput: data => { if (data === '\x1b') lane.leave() } }
    lane.register({ id: view.id, priority: index, summary: { node: { kind: 'text', content: view.summary } } }).setPanel(panel, panel)
  }
  const rows = (): string[] => {
    const entries: readonly MayflyStatusEntry[] = lane.statusEntries()
    const node = buildStatusFooter(entries, { active: lane.isEntered && lane.active !== undefined ? `views/${lane.active}` : undefined })
    const compiled = node === null ? undefined : compileMayflyUiNode(node, { components: probeComponents(), colors: PROBE_PALETTE, getViewport: () => ({ columns: WIDTH, rows: 30 }), screenMode: 'alternate', emit: () => {} })
    const footer = compiled === undefined ? [] : (compiled.ok ? compiled.value.component : compiled.errorComponent).render(WIDTH)
    return [...footer, ...lane.panel(WIDTH) ?? []]
  }
  return { lane, rows, escapes }
}

/** The steps of each walk at which the lane is entered: Alt+↓ enters, `x` and Esc leave, arrows move inside. */
const ENTERED: Readonly<Record<string, readonly number[]>> = { 'views': [1], 'views-next': [1, 2, 3], 'views-stop': [1, 2], 'views-back': [1] }

describe('scene 13 Status area, the views lane and its items', () => {
  it.each(sceneWalks(13).map(walk => [walk.name, walk] as const))('walk %s paints its grid golden and enters the lane at the agreed steps', async (_name, walk) => {
    const rigged = rig()
    const entered: number[] = []
    const frames: Frame[] = []
    for (const [index, step] of walk.steps.entries()) {
      if (step === ALT_DOWN) expect(rigged.lane.enter()).toBe(true)
      else if (typeof step === 'string' && step !== '\0') rigged.lane.component.handleInput!(step)
      if (rigged.lane.isEntered) entered.push(index)
      frames.push({ label: stepLabel(step), rows: rigged.rows(), width: WIDTH })
    }
    expect(entered).toEqual(ENTERED[walk.name])
    await expectFrames(`${walk.dir}/${walk.name}`, frames)
  })
})
