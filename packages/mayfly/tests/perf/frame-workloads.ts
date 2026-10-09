/**
 * The frame workloads W13 to W17 (docs/design/implementation-roadmap.md section 7.1). W1 to W12 call a compiled
 * component's `render` directly; these mount a pane or an overlay the way the product does, through pi-tui's alternate
 * screen over a fake terminal, the surface lanes, and the surface renderer, and count one whole frame: the lane measure,
 * pi-tui's native layout, and the animation clock are all on the path. W17 counts the keymap snapshots one editor
 * keystroke takes through the editor-extension runtime. Each step is asynchronous because pi-tui paints from a timer.
 */

import { Context } from '@deepseek-ai/cordis'
import type { MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { ui } from '@ephemeral-ai/mayfly-ui'
import { apply as applyUiProvider } from '../../../ui/src/provider.ts'
import { MayflyComponentsService } from '../../src/core/components.ts'
import { contextHintTranslator, mountContextHintLocale } from '../../src/core/context-hint-locale.ts'
import { MayflyKeymapService } from '../../src/core/keymap.ts'
import { MayflyScreenService } from '../../src/core/screen.ts'
import { mountMayflySurfaceRenderer } from '../../src/core/surface-renderer.ts'
import { startMayflyTerminal, type MayflyTerminalRuntime } from '../../src/core/terminal.ts'
import * as themeDark from '../../src/core/theme-dark.ts'
import type { MayflyFocusable } from '../../src/core/types.ts'
import { createWorkCounters, type MayflyWorkCounters } from '../../src/core/ui-work-counters.ts'
import * as frontend from '../../src/frontend/index.ts'
import { EditorExtensionRuntime } from '../../src/interaction/editor-extension-runtime.ts'
import { INTERACTION_KEY_ACTIONS } from '../../src/interaction/keys.ts'
import { FakeTerminal } from '../core/fake-terminal.ts'
import { FakeMayflyComponents, FakeMayflyEditor, FakeScreen, FakeTheme, fakeMayflyContext } from '../interaction/fakes.ts'
import type { WorkloadEnvironment } from './workloads.ts'

export interface FrameRun {
  /** Runs the measured step once and paints the frames it asks for. */
  step(): Promise<void>
  dispose(): Promise<void>
}

export interface FrameWorkload {
  readonly id: string
  readonly title: string
  /** Mounts the surface and paints it until it is steady; the counters start at zero when `step` runs. */
  setup(counters: MayflyWorkCounters, environment: WorkloadEnvironment): Promise<FrameRun>
}

const COLUMNS = 120
const ROWS = 40
/** Longer than pi-tui's 16 ms frame throttle and shorter than one clock step. */
const FRAME_MS = 20
/** One step of the animation clock. */
const TICK_MS = 100

const turn = (): Promise<void> => new Promise(resolve => { process.nextTick(resolve) })
async function turns(count = 12): Promise<void> { for (let index = 0; index < count; index += 1) await turn() }
const reset = (counters: MayflyWorkCounters): void => { Object.assign(counters, createWorkCounters()) }

/** One section of a side pane: the mix of leaves, rows, cards, charts, and lists a real panel holds. */
function section(index: number): MayflyUiNode[] {
  const id = String(index)
  return [
    ui.divider({ label: `Section ${id}` }),
    ui.text(`Plain text ${id} wraps in the body tone and is long enough to take two rows at the lane's width.`),
    ui.fields([
      { label: 'Status', value: [{ text: 'Ready', tone: 'success' }] },
      { label: 'Model', value: [{ text: 'deepseek-chat', tone: 'accent' }] },
    ]),
    ui.stack.row([
      ui.text('start'),
      ui.child(ui.text('grow', { tone: 'accent' }), { grow: 1 }),
      ui.child(ui.text('wide only', { tone: 'muted' }), { when: { minWidth: 48 } }),
    ], { gap: 1 }),
    ui.surface({
      chrome: 'surface', padding: 1, title: `Card ${id}`,
      child: ui.stack.column([ui.text('A framed card with a bar.'), ui.progress({ label: 'Progress', value: index % 5, max: 5 })]),
    }),
    ui.chart({ chart: 'sparkline', label: 'Pressure', tone: 'warning', values: [2, 4, 3, 7, 6, 9] }),
    ui.list({
      id: `list-${id}`, role: 'browse', selectedIds: [],
      items: [{ id: 'a', label: `First ${id}` }, { id: 'b', label: `Second ${id}` }, { id: 'c', label: `Third ${id}` }],
    }),
  ]
}

/** A lane pane of eight sections in one scroll view, with a loader above them, below the fold, or nowhere. */
export function sidePane(loader?: 'top' | 'bottom'): MayflyUiNode {
  const working = ui.loader({ message: 'Working' })
  return ui.surface({
    chrome: 'lane', padding: 1, title: 'Side pane',
    child: ui.stack.column([
      ui.tabs({ id: 'pane-tabs', activeId: 'one', items: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }] }),
      ui.scroll(ui.stack.column([
        ...(loader === 'top' ? [working] : []),
        ...Array.from({ length: 8 }, (_, index) => section(index)).flat(),
        ...(loader === 'bottom' ? [working] : []),
      ], { gap: 1 }), { scrollbar: true }),
    ], { gap: 1 }),
  })
}

/** The product's screen over a fake terminal: the alternate layout, an editor in the dock, and the surface renderer. */
class FrameHost {
  private typed = ''
  private constructor(
    readonly root: Context,
    readonly terminal: FakeTerminal,
    readonly runtime: MayflyTerminalRuntime,
    private readonly environment: WorkloadEnvironment,
  ) {}

  static async boot(counters: MayflyWorkCounters, environment: WorkloadEnvironment): Promise<FrameHost> {
    const root = new Context()
    await root.plugin({ name: 'frame-workload-ui-provider', apply: applyUiProvider })
    await root.plugin(frontend)
    const terminal = new FakeTerminal(COLUMNS, ROWS)
    const runtime = await startMayflyTerminal(terminal, () => Promise.resolve(undefined), undefined, undefined, 'alternate')
    await root.plugin(themeDark)
    await root.plugin({
      name: 'frame-workload-core',
      inject: ['mayflyTheme', 'mayflyUiInteraction'],
      apply(ctx: Context) {
        mountContextHintLocale(ctx, () => { runtime.requestRender() })
        ctx.plugin(MayflyKeymapService)
        ctx.plugin(MayflyScreenService, runtime)
        ctx.plugin(MayflyComponentsService, { theme: ctx.mayflyTheme, tui: runtime.tui })
        ctx.plugin({
          name: 'frame-workload-renderer',
          inject: ['mayflyUiInteraction', 'mayflyScreen', 'mayflyComponents', 'mayflyTheme', 'mayflyKeymap'],
          apply(renderer: Context) {
            // The product's key batch: without it no key reaches a list or a form.
            renderer.effect(() => renderer.mayflyKeymap.register([...INTERACTION_KEY_ACTIONS]))
            mountMayflySurfaceRenderer(renderer as Parameters<typeof mountMayflySurfaceRenderer>[0], runtime, contextHintTranslator(ctx), undefined, counters)
          },
        })
      },
    })
    await turns()
    const host = new FrameHost(root, terminal, runtime, environment)
    // The prompt a keystroke lands in: it repaints on every key, as the editor does.
    const editor: MayflyFocusable = {
      focused: false,
      render: () => [`> ${host.typed}`],
      invalidate() {},
      handleInput: (data: string) => { host.typed += data; runtime.requestRender() },
    }
    root.mayflyScreen.mountDockSlot('editor.prompt', editor).focus()
    await host.frames()
    return host
  }

  /** Lets pi-tui paint the frames that were asked for, without reaching the next clock step. */
  async frames(count = 3): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      await turns()
      this.environment.advance(FRAME_MS)
    }
    await turns()
  }

  /** One decoded input sequence, then the frames it asks for. */
  async press(data: string): Promise<void> {
    this.terminal.sendInput(data)
    await this.frames()
  }

  /** One step of the animation clock, then the frames it asks for. */
  async tick(): Promise<void> {
    this.environment.advance(TICK_MS - FRAME_MS * 3)
    await this.frames()
  }

  async dispose(): Promise<void> {
    await this.runtime.stop()
    await this.root.fiber.dispose()
  }
}

/** A side pane in the right lane, painted until it is steady. */
async function withSidePane(counters: MayflyWorkCounters, environment: WorkloadEnvironment, loader?: 'top' | 'bottom'): Promise<FrameHost> {
  const host = await FrameHost.boot(counters, environment)
  host.root.mayflyPanes.register({ id: 'perf.side', title: 'Side pane', placement: 'right', size: { min: 24, preferred: 40, max: 48 }, narrow: 'bottom' }, sidePane(loader))
  await host.frames()
  // Two clock steps: the first paint of a loader arms the clock, and the pane is steady only after it has ticked.
  await host.tick()
  await host.tick()
  return host
}

export const FRAME_WORKLOADS: readonly FrameWorkload[] = [
  {
    id: 'W13', title: 'keystroke beside a pane: a key in the editor while a side pane of eight sections does not change',
    async setup(counters, environment) {
      const host = await withSidePane(counters, environment)
      await host.press('a')
      reset(counters)
      return { step: () => host.press('b'), dispose: () => host.dispose() }
    },
  },
  {
    id: 'W14', title: 'tick below the fold: one clock step while the only loader of a side pane is scrolled out of view',
    async setup(counters, environment) {
      const host = await withSidePane(counters, environment, 'bottom')
      reset(counters)
      return { step: () => host.tick(), dispose: () => host.dispose() }
    },
  },
  {
    id: 'W15', title: 'tick on screen: one clock step while a loader at the top of a side pane is in view',
    async setup(counters, environment) {
      const host = await withSidePane(counters, environment, 'top')
      reset(counters)
      return { step: () => host.tick(), dispose: () => host.dispose() }
    },
  },
  {
    id: 'W16', title: 'list edge: Down on the last row of a picker that holds one list',
    async setup(counters, environment) {
      const host = await FrameHost.boot(counters, environment)
      host.root.mayflyOverlays.open({ id: 'perf.picker', title: 'Pick one', capturing: true }, ui.list({
        id: 'pick', role: 'choose', selectedIds: [],
        items: Array.from({ length: 5 }, (_, index) => ({ id: `row-${String(index)}`, label: `Row ${String(index)}` })),
      }))
      await host.frames()
      for (let index = 0; index < 4; index += 1) await host.press('\x1b[B')
      reset(counters)
      return { step: () => host.press('\x1b[B'), dispose: () => host.dispose() }
    },
  },
  {
    id: 'W17', title: 'editor shell: one keystroke recompiles the prompt footer beside one editor extension',
    async setup(counters) {
      const { ctx } = fakeMayflyContext({ display: false })
      ctx.provide('mayflyScreen', new FakeScreen() as never)
      ctx.provide('mayflyTheme', new FakeTheme() as never)
      ctx.provide('mayflyComponents', new FakeMayflyComponents() as never)
      class CountingKeymap extends MayflyKeymapService {
        override list(): ReturnType<MayflyKeymapService['list']> {
          counters.keymapSnapshots += 1
          return super.list()
        }
      }
      const keymap = new CountingKeymap(ctx)
      keymap.register([...INTERACTION_KEY_ACTIONS])
      const extension = ctx.mayflyEditorExtensions.register({ id: 'perf.editor' }, { hint: 'An extension hint row' })
      const runtime = new EditorExtensionRuntime({ ctx, editor: new FakeMayflyEditor(), report: () => {}, shouldTransformSubmit: () => true })
      runtime.refreshPresentation()
      reset(counters)
      return {
        step: async () => { runtime.refreshPresentation() },
        dispose: async () => { runtime.dispose(); extension.dispose(); await ctx.fiber.dispose() },
      }
    },
  },
]

/** Runs one frame workload and returns the counters of its measured step. */
export async function measureFrameWorkload(workload: FrameWorkload, environment: WorkloadEnvironment): Promise<MayflyWorkCounters> {
  const counters = createWorkCounters()
  const run = await workload.setup(counters, environment)
  try {
    await run.step()
    return { ...counters }
  } finally {
    await run.dispose()
  }
}
