/**
 * The frame workloads W13 to W18-overlay and W25 to W27 (docs/design/implementation-roadmap.md section 7.1). W1 to W20 call a compiled
 * component's `render` directly; these mount a pane or an overlay the way the product does, through pi-tui's alternate
 * screen over a fake terminal, the surface lanes, and the surface renderer, and count one whole frame: the lane measure,
 * pi-tui's native layout, and the animation clock are all on the path. W17 counts the keymap snapshots one editor
 * keystroke takes through the editor-extension runtime. W25 to W27 publish a pane or an overlay again with the service
 * getters of the real Cordis context, which hand out a new wrapper at every read: a stable component object in a
 * direct workload cannot show whether an unchanged republish reuses its leaves. Each step is asynchronous because pi-tui
 * paints from a timer.
 */

import { Context } from '@deepseek-ai/cordis'
import type { MayflyPaneRegistration, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { ui } from '@ephemeral-ai/mayfly-ui'
import { apply as applyUiProvider } from '@ephemeral-ai/mayfly-ui/provider'
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
import { codeDocument, type WorkloadEnvironment } from './workloads.ts'

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

/** The eight sections of a side pane; a pane built from the same sections again shares their leaves. */
function sections(): MayflyUiNode[][] {
  return Array.from({ length: 8 }, (_, index) => section(index))
}

/** A lane pane of eight sections in one scroll view, with a loader above them, below the fold, or nowhere. */
export function sidePane(loader?: 'top' | 'bottom', parts: readonly (readonly MayflyUiNode[])[] = sections()): MayflyUiNode {
  const working = ui.loader({ message: 'Working' })
  return ui.surface({
    chrome: 'lane', padding: 1, title: 'Side pane',
    child: ui.stack.column([
      ui.tabs({ id: 'pane-tabs', activeId: 'one', items: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }] }),
      ui.scroll(ui.stack.column([
        ...(loader === 'top' ? [working] : []),
        ...parts.flat(),
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
    private readonly counters: MayflyWorkCounters,
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
    const host = new FrameHost(root, terminal, runtime, environment, counters)
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

  /**
   * Runs the clock to its next tick, then paints the frame that tick asked for. The clock paces itself by the frames it
   * sees, so a workload waits for the tick instead of assuming when it falls; with nothing armed it waits three steps.
   */
  async tick(): Promise<void> {
    const before = this.counters.clockTicks
    for (let waited = 0; waited < TICK_MS * 3 && this.counters.clockTicks === before; waited += FRAME_MS) {
      await turns()
      this.environment.advance(FRAME_MS)
    }
    await this.frames()
  }

  async dispose(): Promise<void> {
    await this.runtime.stop()
    await this.root.fiber.dispose()
  }
}

/** A side pane in the right lane, painted until it is steady. */
async function withSidePane(counters: MayflyWorkCounters, environment: WorkloadEnvironment, loader?: 'top' | 'bottom', node = sidePane(loader)): Promise<{ readonly host: FrameHost, readonly pane: MayflyPaneRegistration }> {
  const host = await FrameHost.boot(counters, environment)
  const pane = host.root.mayflyPanes.register({ id: 'perf.side', title: 'Side pane', placement: 'right', size: { min: 24, preferred: 40, max: 48 }, narrow: 'bottom' }, node)
  await host.frames()
  // Two clock steps: the first paint of a loader arms the clock, and the pane is steady only after it has ticked.
  await host.tick()
  await host.tick()
  return { host, pane }
}

export const FRAME_WORKLOADS: readonly FrameWorkload[] = [
  {
    id: 'W13', title: 'keystroke beside a pane: a key in the editor while a side pane of eight sections does not change',
    async setup(counters, environment) {
      const { host } = await withSidePane(counters, environment)
      await host.press('a')
      reset(counters)
      return { step: () => host.press('b'), dispose: () => host.dispose() }
    },
  },
  {
    id: 'W14', title: 'tick below the fold: one clock step while the only loader of a side pane is scrolled out of view',
    async setup(counters, environment) {
      const { host } = await withSidePane(counters, environment, 'bottom')
      reset(counters)
      return { step: () => host.tick(), dispose: () => host.dispose() }
    },
  },
  {
    id: 'W15', title: 'tick on screen: one clock step while a loader at the top of a side pane is in view',
    async setup(counters, environment) {
      const { host } = await withSidePane(counters, environment, 'top')
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
    id: 'W18-overlay', title: 'content scroll in an overlay: a megabyte of code in a layout-driven scroll, PageDown',
    async setup(counters, environment) {
      const host = await FrameHost.boot(counters, environment)
      host.root.mayflyOverlays.open({ id: 'perf.doc', title: 'Document', capturing: true }, ui.scroll(ui.code(codeDocument(1))))
      await host.frames()
      reset(counters)
      return { step: () => host.press('\x1b[6~'), dispose: () => host.dispose() }
    },
  },
  {
    id: 'W25', title: 'republish a pane: the node of a side pane of eight sections is published again, unchanged',
    async setup(counters, environment) {
      const node = sidePane()
      const { host, pane } = await withSidePane(counters, environment, undefined, node)
      // The first publish after the registration admits the node once more; the step is the steady state after it.
      pane.set(node)
      await host.frames()
      reset(counters)
      return { step: async () => { pane.set(node); await host.frames() }, dispose: () => host.dispose() }
    },
  },
  {
    id: 'W26', title: 'republish a pane with one section changed: the other seven keep their leaves',
    async setup(counters, environment) {
      const parts = sections()
      const { host, pane } = await withSidePane(counters, environment, undefined, sidePane(undefined, parts))
      reset(counters)
      return { step: async () => { pane.set(sidePane(undefined, [section(8), ...parts.slice(1)])); await host.frames() }, dispose: () => host.dispose() }
    },
  },
  {
    id: 'W27', title: 'republish an overlay: the node of a picker with a long scroll of sections is published again, unchanged',
    async setup(counters, environment) {
      const host = await FrameHost.boot(counters, environment)
      const node = ui.scroll(ui.stack.column(sections().flat(), { gap: 1 }), { scrollbar: true })
      const overlay = host.root.mayflyOverlays.open({ id: 'perf.republish', title: 'Sections', capturing: true }, node)
      await host.frames()
      reset(counters)
      return { step: async () => { overlay.set(node); await host.frames() }, dispose: () => host.dispose() }
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
