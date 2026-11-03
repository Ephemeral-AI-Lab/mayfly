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
import { Editor } from '../../src/components/editor.ts'
import { apply as applyUiProvider } from '@ephemeral-ai/mayfly-ui/provider'
import { MayflyComponentsService } from '../../src/core/components.ts'
import { contextHintTranslator, mountContextHintLocale } from '../../src/core/context-hint-locale.ts'
import { MayflyKeymapService } from '../../src/core/keymap.ts'
import { MayflyScreenService } from '../../src/core/screen.ts'
import { mountMayflySurfaceRenderer } from '../../src/core/surface-renderer.ts'
import { startMayflyTerminal, wheelReport, type MayflyTerminalRuntime } from '../../src/core/terminal.ts'
import * as themeDark from '../../src/core/theme-dark.ts'
import type { MayflyFocusable } from '../../src/core/types.ts'
import { createWorkCounters, type MayflyWorkCounters } from '../../src/core/ui-work-counters.ts'
import type { LiveAssistantDraft } from '../../src/conversation/live-stream.ts'
import type { ConversationProjection } from '../../src/conversation/types.ts'
import * as frontend from '../../src/frontend/index.ts'
import { EditorExtensionRuntime } from '../../src/interaction/editor-extension-runtime.ts'
import { INTERACTION_KEY_ACTIONS } from '../../src/interaction/keys.ts'
import type { ConversationProjectionSource } from '../../src/transcript/conversation-feed.ts'
import { OfficialConversationModelSource } from '../../src/transcript/official-model.ts'
import { TranscriptController, type TranscriptScreen } from '../../src/transcript/transcript-model.ts'
import { FakeTerminal } from '../core/fake-terminal.ts'
import { FakeMayflyComponents, FakeMayflyEditor, FakeScreen, FakeTheme, fakeMayflyContext } from '../interaction/fakes.ts'
import {
  FakeConversationFeed,
  FakeTickSource,
  longSessionDraft,
  longSessionProjection,
  longSessionTools,
  pendingLastTool,
} from './long-session.ts'
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
export class FrameHost {
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
    const runtime = startMayflyTerminal(terminal, { screenMode: 'alternate', outputOptimizer: true })
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

/** A translator that keeps the key, so a row's text never depends on a locale bundle. */
function translate(key: string): string { return key }

const NO_PROJECTIONS: ConversationProjectionSource = { snapshot: () => ({ asOfSeq: 0, values: {} }), onChanged: () => () => {} }

/** A fixed publish clock whose trailing timers the workload drains explicitly, so a measured step includes the publish. */
class FixedPublishClock {
  private next = 0
  private readonly timers = new Map<number, () => void>()

  now(): number { return 0 }

  setTimeout(callback: () => void, _ms: number): unknown {
    this.next += 1
    this.timers.set(this.next, callback)
    return this.next
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.timers.delete(handle)
  }

  flush(): void {
    const pending = [...this.timers.values()]
    this.timers.clear()
    for (const callback of pending) callback()
  }
}

const KEY_PAGE_UP = '\x1b[5~'
const KEY_PAGE_DOWN = '\x1b[6~'
/** What one wheel notch scrolls: three rows, as the input plugin's wheel route does. */
const WHEEL_LINES = 3
/** Counts the stream workloads, so a measured append streams text no earlier run has indexed. */
let streamRuns = 0

/**
 * The content-scroll route the app's input plugin installs on the screen. The frame host boots the renderer and the
 * interaction services without that plugin, so a stream workload lends the screen the same wheel and page-key behavior:
 * a wheel report scrolls three rows, a page key one viewport minus four.
 */
function mountContentScroll(host: FrameHost): () => void {
  return host.root.mayflyScreen.setContentScrollHandler(data => {
    const report = wheelReport(data)
    if (report !== undefined) {
      const direction = report.button & 3
      if (direction !== 0 && direction !== 1) return false
      return host.root.mayflyScreen.scrollContent(direction === 0 ? 'up' : 'down', WHEEL_LINES)
    }
    if (data !== KEY_PAGE_UP && data !== KEY_PAGE_DOWN) return false
    return host.root.mayflyScreen.scrollContent(data === KEY_PAGE_UP ? 'up' : 'down', Math.max(1, host.root.mayflyScreen.rows - 4))
  })
}

/** What one mounted stream workload keeps: the frame host, the feed the next value goes into, and the controller. */
interface StreamRun {
  readonly host: FrameHost
  readonly feed: FakeConversationFeed
  readonly controller: TranscriptController
  readonly tick: FakeTickSource
  /** Drain the controller's trailing publish; a stream step calls this after a republish. */
  flush(): void
  dispose(): Promise<void>
}

/**
 * Mount a real transcript controller over the frame host: a projection in a fake feed, the real official model source,
 * the long-session tool presenters, and a fake tick the workload fires by hand. Publishing stays explicit, so a measured
 * step never waits for a timer.
 */
async function withStream(
  counters: MayflyWorkCounters,
  environment: WorkloadEnvironment,
  projection: ConversationProjection,
  draft?: LiveAssistantDraft,
): Promise<StreamRun> {
  const host = await FrameHost.boot(counters, environment)
  const feed = new FakeConversationFeed()
  feed.push(projection, 1)
  if (draft !== undefined) feed.setDraft(draft)
  const tick = new FakeTickSource()
  const clock = new FixedPublishClock()
  const controller = new TranscriptController({ t: translate, queued: () => [], tick, clock, counters })
  const source = new OfficialConversationModelSource(NO_PROJECTIONS, longSessionTools(), () => { controller.refresh() }, undefined, translate, counters)
  source.attachFeed(feed)
  controller.attach(host.root.mayflyScreen as unknown as TranscriptScreen)
  controller.setView('main', () => source.snapshot())
  controller.show('main')
  const releaseScroll = mountContentScroll(host)
  await host.frames()
  return {
    host, feed, controller, tick,
    flush: () => clock.flush(),
    dispose: async () => { releaseScroll(); controller.dispose(); source.dispose(); await host.dispose() },
  }
}

/**
 * Parse the terminal writes of one measured step. `rows` counts pi-tui's row writes (`CSI <row>;1H` followed by
 * `CSI 2K`), the unit W34 and W35 gate; `bytes` is the UTF-8 byte length of every write of the step, including the
 * synchronization sequences (BSU/ESU) pi-tui wraps a frame in. Both are counted from the same slice of writes.
 * @param writes - the fake terminal's writes during the step, in order.
 * @returns the row writes and the byte length they and the other step writes add up to.
 */
export function frameBytes(writes: readonly string[]): { readonly rows: number, readonly bytes: number } {
  const text = writes.join('')
  const rows = [...text.matchAll(/\x1b\[(\d+);1H\x1b\[2K/g)].length
  return { rows, bytes: Buffer.byteLength(text) }
}

/** Check the parser on a tiny sample; a workload's setup runs it so a regression fails the measured run itself. */
function assertFrameBytes(): void {
  const sample = ['\x1b[3;1H\x1b[2Kone', '\x1b[4;1H\x1b[2Ktwo', 'tail']
  const counted = frameBytes(sample)
  if (counted.rows !== 2 || counted.bytes !== Buffer.byteLength(sample.join(''))) {
    throw new Error(`frameBytes: expected 2 rows and ${String(Buffer.byteLength(sample.join('')))} bytes, got ${String(counted.rows)} and ${String(counted.bytes)}`)
  }
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
    id: 'W32', title: 'views summary: a views pane publishes a fresh summary node of equal text, the status row repaints (componentRenders, layoutPasses, controlWalks, reconciles)',
    async setup(counters, environment) {
      const host = await FrameHost.boot(counters, environment)
      const pane = host.root.mayflyPanes.register({
        id: 'perf.views', title: 'Agents', placement: 'views',
        summary: { node: ui.text('Agents · 2') },
      }, ui.stack.column([ui.text('Agents view'), ui.text('No agent is running.')]))
      await host.frames()
      reset(counters)
      return {
        step: async () => { pane.setSummary({ node: ui.text('Agents · 2') }); await host.frames() },
        dispose: () => host.dispose(),
      }
    },
  },
  {
    id: 'W33a', title: 'live tick with the pending tool in view: one 1 Hz tick beside a 15-turn transcript at its tail (componentRenders, itemsWalked, rowsPainted)',
    async setup(counters, environment) {
      const stream = await withStream(counters, environment, pendingLastTool(longSessionProjection(15)))
      const fire = stream.tick.capture()
      if (fire === undefined) throw new Error('W33a: the pending tool did not subscribe to the tick')
      if (stream.host.root.mayflyScreen.contentTail()?.away === true) throw new Error('W33a: the tail left the view')
      // Warm the pending row's animation and width cache once, so the measured tick does not include the first cold frame.
      fire(1_700_000_001_000)
      await stream.host.frames()
      reset(counters)
      return {
        step: async () => { fire(1_700_000_001_000); counters.clockTicks += 1; await stream.host.frames() },
        dispose: () => stream.dispose(),
      }
    },
  },
  {
    id: 'W33b', title: 'live tick with the pending tool scrolled out: one 1 Hz tick beside a 15-turn transcript paged away from its tail (componentRenders, itemsWalked, rowsPainted)',
    async setup(counters, environment) {
      const stream = await withStream(counters, environment, pendingLastTool(longSessionProjection(15)))
      const fire = stream.tick.capture()
      if (fire === undefined) throw new Error('W33b: the pending tool did not subscribe to the tick')
      await stream.host.press(KEY_PAGE_UP)
      if (stream.host.root.mayflyScreen.contentTail()?.away !== true) throw new Error('W33b: the pending row was not scrolled out of view')
      reset(counters)
      return {
        step: async () => { fire(1_700_000_001_000); counters.clockTicks += 1; await stream.host.frames() },
        dispose: () => stream.dispose(),
      }
    },
  },
  {
    id: 'W34', title: 'follow-tail append: one line arrives in the streaming answer of a 15-turn transcript at its tail (rowsWritten, bytesWritten)',
    async setup(counters, environment) {
      assertFrameBytes()
      const projection = longSessionProjection(15)
      // A text no earlier run streamed: the content cache cannot hand this run a line table another run estimated.
      streamRuns += 1
      const text = `The answer streams at the tail ${String(streamRuns)}.`
      const stream = await withStream(counters, environment, projection, longSessionDraft(projection, text, 1))
      reset(counters)
      return {
        step: async () => {
          const mark = stream.host.terminal.written.length
          stream.feed.setDraft(longSessionDraft(projection, `${text}\nA second line arrives.`, 2))
          stream.controller.republish()
          stream.flush()
          await stream.host.frames()
          const counted = frameBytes(stream.host.terminal.written.slice(mark))
          counters.rowsWritten = counted.rows
          counters.bytesWritten = counted.bytes
        },
        dispose: () => stream.dispose(),
      }
    },
  },
  {
    id: 'W35', title: 'wheel notch: one wheel-up notch scrolls a 15-turn transcript away from its tail (rowsWritten, bytesWritten)',
    async setup(counters, environment) {
      const stream = await withStream(counters, environment, longSessionProjection(15))
      reset(counters)
      return {
        step: async () => {
          const mark = stream.host.terminal.written.length
          stream.host.terminal.sendInput('\x1b[<64;10;10M')
          await stream.host.frames()
          if (stream.host.root.mayflyScreen.contentTail()?.away !== true) throw new Error('W35: the wheel notch did not scroll the transcript')
          const counted = frameBytes(stream.host.terminal.written.slice(mark))
          counters.rowsWritten = counted.rows
          counters.bytesWritten = counted.bytes
        },
        dispose: () => stream.dispose(),
      }
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
      const runtime = new EditorExtensionRuntime({ ctx, editor: new FakeMayflyEditor(), report: () => {}, frame: ({ parked }) => Editor({ shell: false, parked }), shouldTransformSubmit: () => true })
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
