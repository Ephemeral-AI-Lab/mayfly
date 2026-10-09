/**
 * The node slot's test host (roadmap slice 1.10a), its only consumer until the footer, the editor, and the conversation
 * lease node slots in Phases 3, 5, and 6 (D20). It mounts the three shapes those phases will: a status-shaped row in the
 * footer, an editor-shaped surface in the dock, and a stream-shaped list in the content region, through
 * `mayflyScreen.mountNodeSlot` from an ordinary Fiber, beside a core that binds them through the real surface renderer.
 *
 * @module @ephemeral-ai/mayfly/tests/core/node-slot-host
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import { freezeWire, ui, type MayflyListItem, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { contextHintTranslator, mountContextHintLocale } from '../../src/core/context-hint-locale.ts'
import { MayflyKeymapService } from '../../src/core/keymap.ts'
import type { MayflyNodeSlot } from '../../src/core/node-slot.ts'
import { MayflyScreenService } from '../../src/core/screen.ts'
import { SurfaceManager } from '../../src/core/surface-manager.ts'
import { mountMayflySurfaceRenderer } from '../../src/core/surface-renderer.ts'
import type { MayflyTerminalRuntime } from '../../src/core/terminal.ts'
import type { MayflyUiImageSource } from '../../src/core/ui-images.ts'
import type { MayflyComponent, MayflyComponents, MayflyFocusable, MayflySemanticColors } from '../../src/core/types.ts'
import { sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '../../src/core/width.ts'
import { createFakeEditor } from './fake-editor.ts'

const identity = (value: string): string => value

/** A palette that paints nothing, and one that dims every token, so a theme change is visible in the rows. */
export const PLAIN_COLORS = new Proxy({ logoGradient: [identity] }, { get: (target, key) => key === 'logoGradient' ? target.logoGradient : identity }) as unknown as MayflySemanticColors
const dim = (value: string): string => `\x1b[2m${value}\x1b[22m`
export const DIM_COLORS = new Proxy({ logoGradient: [dim] }, { get: (target, key) => key === 'logoGradient' ? target.logoGradient : dim }) as unknown as MayflySemanticColors

export const COMPONENTS = { visibleWidth, wrapText: wrapTextWithAnsi, truncateToWidth, sliceByColumn, createEditor: createFakeEditor } as unknown as MayflyComponents

/** A status-shaped row: twelve entries, the last carrying a counter. Unchanged entries keep their identity. */
const STATUS_ENTRIES = Array.from({ length: 11 }, (_, index) => ui.richText([{ text: `entry ${String(index)} ` }, { text: '0', tone: 'muted' }]))
export function statusRow(counter = 0): MayflyUiNode {
  return ui.stack.row([...STATUS_ENTRIES, ui.richText([{ text: 'entry 11 ' }, { text: String(counter), tone: 'muted' }])].map(entry => ui.child(entry)))
}

/** An editor-shaped surface: one prompt field. */
export const EDITOR_SURFACE: MayflyUiNode = ui.form({ id: 'prompt', fields: [{ kind: 'input', id: 'draft', label: 'Prompt', value: '' }] })

/** An editor-shaped prompt (slice 1.9b): the symbol, one token, a recall, and a placeholder ladder inside a right-titled frame. */
export const PROMPT_SURFACE: MayflyUiNode = ui.surface({
  title: 'Prompt', titleAlign: 'right', chrome: 'surface', hint: 'completions',
  child: ui.prompt({
    id: 'composer', autofocus: true, tokens: [{ id: 'img', label: 'Image #1', size: '84 KB' }],
    recall: [{ kind: 'queued', text: 'also update the footer' }, { kind: 'history', text: 'run the width scan again' }],
    placeholder: ['Ask anything · / commands', 'Ask anything'],
  }),
})

/** A stream-shaped list of settled, frozen items. */
export function streamItems(count: number): readonly MayflyListItem[] {
  return Array.from({ length: count }, (_, index) => freezeWire({ id: `item-${String(index)}`, label: `Item number ${String(index)}` }))
}
export function streamList(items: readonly MayflyListItem[]): MayflyUiNode {
  return ui.list({ id: 'stream', role: 'browse', selectedIds: [], items })
}

/** A terminal runtime that only records: the screen's hosts, focus, and render requests. */
export interface NodeSlotRuntime {
  readonly runtime: MayflyTerminalRuntime
  readonly added: MayflyComponent[]
  readonly bottomAdded: MayflyComponent[]
  readonly focused: () => MayflyComponent | null
  readonly renders: () => number
  resize(columns: number, rows: number): void
}

export function nodeSlotRuntime(initialColumns = 100, initialRows = 40): NodeSlotRuntime {
  const added: MayflyComponent[] = []
  const bottomAdded: MayflyComponent[] = []
  let focused: MayflyComponent | null = null
  let columns = initialColumns
  let rows = initialRows
  let renders = 0
  const runtime = {
    mode: 'alternate',
    get columns() { return columns },
    get rows() { return rows },
    surfaces: new SurfaceManager(),
    surfaceViewport: () => ({ columns, rows }),
    surfaceLaneRows: () => 0,
    hasCapturingOverlay: () => false,
    releaseSurfaceFocus() {},
    setFocus(component: MayflyComponent | null) {
      if (focused !== null && 'focused' in focused) (focused as MayflyFocusable).focused = false
      focused = component
      if (component !== null && 'focused' in component) (component as MayflyFocusable).focused = true
    },
    addChild(component: MayflyComponent) { added.push(component) },
    addBottomChild(component: MayflyComponent) { bottomAdded.push(component) },
    requestRender() { renders += 1 },
  } as unknown as MayflyTerminalRuntime
  return {
    runtime,
    added,
    bottomAdded,
    focused: () => focused,
    renders: () => renders,
    resize(nextColumns, nextRows) { columns = nextColumns; rows = nextRows },
  }
}

class TestTheme extends Service {
  constructor(ctx: Context, readonly colors: MayflySemanticColors) { super(ctx, 'mayflyTheme') }
}

class TestComponents extends Service {
  constructor(ctx: Context) {
    super(ctx, 'mayflyComponents')
    Object.assign(this, COMPONENTS)
  }
}

/** A theme provider; replacing it reloads the renderer, as a theme switch does. */
export function nodeSlotTheme(colors: MayflySemanticColors) {
  return {
    name: 'test-node-slot-theme',
    apply(ctx: Context) {
      ctx.plugin(TestTheme, colors)
      ctx.plugin(TestComponents)
    },
  }
}

/** The core rows a node slot needs: the hint locale, the keymap, the screen, and the surface renderer that binds slots. */
export function nodeSlotCore(runtime: MayflyTerminalRuntime, images?: MayflyUiImageSource) {
  return {
    name: 'test-node-slot-core',
    apply(ctx: Context) {
      mountContextHintLocale(ctx, () => { runtime.requestRender() })
      ctx.plugin(MayflyKeymapService)
      ctx.plugin(MayflyScreenService, runtime)
      ctx.plugin({
        name: 'test-node-slot-renderer',
        inject: ['mayflyUiInteraction', 'mayflyScreen', 'mayflyComponents', 'mayflyTheme', 'mayflyKeymap'],
        apply(renderer: Context) {
          mountMayflySurfaceRenderer(renderer as Parameters<typeof mountMayflySurfaceRenderer>[0], runtime, contextHintTranslator(ctx), images)
        },
      })
    },
  }
}

/** What the host leased in its latest application. */
export interface NodeSlotHostState {
  mounts: number
  footer?: MayflyNodeSlot
  editor?: MayflyNodeSlot
  stream?: MayflyNodeSlot
}

/** The test host: each application leases the three slots and publishes the shapes `nodes` returns. */
export function nodeSlotHost(state: NodeSlotHostState, nodes: () => { readonly footer: MayflyUiNode, readonly editor: MayflyUiNode, readonly stream: MayflyUiNode }) {
  return {
    name: 'test-node-slot-host',
    inject: ['mayflyScreen'],
    apply(ctx: Context) {
      state.mounts += 1
      const footer = ctx.mayflyScreen.mountNodeSlot('status.footer', { region: 'footer' })
      const editor = ctx.mayflyScreen.mountNodeSlot('editor.prompt', { region: 'dock' })
      const stream = ctx.mayflyScreen.mountNodeSlot('transcript.conversation', { region: 'content' })
      Object.assign(state, { footer, editor, stream })
      const published = nodes()
      footer.set(published.footer)
      editor.set(published.editor)
      stream.set(published.stream)
      ctx.effect(() => () => {
        footer.dispose()
        editor.dispose()
        stream.dispose()
      })
    },
  }
}
