/**
 * Scene 7, Surfaces and scroll (roadmap slice 1.3): the four chromes, a scroll region that follows its tail with a
 * scrollbar, `Ctrl+E` to expand it, and a header badge, driven through the scene's walks with the real compiler and
 * compared cell by cell with the prototype.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ui, type MayflyUiNode } from '../../../ui/src/index.ts'
import { walks } from '../../../../script/design-golden-walks.mjs'
import { MayflyUiSurfaceRuntime, compileMayflyUiSurfaceNode } from '../../src/core/ui-compiler.ts'
import { UiSurfaceModel } from '../../src/core/ui-interaction-surface.ts'
import { caption, diffReport, frameDiffs, goldenRows, paint } from './scene.ts'
import { PROBE_PALETTE, parityComponents, readGoldenFrames } from './parity.ts'

type Tone = 'muted' | 'warning'
const S = (text: string, tone?: Tone) => ({ text, ...(tone === undefined ? {} : { tone }) })
const mu = (text: string) => S(text, 'muted')

const WIDTH = 76
const NEXT = '\x0e'

const runtimes: MayflyUiSurfaceRuntime[] = []
const models: UiSurfaceModel[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const model of models.splice(0)) model.dispose()
})

/** The scene's second page: a log of `lines` rows in a scroll region that follows its tail. */
const output = (lines: number): MayflyUiNode => ui.surface({
  title: 'Output', chrome: 'overlay', badges: [S('following', 'muted')],
  child: ui.scroll(ui.stack.column(Array.from({ length: lines }, (_, index) => ui.text(`log line ${String(index + 1)}`))), { id: 'log', follow: 'end', height: 6, expandedHeight: 14 }),
})

/** A focused overlay that a host republishes, the way the surface bridge does: one model and runtime, a new node each time. */
function overlay(initial: MayflyUiNode, width = WIDTH) {
  let revision = 1
  const events = { prepare: async () => ({ reply: { kind: 'completed' as const }, publish: () => true }) }
  const snapshot = (node: MayflyUiNode) => ({
    scope: { kind: 'app' as const, targetId: 'scene-7' }, source: [], revision: revision++, update: { reason: 'data' as const },
    node, events, definition: { onEvent: {} },
  })
  const model = new UiSurfaceModel('scene-7', snapshot(initial) as never)
  const runtime = new MayflyUiSurfaceRuntime(model)
  models.push(model)
  runtimes.push(runtime)
  const compile = () => {
    const result = compileMayflyUiSurfaceNode(model.node!, {
      components: parityComponents(), colors: PROBE_PALETTE, getViewport: () => ({ columns: width, rows: 40 }), screenMode: 'alternate',
      emit: () => {}, contextHints: { enabled: true, focusWithoutControls: true }, onUnhandledEscape: () => {}, surfaceRuntime: runtime,
    })
    if (!result.ok) throw new Error(result.message)
    result.value.focusTarget!.focused = true
    return result.value
  }
  let compiled = compile()
  return {
    render: (): string[] => compiled.component.render(width),
    press: (key: string): void => { compiled.focusTarget!.handleInput?.(key) },
    publish: (node: MayflyUiNode): void => { model.receive(snapshot(node) as never); compiled = compile() },
  }
}

const strip = (row: string): string => row.replace(/\x1b\[[0-9;]*m/gu, '')

const PAGE2 = 'a scroll region: follow end (a line arrives every 1.5 s), a scrollbar, Ctrl+E expands, Esc collapses · page 2/3'

/** The scene's frame: its wrapped caption, a blank row, then the surface. */
const frame = (title: string, surface: readonly string[]): string[] => [...paint(caption(title), 96), '', ...surface]

describe('scene 7 Surfaces and scroll', () => {
  it('page 1: the chrome kinds', async () => {
    const S1 = (text: string, tone?: Tone) => S(text, tone)
    const body = ui.stack.column([
      caption('overlay: rounded, focus border color'), ui.surface({ title: 'Approve bash?', chrome: 'overlay', subtitle: 'optional subtitle (muted)', badges: [S1('1 of 3 waiting', 'muted')], child: ui.text('Runs: pnpm build'), footer: ui.richText([mu('optional custom footer')]) }),
      caption('surface: rounded, quiet border color'), ui.surface({ title: 'Select a model', chrome: 'surface', child: ui.text('→ DeepSeek/DeepSeek-V4-Pro') }),
      caption('lane: rules only (the queue pane head)'), ui.surface({ title: 'Queued (2) · ↑ recall newest', chrome: 'lane', child: ui.text('Queued: also update the footer') }),
      caption('none: a bare bold title (the todo pane)'), ui.surface({ title: 'Todo', chrome: 'none', child: ui.text('  ✓ read the config') }),
    ])
    const rows = frame('chrome kinds: overlay, surface, lane, none · page 1/3', paint(body, WIDTH))
    // The kit's wrap drops the indent of the todo row's text (Δ20).
    expect(diffReport(await frameDiffs(goldenRows('07-surfaces-and-scroll', 'initial', 0), rows, 96, [{ delta: 'Δ20', rows: [17, 17] }]))).toBe('')
  })

  it('page 2 at rest follows the tail with its scrollbar and the hint row inside the frame', async () => {
    const surface = overlay(output(12))
    expect(diffReport(await frameDiffs(goldenRows('07-surfaces-and-scroll', 'pages', 1), frame(PAGE2, surface.render()), 96, [{ delta: 'Δ20', rows: [1, 1] }]))).toBe('')
  })

  it('page 3: a header badge', async () => {
    const surface = overlay(ui.surface({ title: 'Edit provider', chrome: 'overlay', badges: [S('unsaved changes', 'warning')], child: ui.stack.column([ui.text('A badge on the right of the title rule carries a short state.'), ui.text('Narrow widths drop the subtitle and badges before the title.', { tone: 'muted' })]) }))
    const rows = frame('header badges · page 3/3', surface.render())
    expect(diffReport(await frameDiffs(goldenRows('07-surfaces-and-scroll', 'pages', 2), rows, 96))).toBe('')
  })

  /** Plays a walk of page 2: `NEXT` opens the output at 12 lines, a number is one 1.5 s tick that adds a line, keys go to the surface. */
  async function play(name: string, differs: (frame: number) => boolean = () => false): Promise<string[][]> {
    const walk = walks().find(candidate => candidate.scene === 7 && candidate.name === name)!
    const frames = readGoldenFrames(walk.dir, walk.name)
    const shown: string[][] = []
    let surface: ReturnType<typeof overlay> | undefined
    let lines = 12
    for (const [index, step] of walk.steps.entries()) {
      if (step === NEXT) surface = overlay(output(lines))
      else if (typeof step === 'number') { lines += 1; surface!.publish(output(lines)) }
      else if (step !== '\0') surface!.press(step)
      if (surface === undefined) continue
      const rows = frame(PAGE2, surface.render())
      shown.push(rows)
      if (differs(index)) continue
      // The kit's wrap leaves the caption's second row plain (Δ20).
      expect(diffReport(await frameDiffs(frames[index]!.rows, rows, 96, [{ delta: 'Δ20', rows: [1, 1] }])), `${name} frame ${String(index)}`).toBe('')
    }
    return shown
  }

  it('the end walk: the view follows each arriving line, and End at the tail changes nothing', async () => {
    await play('end')
  })

  it('the expand walk: Ctrl+E grows the viewport to fourteen rows and names the collapse keys', async () => {
    const shown = await play('expand')
    expect(strip(shown.at(-1)!.at(-2)!)).toContain('Ctrl+E collapse · Esc collapse')
  })

  it('the scroll walk: up from the tail scrolls one row, where the kit jumps to the top (Δ24)', async () => {
    // Frames 8 to 10 press ↑ three times; the kit's offset is stale, so only the arriving-line frames are compared.
    const shown = await play('scroll', frame => frame >= 8)
    const body = (rows: readonly string[]): string[] => rows.slice(4, 10).map(row => strip(row).slice(2, 14).trimEnd())
    expect(body(shown.at(-3)!)).toEqual(['log line 12', 'log line 13', 'log line 14', 'log line 15', 'log line 16', 'log line 17'])
    expect(body(shown.at(-1)!)).toEqual(['log line 10', 'log line 11', 'log line 12', 'log line 13', 'log line 14', 'log line 15'])
  })
})
