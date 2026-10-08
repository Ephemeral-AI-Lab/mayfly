/**
 * Scene 9, Feedback and progress (roadmap slice 1.3): the four loader variants and their cancel hint, determinate
 * progress as cells and as a heading rule, the settled forms, and the empty states; then the motion walk, where every
 * loader steps with the one clock (100 ms, the breath every fourth step), compared frame by frame with the prototype.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ui, type MayflyUiNode } from '../../../ui/src/index.ts'
import { UiAnimationClock } from '../../src/core/ui-loader-animation.ts'
import { MayflyUiSurfaceRuntime, compileMayflyUiSurfaceNode } from '../../src/core/ui-compiler.ts'
import { caption, diffReport, frameDiffs, goldenRows, paint } from './scene.ts'
import { PROBE_PALETTE, parityComponents, readGoldenFrames } from './parity.ts'

type Tone = 'default' | 'muted' | 'primary' | 'danger' | 'success'
type Style = 'strong'
const S = (text: string, tone?: Tone, styles?: readonly Style[]) => ({ text, ...(tone === undefined || tone === 'default' ? {} : { tone }), ...(styles === undefined ? {} : { styles }) })
const mu = (text: string) => S(text, 'muted')
const col = (...children: Parameters<typeof ui.stack.column>[0]) => ui.stack.column(children)

const WIDTH = 96

const loaders = (): MayflyUiNode => col(
  ui.loader({ variant: 'bloom', message: 'Thinking' }),
  ui.loader({ variant: 'fill', message: 'Working' }),
  ui.loader({ variant: 'gap', message: 'Discovering models from api.example.com', elapsedMs: 12000, cancelActionId: 'cancel' }),
  ui.loader({ variant: 'breath', message: 'Waiting for authorization', elapsedMs: 45000 }),
)

const LOADER_TITLE = 'page 1/4 (Ctrl+N): loaders (one glyph channel, animated by the renderer) and the cancel hint'

const frame = (title: string, body: readonly string[]): string[] => [...paint(caption(title), WIDTH), '', ...body]

const runtimes: MayflyUiSurfaceRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  vi.useRealTimers()
})

describe('scene 9 Feedback and progress', () => {
  it('page 1: every variant at its first step, the elapsed time muted, the cancel as a hint', async () => {
    const rows = frame(LOADER_TITLE, paint(loaders(), WIDTH))
    expect(diffReport(await frameDiffs(goldenRows('09-feedback-and-progress', 'pages', 0), rows, WIDTH))).toBe('')
  })

  it('page 2: cells with n/N, a percentage without the count, and the heading rule', async () => {
    const goal = (progress: MayflyUiNode, label: ReturnType<typeof S>[]): MayflyUiNode => ui.stack.row([ui.child(progress, { basis: 40 }), ui.child(ui.richText(label))], { gap: 2 })
    const body = col(
      ui.progress({ label: 'Building', value: 0, max: 10, width: 10 }),
      ui.progress({ value: 9, max: 10, width: 10, showCount: false, showPercent: true }), ui.spacer(),
      goal(ui.progress({ style: 'rule', value: 2, max: 8, width: 40 }), [S('Goal', 'primary', ['strong']), mu(' round 2 of 8')]),
      goal(ui.progress({ style: 'rule', value: 8, max: 8, width: 40, tone: 'danger' }), [S('Goal', 'primary', ['strong']), S(' ✕ blocked', 'danger')]),
      caption('a bar never appears for an unknown duration: an eased bar that never completes is a fabricated estimate'),
    )
    // A wrapped caption's continuation row is plain in the kit (Δ20).
    const rows = frame('page 2/4 (Ctrl+N): progress: determinate cells with n/N, and the heading rule (heavy for done, light for what is left)', paint(body, WIDTH))
    expect(diffReport(await frameDiffs(goldenRows('09-feedback-and-progress', 'pages', 1), rows, WIDTH, [{ delta: 'Δ20', rows: [1, 1] }, { delta: 'Δ20', rows: [9, 9] }]))).toBe('')
  })

  it('page 4: what is missing and the next action', async () => {
    const body = col(ui.empty({ title: 'No sessions found', description: 'Restore a checkpoint with /rewind' }), ui.spacer(), ui.empty({ title: 'No plugins installed', description: 'press → to browse' }))
    const rows = frame('page 4/4 (Ctrl+N): empty: what is missing and the next action', paint(body, WIDTH))
    expect(diffReport(await frameDiffs(goldenRows('09-feedback-and-progress', 'pages', 3), rows, WIDTH))).toBe('')
  })

  it('the motion walk: bloom, fill, and gap step every 100 ms and the breath every fourth step, as the prototype does', async () => {
    vi.useFakeTimers()
    const frames = readGoldenFrames('09-feedback-and-progress', 'motion')
    const clock = new UiAnimationClock()
    const runtime = new MayflyUiSurfaceRuntime(undefined, () => {}, clock)
    runtimes.push(runtime)
    const result = compileMayflyUiSurfaceNode(loaders(), { components: parityComponents(), colors: PROBE_PALETTE, getViewport: () => ({ columns: WIDTH, rows: 40 }), screenMode: 'alternate', emit: () => {}, surfaceRuntime: runtime })
    if (!result.ok) throw new Error(result.message)
    // The fake clock stops while the headless terminal parses (it waits on timers), so every frame is painted first.
    const painted = frames.map((_, index) => {
      if (index > 0) vi.advanceTimersByTime(100)
      return frame(LOADER_TITLE, result.value.component.render(WIDTH))
    })
    vi.useRealTimers()
    for (const [index, golden] of frames.entries()) {
      expect(diffReport(await frameDiffs(golden.rows, painted[index]!, WIDTH)), `frame ${String(index)}`).toBe('')
    }
    expect(frames).toHaveLength(13)
  })
})
