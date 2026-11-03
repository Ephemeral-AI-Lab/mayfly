/**
 * Scene 10, Layout (roadmap slice 1.3): a flex row, a width ladder, priority admission, and a windowed list, at the
 * widths and heights the scene's keys walk; every frame of a walk is compared with its grid golden. The flex row is the
 * layout engine's (Δ25) and the windowed list is the list painter's (slice 1.4).
 */
import { describe, it } from 'vitest'
import { ui, type MayflyUiNode } from '../../../ui/src/index.ts'
import { compileMayflyUiNode } from '../../src/core/ui-compiler.ts'
import { PROBE_PALETTE, caption, expectFrames, paint, probeComponents, type Frame } from './probe.ts'
import { LEFT, RIGHT, sceneWalks, stepLabel, type Step } from './walks.ts'

type Tone = 'muted' | 'primary' | 'warning'
type Style = 'strong'
const S = (text: string, tone?: Tone, styles?: readonly Style[]) => ({ text, ...(tone === undefined ? {} : { tone }), ...(styles === undefined ? {} : { styles }) })
const mu = (text: string) => S(text, 'muted')

/** Paints a node at a width, with the viewport the scene's ladder reads (columns and rows). */
function paintIn(node: MayflyUiNode, width: number, rows: number): string[] {
  const result = compileMayflyUiNode(node, { emit: () => {}, components: probeComponents(), colors: PROBE_PALETTE, getViewport: () => ({ columns: width, rows }), screenMode: 'alternate' })
  if (!result.ok) throw new Error(result.message)
  return result.value.component.render(width)
}

interface SceneState { readonly width: number, readonly tall: boolean, readonly hide: boolean }

/** The scene's state after each step of a walk (`←`/`→` width, `h` height, `o` the cwd overflow). */
function states(steps: readonly Step[]): SceneState[] {
  let state: SceneState = { width: 70, tall: true, hide: false }
  return steps.map(step => {
    if (step === RIGHT) state = { ...state, width: Math.min(130, state.width + 10) }
    else if (step === LEFT) state = { ...state, width: Math.max(24, state.width - 10) }
    else if (step === 'h') state = { ...state, tall: !state.tall }
    else if (step === 'o') state = { ...state, hide: !state.hide }
    return state
  })
}

const flexRow = (): MayflyUiNode => ui.stack.row([
  ui.child(ui.surface({ title: 'basis 24', chrome: 'surface', child: ui.text('fixed') }), { basis: 24 }),
  ui.child(ui.surface({ title: 'grow 1', chrome: 'surface', child: ui.text('takes the rest') }), { grow: 1 }),
  ui.child(ui.surface({ title: 'grow 2', chrome: 'surface', child: ui.text('twice') }), { grow: 2 }),
], { gap: 1 })

const ladder = (): MayflyUiNode => ui.stack.column([
  ui.child(ui.richText([S('Loop  official · Automation   ✓ installed 1.4.0   TUI ✓ Web ✓')]), { when: { minWidth: 100 } }),
  ui.child(ui.richText([S('Loop  official   ✓ installed 1.4.0')]), { when: { minWidth: 60, maxWidth: 99 } }),
  ui.child(ui.richText([S('Loop ✓')]), { when: { maxWidth: 59 } }),
  ui.child(ui.richText([S('↻ 1 change applies after restart', 'warning')]), { when: { minHeight: 20 } }),
])

const admitRow = (hide: boolean): MayflyUiNode => ui.stack.row([
  ui.child(ui.richText([S('deepseek-chat High')]), { priority: 0 }),
  ui.child(ui.richText([S('PLAN', 'primary', ['strong'])]), { priority: 1 }),
  ui.child(ui.richText([S('⏵ 2 jobs')]), { priority: 3 }),
  ui.child(ui.richText([mu('cache 34%  context: 18% (22.9k/128k)')]), { priority: 4, band: 'right', overflow: 'hide' }),
  ui.child(ui.richText([mu('~/work/mayfly/packages/mayfly')]), { priority: 5, overflow: hide ? 'hide' : 'truncate' }),
  ui.child(ui.richText([mu('main ±3')]), { priority: 10 }),
], { gap: 2 })

const windowed = (): MayflyUiNode => ui.list({ id: 'win', role: 'browse', maxRows: 4, selectedIds: [], items: Array.from({ length: 9 }, (_, index) => ({ id: `r${String(index)}`, label: `row ${String(index + 1)}` })) })

/** The scene at one state: the width and height caption, then each section under its caption. */
function sceneRows(state: SceneState): string[] {
  const section = (title: string, rows: readonly string[]): string[] => ['', ...paint(caption(title), 96), ...rows]
  return [
    ...paint(caption(`width ${String(state.width)} (←/→) · height ${state.tall ? '≥ 20' : '< 20'} (h)`), 96),
    ...section('stack row with basis and grow:', paintIn(flexRow(), state.width, 40)),
    ...section('a width ladder: children with disjoint ranges; the renderer picks one, a plugin never reads a width', paintIn(ladder(), state.width, state.tall ? 24 : 12)),
    ...section(`priority admission: lower is kept first; "hide" drops out instead of truncating (cwd ${state.hide ? 'hide' : 'truncate'}, o)`, paintIn(admitRow(state.hide), state.width, 40)),
    // The windowed list: nine rows through a four-row window, at most 40 columns wide.
    ...section('a windowed list (maxRows 4) counts what is hidden:', paintIn(windowed(), Math.min(state.width, 40), 40)),
  ]
}

describe('scene 10 Layout', () => {
  it.each(sceneWalks(10).map(walk => [walk.name, walk] as const))('walk %s: every section at every step paints its grid golden', async (_name, walk) => {
    const all = states(walk.steps)
    const frames: Frame[] = walk.steps.map((step, index) => ({ label: stepLabel(step), rows: sceneRows(all[index]!), width: Math.max(96, all[index]!.width) }))
    await expectFrames(`${walk.dir}/${walk.name}`, frames)
  })
})
