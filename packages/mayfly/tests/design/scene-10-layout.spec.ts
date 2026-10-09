/**
 * Scene 10, Layout (roadmap slice 1.3): a flex row, a width ladder, priority admission, and a windowed list, at the
 * widths and heights the scene's keys walk. Each section is compared with the prototype's rows; the flex row is the
 * layout engine's (Δ25) and the windowed list is the list painter's (slice 1.4).
 */
import { describe, expect, it } from 'vitest'
import { ui, type MayflyUiNode } from '../../../ui/src/index.ts'
import { compileMayflyUiNode } from '../../src/core/ui-compiler.ts'
import { walks } from '../../../../script/design-golden-walks.mjs'
import { caption, diffReport, frameDiffs, goldenRows, paint } from './scene.ts'
import { PROBE_PALETTE, parityComponents, readGoldenFrames } from './parity.ts'

type Tone = 'muted' | 'primary' | 'warning'
type Style = 'strong'
const S = (text: string, tone?: Tone, styles?: readonly Style[]) => ({ text, ...(tone === undefined ? {} : { tone }), ...(styles === undefined ? {} : { styles }) })
const mu = (text: string) => S(text, 'muted')

const RIGHT = '\x1b[C'
const LEFT = '\x1b[D'

/** Paints a node at a width, with the viewport the scene's ladder reads (columns and rows). */
function paintIn(node: MayflyUiNode, width: number, rows: number): string[] {
  const result = compileMayflyUiNode(node, { components: parityComponents(), colors: PROBE_PALETTE, getViewport: () => ({ columns: width, rows }), screenMode: 'alternate' })
  if (!result.ok) throw new Error(result.message)
  return result.value.component.render(width)
}

const strip = (row: string): string => row.replace(/\x1b\[[0-9;]*m/gu, '')

interface SceneState { readonly width: number, readonly tall: boolean, readonly hide: boolean }

/** The scene's state after each step of a walk (`←`/`→` width, `h` height, `o` the cwd overflow). */
function states(steps: readonly (string | number)[]): SceneState[] {
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

const CAPTIONS = [
  'stack row with basis and grow:',
  'a width ladder: children with disjoint ranges; the renderer picks one, a plugin never reads a width',
  'priority admission: lower is kept first; "hide" drops out instead of truncating',
  'a windowed list (maxRows 4) counts what is hidden:',
] as const

/** The golden rows of one section: from its caption row to the blank row before the next section. */
function sectionOf(golden: readonly string[], index: number): readonly string[] {
  const text = golden.map(strip)
  const start = text.findIndex(row => row.startsWith(CAPTIONS[index]!.slice(0, 20)))
  const next = index === CAPTIONS.length - 1 ? text.length : text.findIndex(row => row.startsWith(CAPTIONS[index + 1]!.slice(0, 20)))
  const end = index === CAPTIONS.length - 1 ? text.length : next - 1
  return golden.slice(start, end)
}

const SCENE_WALKS = walks().filter(walk => walk.scene === 10)

describe('scene 10 Layout', () => {
  for (const walk of SCENE_WALKS) {
    const frames = readGoldenFrames(walk.dir, walk.name)
    const all = states(walk.steps)
    it(`walk ${walk.name}: the ladder and the admission row match at every step`, async () => {
      for (const [frame, state] of all.entries()) {
        const golden = goldenRows(walk.dir, walk.name, frame)
        const label = `${walk.name} frame ${String(frame)} (${String(state.width)} columns)`
        // The head rows: the width and height caption, then a blank.
        expect(diffReport(await frameDiffs(golden.slice(0, 2), paint(caption(`width ${String(state.width)} (←/→) · height ${state.tall ? '≥ 20' : '< 20'} (h)`), 96), 96)), label).toBe('')
        const ladderRows = [...paint(caption('a width ladder: children with disjoint ranges; the renderer picks one, a plugin never reads a width'), 96), ...paintIn(ladder(), state.width, state.tall ? 24 : 12)]
        // The kit's wrap drops a continuation row's style (Δ20), and its height toggle hides nothing (Δ26).
        const ladderWaivers = [
          { delta: 'Δ20', rows: [1, 1] as const },
          ...state.width < 36 ? [{ delta: 'Δ20', rows: [4, 4] as const }] : [],
          ...state.tall ? [] : [{ delta: 'Δ26', rows: [3, 5] as const }],
        ]
        expect(diffReport(await frameDiffs(sectionOf(golden, 1), ladderRows, Math.max(96, state.width), ladderWaivers)), `${label} ladder`).toBe('')
        const admitRows = [...paint(caption(`priority admission: lower is kept first; "hide" drops out instead of truncating (cwd ${state.hide ? 'hide' : 'truncate'}, o)`), 96), ...paintIn(admitRow(state.hide), state.width, 40)]
        expect(diffReport(await frameDiffs(sectionOf(golden, 2), admitRows, Math.max(96, state.width), [{ delta: 'Δ20', rows: [1, 1] }])), `${label} admission`).toBe('')
        // The flex row: the first box is the basis child at every width the row has room for (Δ25).
        const flex = paintIn(flexRow(), state.width, 40).map(strip)
        expect(flex[0], `${label} flex`).toContain('╭')
        expect(frames[frame]!.rows.length).toBeGreaterThan(0)
        // The windowed list: nine rows through a four-row window, at most 40 columns wide.
        const listRows = [...paint(caption('a windowed list (maxRows 4) counts what is hidden:'), 96), ...paintIn(windowed(), Math.min(state.width, 40), 40)]
        expect(diffReport(await frameDiffs(sectionOf(golden, 3), listRows, Math.max(96, state.width), [{ delta: 'Δ20', rows: [1, 1] }])), `${label} list`).toBe('')
      }
    })
  }
})
