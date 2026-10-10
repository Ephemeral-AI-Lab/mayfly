/**
 * Scene 9, Feedback and progress (roadmap slice 1.3): the four loader variants and their cancel hint, determinate
 * progress as cells and as a heading rule, the settled forms, and the empty states; then the motion walk, where every
 * loader steps with the one clock (100 ms, the breath every fourth step), compared frame by frame with its grid golden.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ui, type MayflyUiNode } from '../../../ui/src/index.ts'
import { UiAnimationClock } from '../../src/core/ui-loader-animation.ts'
import { MayflyUiSurfaceRuntime, compileMayflyUiSurfaceNode } from '../../src/core/ui-compiler.ts'
import { PROBE_PALETTE, caption, expectFrames, paint, probeComponents } from './probe.ts'
import { sceneWalks, stepLabel } from './walks.ts'

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
    await expectFrames('09-feedback-and-progress/page-1', [{ label: 'page 1', rows, width: WIDTH }])
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
    const rows = frame('page 2/4 (Ctrl+N): progress: determinate cells with n/N, and the heading rule (heavy for done, light for what is left)', paint(body, WIDTH))
    await expectFrames('09-feedback-and-progress/page-2', [{ label: 'page 2', rows, width: WIDTH }])
  })

  it('page 4: what is missing and the next action', async () => {
    const body = col(ui.empty({ title: 'No sessions found', description: 'Restore a checkpoint with /rewind' }), ui.spacer(), ui.empty({ title: 'No plugins installed', description: 'press → to browse' }))
    const rows = frame('page 4/4 (Ctrl+N): empty: what is missing and the next action', paint(body, WIDTH))
    await expectFrames('09-feedback-and-progress/page-4', [{ label: 'page 4', rows, width: WIDTH }])
  })

  it('the motion walk: bloom, fill, and gap step every 100 ms and the breath every fourth step', async () => {
    vi.useFakeTimers()
    const [walk] = sceneWalks(9)
    const clock = new UiAnimationClock()
    const runtime = new MayflyUiSurfaceRuntime(undefined, () => {}, clock)
    runtimes.push(runtime)
    const result = compileMayflyUiSurfaceNode(loaders(), { components: probeComponents(), colors: PROBE_PALETTE, getViewport: () => ({ columns: WIDTH, rows: 40 }), screenMode: 'alternate', emit: () => {}, surfaceRuntime: runtime })
    if (!result.ok) throw new Error(result.message)
    // The fake clock stops while the headless terminal parses (it waits on timers), so every frame is painted first.
    const painted = walk!.steps.map(step => {
      if (typeof step === 'number') vi.advanceTimersByTime(step)
      return { label: stepLabel(step), rows: frame(LOADER_TITLE, result.value.component.render(WIDTH)), width: WIDTH }
    })
    vi.useRealTimers()
    expect(painted).toHaveLength(13)
    await expectFrames(`${walk!.dir}/${walk!.name}`, painted)
  })
})
