/**
 * L0 pi-tui adapter: the only code in the tree that constructs pi-tui
 * renderers and touches the process terminal. Owns the terminal lifecycle
 * (start, drain, stop) and the stable TUI reference behind which a future
 * renderer hot-swap can happen without consumers re-resolving.
 *
 * @module @ephemeral-ai/mayfly/core/terminal
 */

import {
  Container,
  HStack,
  isKeyRelease,
  parseKey,
  ProcessTerminal,
  ScrollView,
  TuiAltScreen,
  TuiMainScreen,
  VStack,
  type Component,
  type Terminal,
  type TUI,
  type TuiInputListener,
} from '@earendil-works/pi-tui'
import { LAYOUT_NODE, type LayoutNode } from '@earendil-works/pi-tui/dist/layout-node.js'
import { clampFrame, clampFrameFrom, createFileOverflowSink, defaultOverflowDirectory, type OverflowSink } from './frame-clamp.ts'
import { createOutputRecovery, type AmbientOutput } from './output-recovery.ts'
import {
  SURFACE_HEADER_MAX_ROWS,
  SurfaceManager,
  bottomLaneRows,
  planBottomLane,
  renderSurfaceLane,
  renderSurfaceTabs,
  renderedSurfaceEntries,
  surfaceLaneTabRows,
  type BottomLanePlan,
  type SurfaceLayout,
  type SurfacePlacement,
} from './surface-manager.ts'
import { buildTitleOsc0, copySelectionText } from './terminal-escape.ts'
import { probeTerminalBackground, backgroundFromRgb, type MayflyProbeProcess } from './terminal-info.ts'
import type { MayflyComponent, MayflyDockOptions, MayflyOverlayHandle, MayflyOverlayOptions, MayflyRgbColor } from './types.ts'

interface MayflyRuntimeOverlayOptions extends MayflyOverlayOptions { readonly maxWidth?: number }

const KEY_UP = '\x1b[A'
const KEY_DOWN = '\x1b[B'
const KEY_LEFT = '\x1b[D'
const KEY_RIGHT = '\x1b[C'
const KEY_PAGE_UP = '\x1b[5~'
const KEY_PAGE_DOWN = '\x1b[6~'
const KEY_HOME = '\x1b[H'
const KEY_END = '\x1b[F'
const KEY_INSERT = '\x1b[2~'
const KEY_DELETE = '\x1b[3~'

const NORMALIZED_NAVIGATION_INPUT = new Map<string, string>([
  ['up', KEY_UP],
  ['down', KEY_DOWN],
  ['left', KEY_LEFT],
  ['right', KEY_RIGHT],
  ['pageUp', KEY_PAGE_UP],
  ['pageDown', KEY_PAGE_DOWN],
  ['home', KEY_HOME],
  ['end', KEY_END],
  ['insert', KEY_INSERT],
  ['delete', KEY_DELETE],
])

/** Renderer choice kept inside core's L0 boundary. */
export type MayflyScreenMode = 'main' | 'alternate'

/** One child's latest clamped rows, keyed on the row array the child returned. */
interface ClampedChildRows {
  readonly width: number
  readonly source: readonly string[]
  readonly rows: string[]
}

/**
 * Container-level width backstop used by both alternate-screen layout bands.
 * Children are clamped independently: a child is rescanned only when it hands
 * back a different row array or the width changes, so a stable transcript
 * costs nothing per frame while an uncached sibling (a stateless banner, the
 * local activity region) rescans only its own rows. The concatenated frame is
 * reused while every child part is unchanged. Children must therefore return
 * a new array whenever their rows change; same-identity mutation is invisible.
 */
class FrameClampedContainer extends Container {
  private readonly clampedChildren = new WeakMap<Component, ClampedChildRows>()
  private cached: {
    readonly width: number
    readonly children: readonly Component[]
    readonly parts: readonly string[][]
    readonly rows: string[]
  } | undefined

  constructor(private readonly overflow: OverflowSink) {
    super()
  }

  override render(width: number): string[] {
    const children = [...this.children]
    const cached = this.cached
    let reusable = cached !== undefined && cached.width === width && cached.children.length === children.length
    let offset = 0
    const parts = children.map((child, index) => {
      const part = this.clampChild(child, width, offset)
      offset += part.length
      if (reusable && (cached!.children[index] !== child || cached!.parts[index] !== part)) reusable = false
      return part
    })
    if (reusable) return cached!.rows
    const rows = parts.length === 1 ? parts[0]! : parts.flat()
    this.cached = { width, children, parts, rows }
    return rows
  }

  /**
   * Clamp one child's rows, reporting overflow at frame-relative indexes. A
   * new array at the same width is clamped against the previous one, so a
   * live transcript frame measures only the rows that changed.
   */
  private clampChild(child: Component, width: number, offset: number): string[] {
    const source = child.render(width)
    const previous = this.clampedChildren.get(child)
    if (previous?.width === width && previous.source === source) return previous.rows
    const sink: OverflowSink = offset === 0
      ? this.overflow
      : { record: entry => this.overflow.record({ ...entry, index: entry.index + offset }) }
    const rows = clampFrameFrom(previous?.width === width ? previous : undefined, source, width, sink)
    this.clampedChildren.set(child, { width, source, rows })
    return rows
  }
}

/** Fixed rows painted as one layout leaf. */
function rowsLeaf(rows: readonly string[]): Component {
  return {
    render: () => [...rows],
    /* v8 ignore next -- a leaf holds one frame's planned rows; the lane re-plans every frame */
    invalidate: () => {},
  }
}

/**
 * Layout-aware lane chrome that preserves a compiled pane's nested layout.
 * The bottom lane lays out from one {@link planBottomLane} per frame: passive
 * panes become fixed-height leaves holding their head-first fitted rows, so
 * an over-budget dock truncates each pane's tail instead of letting the
 * layout engine shrink individual rows out of every pane's head.
 */
class SurfaceLaneContainer implements Component {
  private readonly tabs: Component = {
    render: width => {
      const lane = this.getLayout()[this.placement]
      return lane === undefined || surfaceLaneTabRows(lane) === 0 ? [] : [renderSurfaceTabs(lane, width)]
    },
    invalidate: () => this.manager.invalidate(),
  }
  private measured: {
    readonly width: number
    readonly layout: SurfaceLayout
    readonly rows: number
    readonly plan?: BottomLanePlan
  } | undefined

  constructor(
    private readonly manager: SurfaceManager,
    private readonly placement: SurfacePlacement,
    private readonly getLayout: () => SurfaceLayout,
    private readonly maxRows: () => number,
  ) {}

  render(width: number): string[] {
    const layout = this.getLayout()
    const lane = layout[this.placement]
    if (this.placement === 'bottom' && lane !== undefined) {
      const plan = planBottomLane(lane, width, this.maxRows())
      this.measured = { width, layout, rows: plan.rows, plan }
      return bottomLaneRows(plan)
    }
    const rows = renderSurfaceLane(lane, width, this.maxRows())
    this.measured = { width, layout, rows: rows.length }
    return rows
  }

  /**
   * Row count of this lane for the current layout. pi-tui measures every
   * root band before it lays out the dock, so the dock's budget reads the
   * count this frame's own render produced instead of rendering the panes a
   * second time; an unmeasured combination falls back to a render.
   */
  measureRows(width: number): number {
    const layout = this.getLayout()
    if (layout[this.placement] === undefined) return 0
    const measured = this.measured
    return measured?.width === width && measured.layout === layout ? measured.rows : this.render(width).length
  }

  invalidate(): void {
    this.manager.invalidate()
  }

  [LAYOUT_NODE](): LayoutNode {
    const layout = this.getLayout()
    const lane = layout[this.placement]
    const stack = new VStack()
    if (lane === undefined) return stack[LAYOUT_NODE]()
    if (this.placement === 'bottom') {
      // pi-tui measures (renders) the lane before laying it out in one frame;
      // a layout that changed since then re-plans at the measured width.
      const measured = this.measured
      /* v8 ignore next -- a bottom measurement always carries a plan and precedes any layout */
      const plan = measured?.layout === layout && measured.plan !== undefined ? measured.plan : planBottomLane(lane, measured?.width ?? 1, this.maxRows())
      const fixed = (size: number) => ({ basis: size, grow: 0, shrink: 1, minSize: 0, maxSize: size })
      if (plan.rule !== undefined) stack.addChild(rowsLeaf([plan.rule]), fixed(1))
      if (plan.tabs !== undefined) stack.addChild(rowsLeaf([plan.tabs]), fixed(1))
      for (const slot of plan.slots) {
        if (slot.size === 0) continue
        stack.addChild(slot.passive ? rowsLeaf(slot.rows) : slot.entry.component as Component, fixed(slot.size))
      }
      return stack[LAYOUT_NODE]()
    }
    const tabRows = surfaceLaneTabRows(lane)
    if (tabRows > 0) stack.addChild(this.tabs, { basis: 1, grow: 0, shrink: 0, minSize: 1, maxSize: 1 })
    for (const entry of renderedSurfaceEntries(lane)) {
      stack.addChild(entry.component as Component, {
        basis: 'auto',
        grow: 1,
        shrink: 1,
        minSize: 0,
        maxSize: Math.max(0, this.maxRows() - tabRows),
      })
    }
    return stack[LAYOUT_NODE]()
  }
}

interface DockLayoutEntry {
  readonly component: Component
  readonly rows: string[]
  readonly priority: number
  readonly fixed: boolean
  readonly bottom: boolean
  readonly order: number
}

/** Height-aware bottom dock that reserves fixed slots before passive panes. */
class DockLayoutContainer extends Container {
  private readonly metadata = new Map<Component, {
    readonly priority: number
    readonly fixed: boolean
    readonly bottom: boolean
  }>()

  constructor(
    private readonly overflow: OverflowSink,
    private readonly viewportRows: (fixedRows: number) => number,
    private readonly onRendered?: (rows: number) => void,
  ) {
    super()
  }

  addDockChild(
    component: Component,
    options: MayflyDockOptions = {},
    fixed = false,
    bottom = false,
  ): void {
    this.removeChild(component)
    this.metadata.set(component, {
      priority: options.priority ?? 0,
      fixed,
      bottom,
    })
    this.addChild(component)
  }

  override removeChild(component: Component): void {
    this.metadata.delete(component)
    super.removeChild(component)
  }

  override render(width: number): string[] {
    const entries: DockLayoutEntry[] = this.children.map((component, order) => {
      const metadata = this.metadata.get(component)!
      return {
        component,
        rows: component.render(width),
        priority: metadata.priority,
        fixed: metadata.fixed,
        bottom: metadata.bottom,
        order,
      }
    })
    // Keep one transcript row whenever the viewport can hold both bands.
    const fixedRows = entries.reduce((total, entry) => total + (entry.fixed ? entry.rows.length : 0), 0)
    let remaining = Math.max(0, this.viewportRows(fixedRows) - 1)
    const allocations = new Map<Component, number>()
    const ranked = [...entries].sort((left, right) => {
      return Number(right.fixed) - Number(left.fixed)
        || Number(right.bottom) - Number(left.bottom)
        || right.priority - left.priority
        || left.order - right.order
    })
    for (const entry of ranked) {
      const rows = Math.min(remaining, entry.rows.length)
      allocations.set(entry.component, rows)
      remaining -= rows
    }
    const ordered = [...entries].sort((left, right) => {
      return Number(left.bottom) - Number(right.bottom)
        || Number(left.fixed) - Number(right.fixed)
        || left.priority - right.priority
        || left.order - right.order
    })
    const rows = ordered.flatMap(entry => {
      const allocated = allocations.get(entry.component)!
      if (allocated === 0) return []
      return allocated === entry.rows.length ? entry.rows : entry.rows.slice(-allocated)
    })
    this.onRendered?.(rows.length)
    return clampFrame(rows, width, this.overflow)
  }
}

/**
 * Header plus bottom lane rows the dock may apply to the shared viewport.
 * Lanes are width-derived, so measuring them at read time keeps the editor
 * slot current instead of a frame behind the dock's own allocation. The
 * fixed-content clamp is deliberately omitted: over-counting lanes can only
 * shrink the editor slot, never spill past the grant.
 * @param rows - the terminal's row count.
 * @param headerRows - the header lane's measured rows.
 * @param bottomRows - the bottom lane's measured rows.
 * @returns the lane rows the editor slot must subtract.
 */
export function measuredLaneRows(rows: number, headerRows: number, bottomRows: number): number {
  const budget = Math.max(0, Math.floor(rows) - 1)
  const header = Math.min(budget, Math.max(0, Math.floor(headerRows)))
  const bottom = Math.min(budget - header, Math.max(0, Math.floor(bottomRows)))
  return header + bottom
}

/**
 * Normalize terminal wheel reports to the direction-key sequences consumed by
 * Mayfly's focused components. Main-screen mode leaves mouse reporting disabled
 * so the terminal retains native selection and scrollback. This boundary still
 * accepts reports when a multiplexer or an embedding host enabled them.
 * @param data - one decoded terminal input sequence.
 * @returns an up/down key sequence for wheel input, or `undefined` when the
 *   input is not a supported wheel report.
 */
export function normalizeWheelInput(data: string): string | undefined {
  const report = wheelReport(data)
  if (report === undefined) return undefined
  const direction = report.button & 3
  return direction === 0 ? KEY_UP : direction === 1 ? KEY_DOWN : undefined
}

/**
 * Decode a terminal wheel report into its button bits and cell position. The
 * position lets the router keep reports over the content region raw for the
 * ScrollView while reports over the dock still normalize to direction keys.
 * @param data - one decoded terminal input sequence.
 * @returns the wheel report, or `undefined` when the input is not a wheel report.
 */
export function wheelReport(data: string): { readonly button: number, readonly x: number, readonly y: number } | undefined {
  let button: number
  let x: number
  let y: number
  if (data.length === 6 && data.startsWith('\x1b[M')) {
    button = data.charCodeAt(3) - 32
    x = data.charCodeAt(4) - 32
    y = data.charCodeAt(5) - 32
  } else {
    const match = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/.exec(data)
    if (match === null) return undefined
    button = Number.parseInt(match[1]!, 10)
    x = Number.parseInt(match[2]!, 10)
    y = Number.parseInt(match[3]!, 10)
  }
  if ((button & 64) === 0) return undefined
  return { button, x, y }
}

/**
 * Normalize unmodified navigation events to the legacy sequences consumed by
 * Mayfly's raw-key paths. Enhanced Kitty releases and modified navigation keep
 * their original encoding so event-type and modifier semantics remain intact.
 * @param data - one decoded terminal input sequence.
 * @returns the canonical navigation sequence, or `undefined` when the input
 *   must pass through unchanged.
 */
export function normalizeNavigationInput(data: string): string | undefined {
  if (isKeyRelease(data)) return undefined
  const key = parseKey(data)
  return key === undefined ? undefined : NORMALIZED_NAVIGATION_INPUT.get(key)
}

/**
 * The Mayfly-typed face of the running terminal stack. L1 services consume
 * this; pi-tui types stay inside this module.
 */
export interface MayflyTerminalRuntime {
  /** Renderer mode used by the canonical public UI compiler. */
  readonly mode: MayflyScreenMode
  /** Current terminal width in columns. */
  readonly columns: number
  /** Current terminal height in rows. */
  readonly rows: number
  /** The probed background luminance class, or `undefined` when the probe failed. */
  readonly background: 'dark' | 'light' | undefined
  /** Whether the Kitty keyboard protocol is active on the terminal. */
  readonly kittyKeyboard: boolean
  /** The stable TUI reference behind the runtime; core-internal (pi-tui type). */
  readonly tui: TUI
  /** Core-internal surface seam for the later pane-owner bridge. */
  readonly surfaces: SurfaceManager
  /** Current best-effort viewport budget for one managed surface. */
  surfaceViewport(id: string): { readonly columns: number, readonly rows: number }
  /**
   * Header plus bottom lane rows the width-derived layout currently
   * occupies. The editor slot subtracts this one authoritative value so it
   * never lags the dock's own allocation by a frame; content panes read
   * `surfaceViewport` instead.
   */
  surfaceLaneRows(): number
  /** Release one pane's focus back to the component active before it. */
  releaseSurfaceFocus(id: string): void
  /** Whether any visible modal overlay currently owns the input plane. */
  hasCapturingOverlay(): boolean
  /**
   * Mount a root component on the live renderer, above every bottom-pinned
   * component.
   * @param component - the component to mount.
   */
  addChild(component: MayflyComponent): void
  /**
   * Mount a root component pinned to the bottom of the live renderer: it
   * renders after every component mounted through `addChild`.
   * @param component - the component to pin.
   * @param position - `'bottom'` renders the component below the rest of
   *   the dock (the two-row footer shell mounts there, keeping the status
   *   on the terminal's last rows beneath the editor and any dialog panel
   *   that pulls up over it).
   */
  addBottomChild(component: MayflyComponent, position?: 'bottom'): void
  /** Mount a flexible component in the shared bottom-dock row allocator. */
  addDockChild(component: MayflyComponent, options?: MayflyDockOptions): void
  /**
   * Unmount a root component from the live renderer.
   * @param component - the component to unmount.
   */
  removeChild(component: MayflyComponent): void
  /**
   * Move keyboard focus on the live renderer.
   * @param component - the component to focus, or `null`.
   */
  setFocus(component: MayflyComponent | null): void
  revealContent?(component: MayflyComponent, row: number): void
  scrollContent(direction: 'up' | 'down', amount?: number): boolean
  contentChanged(): boolean
  followContent(): void
  setContentScrollHandler(handler: ((data: string) => boolean) | undefined): () => void
  /**
   * Show an overlay on the live renderer.
   * @param component - the overlay component.
   * @param options - positioning and sizing options.
   * @returns the overlay's control handle.
   */
  showOverlay(component: MayflyComponent, options?: MayflyRuntimeOverlayOptions): MayflyOverlayHandle
  /**
   * Schedule a re-render of the live renderer.
   * @param force - reset differential render state before drawing.
   */
  requestRender(force?: boolean): void
  /**
   * Suspend the renderer, run `fn` with the terminal released (raw mode off,
   * pi-tui detached, the tty free for a child process with inherited stdio),
   * then resume: restart the renderer, re-arm OSC 2031 notifications, and
   * force a full repaint. The suspend is exclusive — a second call while one
   * is in flight rejects — and refuses on a stopped runtime. If the runtime
   * is torn down while suspended, the resume side skips the restart and the
   * fn's settlement (value or error) propagates unchanged.
   * @param fn - the async body owning the terminal while it is released.
   * @returns settles with fn's outcome after the renderer resumed (or was
   *   torn down mid-suspend).
   */
  suspend<T>(fn: () => Promise<T>): Promise<T>
  /**
   * Set the terminal's window/tab title through a sanitized OSC 0
   * sequence. The sequence paints no cell, so it never disturbs the
   * renderer's differential state (the OSC 52 precedent); inside tmux it
   * becomes the tmux window name.
   * @param title - untrusted title text; control characters are stripped
   *   and the payload capped before the write.
   */
  setTitle(title: string): void
  /**
   * Restore the terminal: drain pending input, then stop the renderer and
   * the underlying terminal. Idempotent.
   * @returns settles when the terminal state is restored.
   */
  stop(): Promise<void>
}

/**
 * Stable `TUI` reference for consumers while the runtime replaces the active
 * renderer. Mirrors pi's `createInteractiveTuiReference`: property reads and
 * method calls resolve against the current renderer at call time.
 * @param getTui - accessor for the current renderer.
 * @returns a proxy implementing the full pi-tui `TUI` interface.
 */
export function createStableTuiReference(getTui: () => TUI): TUI {
  return new Proxy({} as TUI, {
    get: (_target, property) => {
      const tui = getTui()
      const value: unknown = Reflect.get(tui, property, tui)
      if (typeof value !== 'function') return value
      let methodTui = tui
      let method = value as (this: TUI, ...args: unknown[]) => unknown
      return (...args: unknown[]) => {
        const currentTui = getTui()
        if (currentTui !== methodTui) {
          const currentMethod: unknown = Reflect.get(currentTui, property, currentTui)
          if (typeof currentMethod !== 'function') {
            throw new TypeError(`TUI property ${String(property)} is not callable`)
          }
          methodTui = currentTui
          method = currentMethod as (this: TUI, ...args: unknown[]) => unknown
        }
        return Reflect.apply(method, methodTui, args)
      }
    },
    set: (_target, property, value) => Reflect.set(getTui(), property, value, getTui()),
    has: (_target, property) => Reflect.has(getTui(), property),
    getPrototypeOf: () => Reflect.getPrototypeOf(getTui()),
  })
}

/**
 * The Mayfly terminal stack active in this process, or `undefined` before the
 * plugin loads and after it unloads. At most one is active: the underlying
 * `ProcessTerminal` owns process stdin/stdout.
 */
let activeRuntime: MayflyTerminalRuntime | undefined

/**
 * Terminal restore function factory for `installFailLoud(binName, proc,
 * release)`. The returned function stops the active Mayfly terminal stack
 * (restoring raw mode, bracketed paste, and keyboard protocols) and is a
 * no-op when no stack is active.
 * @returns the release function to hand to `installFailLoud`.
 */
export function createTerminalRelease(): () => Promise<void> {
  return async () => {
    await activeRuntime?.stop()
  }
}

/**
 * Start the Mayfly terminal stack: a pi-tui renderer over a `ProcessTerminal`,
 * registered as the process-active runtime. The OSC 11
 * background probe runs first, before the renderer takes stdin into raw
 * mode; then the renderer starts and subscribes to terminal color-scheme
 * (mode 2031) notifications, forwarded through `onSchemeChange`.
 * Production uses the alternate screen; main-screen mode remains an explicit
 * compatibility option. The returned runtime delegates through the stable
 * reference so the concrete renderer never leaks past core.
 * @param terminal - the terminal to drive; defaults to a real
 *   `ProcessTerminal` on process stdin/stdout. Tests inject a fake.
 * @param probe - the background probe; defaults to the OSC 11 query on the
 *   live process. Tests inject a recording fake.
 * @param onSchemeChange - called when the terminal reports a dark/light
 *   color-scheme switch.
 * @param overflow - where the exit backstop records clamped lines; defaults
 *   to the deduplicating file sink under pi-tui's log directory. Tests
 *   inject a recorder.
 * @param screenMode - renderer buffer mode. The Mayfly plugin selects
 *   `'alternate'`; `'main'` remains available for compatibility fixtures.
 * @param ambientOutput - stdout/stderr streams that host plugins may write
 *   around the renderer. Production passes process streams; source-plane VT
 *   tests inject recording streams.
 * @returns the running stack's Mayfly-typed face.
 */
export async function startMayflyTerminal(
  terminal: Terminal = new ProcessTerminal(),
  probe: (proc?: MayflyProbeProcess) => Promise<MayflyRgbColor | undefined> = () => probeTerminalBackground(),
  onSchemeChange?: (scheme: 'dark' | 'light') => void,
  overflow: OverflowSink = createFileOverflowSink({ directory: defaultOverflowDirectory() }),
  screenMode: MayflyScreenMode = 'main',
  ambientOutput?: AmbientOutput,
): Promise<MayflyTerminalRuntime> {
  const alternate = screenMode === 'alternate'
  const current: TUI = alternate
    ? new TuiAltScreen(terminal, undefined, undefined, {
        wheelScrollLines: 3,
        copySelection: text => copySelectionText(text, terminal),
      })
    : new TuiMainScreen(terminal)
  const requestRender = current.requestRender.bind(current)
  let renderColumns = terminal.columns
  let renderRows = terminal.rows
  // pi-tui routes resize through requestRender too. A new viewport must
  // preempt its streaming frame timer just as keyboard input does.
  current.requestRender = (force = false) => {
    const resized = renderColumns !== terminal.columns || renderRows !== terminal.rows
    renderColumns = terminal.columns
    renderRows = terminal.rows
    requestRender(force || resized)
  }
  const stable = createStableTuiReference(() => current)
  // TuiAltScreen registers its viewport listener in its constructor. Move it
  // behind Mayfly's contextual content handler and wheel normalizer: the main
  // editor then owns transcript scrolling, while a focused replacement panel
  // still receives wheel-as-arrow and page/navigation keys. The structural
  // read is deliberately confined to L0 and pinned by the terminal specs.
  const viewportInput = current instanceof TuiAltScreen
    ? [...(current as unknown as { inputListeners: Set<TuiInputListener> }).inputListeners][0]
    : undefined
  if (viewportInput !== undefined) current.removeInputListener(viewportInput)
  // Herdr forwards Kitty functional-key codepoints while tmux commonly emits
  // legacy CSI forms. Canonicalize both before any Mayfly or viewport listener
  // sees them so every raw-key path receives the same navigation vocabulary.
  const removeNavigationNormalizer = current.addInputListener(data => {
    const normalized = normalizeNavigationInput(data)
    return normalized === undefined ? undefined : { data: normalized }
  })
  // Track dock membership for contextual wheel routing. The editor's handler
  // consumes its own wheel reports; a focused replacement panel receives the
  // direction-key form, while an unfocused/empty tree keeps the raw report for
  // TuiAltScreen's native ScrollView route.
  const bottomChildren = new Set<MayflyComponent>()
  const bottomPinned = new Set<MayflyComponent>()
  let contentScrollHandler: ((data: string) => boolean) | undefined
  const removeContentScrollHandler = current.addInputListener(data => {
    /* v8 ignore next -- exercised by the real PTY input path */
    if (contentScrollHandler?.(data) === true) return { consume: true }
    return undefined
  })
  // Replacement panels use the same arrow semantics as their keyboard path.
  // Keep raw wheel reports untouched for the primary AltScreen ScrollView:
  // transforming every wheel event here prevents pi-tui from scrolling when
  // no focused-editor handler is active.
  const removeWheelNormalizer = current.addInputListener(data => {
    const report = wheelReport(data)
    if (report === undefined) return undefined
    const direction = report.button & 3
    if (direction !== 0 && direction !== 1) return undefined
    const normalized = direction === 0 ? KEY_UP : KEY_DOWN
    if (!(current instanceof TuiAltScreen)) return { data: normalized }
    const focused = current.getFocusedComponent()
    if (focused === null) return undefined
    if (!bottomChildren.has(focused as MayflyComponent)) {
      return surfaces.focusedId !== undefined ? { data: normalized } : undefined
    }
    /* A focused dock surface still leaves wheel reports over the content
       region raw, so the ScrollView pages the transcript under the pointer;
       only reports landing inside the dock become direction keys. */
    return report.y <= terminal.rows - lastDockRows ? undefined : { data: normalized }
  })
  const removeViewportInput = viewportInput === undefined
    ? () => {}
    : current.addInputListener(data => {
        // These keys are contextual in Mayfly. If the editor's transcript
        // handler did not consume them, the focused editor/panel must see
        // them instead of the global viewport. Bare Up/Down are always
        // editor history/navigation, even if host keybindings assign the
        // AltScreen line-scroll actions to those sequences.
        if (data === KEY_UP || data === KEY_DOWN
          || data === KEY_PAGE_UP || data === KEY_PAGE_DOWN
          || data === KEY_HOME || data === KEY_END) return undefined
        return viewportInput(data)
      })
  // Bottom-pinned components (the input editor dock) must render after
  // transcript content no matter when each side mounts: pi-tui renders root
  // children in array order, and transcript components mount only after the
  // app's session-changed broadcast, long after the editor. `bottomPinned`
  // members render below the rest of the dock — the footer shell mounts
  // there so the two-row status stays on the terminal's last rows beneath
  // the editor, the kimi layout (its dialogs pull up from the editor's
  // slot while the statusline remains visible below).
  const contentChildren = new Set<MayflyComponent>()
  const contentContainer = alternate ? new FrameClampedContainer(overflow) : undefined
  let surfaceHeaderRows: () => number
  let surfaceBottomRows: () => number
  let lastSurfaceHeaderRows = 0
  let lastSurfaceBottomRows = 0
  let lastDockRows = 0
  const dockContainer = alternate ? new DockLayoutContainer(overflow, fixedRows => {
    const fixedBudget = Math.min(Math.max(0, terminal.rows - 1), fixedRows)
    let surfaceBudget = Math.max(0, terminal.rows - 1 - fixedBudget)
    const headerRows = Math.min(surfaceBudget, surfaceHeaderRows())
    surfaceBudget -= headerRows
    const bottomRows = Math.min(surfaceBudget, surfaceBottomRows())
    return terminal.rows - headerRows - bottomRows
  }, rows => { lastDockRows = rows }) : undefined
  const scrollView = contentContainer === undefined ? undefined : new ScrollView(contentContainer, {
    follow: 'end',
    primary: true,
    overscroll: 'chain',
    scrollbar: 'auto',
  })
  let rebuildSurfaceLayout: () => void
  let surfacePreFocus: Component | null = null
  const mountedSurfaceBase = (): Component | null => surfacePreFocus !== null && (contentChildren.has(surfacePreFocus) || bottomChildren.has(surfacePreFocus))
    ? surfacePreFocus
    : null
  const surfaces = new SurfaceManager({
    onChange: () => rebuildSurfaceLayout(),
    onSurfaceFocusTransition: (previous, next) => {
      const internal = current as unknown as {
        getFocusedComponent(): Component | null
        overlayStack: { preFocus: Component | null }[]
      }
      const target = next as Component | null ?? mountedSurfaceBase()
      for (const overlay of internal.overlayStack) {
        if (overlay.preFocus === previous) overlay.preFocus = target
      }
      if (internal.getFocusedComponent() === previous) stable.setFocus(target)
      if (next === null) surfacePreFocus = null
    },
  })
  // Bottom panes share a third of the terminal; the lane plan allots it per
  // pane each frame, and each pane renders against the whole lane budget.
  const bottomLaneBudget = (): number => Math.floor(terminal.rows / 3)
  const linearLaneComponent = (placement: SurfacePlacement): Component => ({
    render: width => {
      const layout = surfaces.linearLayout(terminal.columns, terminal.rows)
      const maxRows = placement === 'header'
        ? SURFACE_HEADER_MAX_ROWS
        : placement === 'bottom'
          ? bottomLaneBudget()
          : Number.MAX_SAFE_INTEGER
      return renderSurfaceLane(layout[placement], width, maxRows)
    },
    invalidate: () => surfaces.invalidate(),
  })
  const alternateLanes: Record<SurfacePlacement, SurfaceLaneContainer> = {
    header: new SurfaceLaneContainer(surfaces, 'header', () => surfaces.layout(terminal.columns, terminal.rows), () => SURFACE_HEADER_MAX_ROWS),
    left: new SurfaceLaneContainer(surfaces, 'left', () => surfaces.layout(terminal.columns, terminal.rows), () => Number.MAX_SAFE_INTEGER),
    right: new SurfaceLaneContainer(surfaces, 'right', () => surfaces.layout(terminal.columns, terminal.rows), () => Number.MAX_SAFE_INTEGER),
    bottom: new SurfaceLaneContainer(surfaces, 'bottom', () => surfaces.layout(terminal.columns, terminal.rows), bottomLaneBudget),
  }
  const linearLanes: Record<SurfacePlacement, Component> = {
    header: linearLaneComponent('header'),
    left: linearLaneComponent('left'),
    right: linearLaneComponent('right'),
    bottom: linearLaneComponent('bottom'),
  }
  surfaceHeaderRows = () => {
    lastSurfaceHeaderRows = alternateLanes.header.measureRows(terminal.columns)
    return lastSurfaceHeaderRows
  }
  surfaceBottomRows = () => {
    lastSurfaceBottomRows = alternateLanes.bottom.measureRows(terminal.columns)
    return lastSurfaceBottomRows
  }

  function rebuildAlternateLayout(): void {
    const semantic = surfaces.linearLayout(terminal.columns, terminal.rows)
    const sideEntries = [...(semantic.left?.entries ?? []), ...(semantic.right?.entries ?? [])]
    const needsBottom = semantic.bottom !== undefined || sideEntries.some(entry => (entry.narrow ?? 'bottom') === 'bottom')

    const root = new VStack()
    if (semantic.header !== undefined) {
      root.addChild(alternateLanes.header, { basis: 'auto', grow: 0, shrink: 1, maxSize: SURFACE_HEADER_MAX_ROWS })
    }
    if (semantic.left === undefined && semantic.right === undefined) {
      root.addChild(scrollView!, { basis: 0, grow: 1, shrink: 1, minSize: 1 })
    } else {
      const body = new HStack([], { gap: 1 })
      if (semantic.left !== undefined) {
        const width = semantic.left.width!
        body.addChild(alternateLanes.left, {
          basis: width,
          grow: 0,
          shrink: 0,
          minSize: width,
          maxSize: width,
          visible: viewport => surfaces.layout(viewport.width, viewport.height).left !== undefined,
        })
      }
      body.addChild(scrollView!, { basis: 0, grow: 1, shrink: 1, minSize: 1 })
      if (semantic.right !== undefined) {
        const width = semantic.right.width!
        body.addChild(alternateLanes.right, {
          basis: width,
          grow: 0,
          shrink: 0,
          minSize: width,
          maxSize: width,
          visible: viewport => surfaces.layout(viewport.width, viewport.height).right !== undefined,
        })
      }
      root.addChild(body, { basis: 0, grow: 1, shrink: 1, minSize: 1 })
    }
    if (needsBottom) {
      root.addChild(alternateLanes.bottom, {
        basis: 'auto',
        grow: 0,
        shrink: 100,
        minSize: 0,
      })
    }
    root.addChild(dockContainer!, { basis: 'auto', grow: 0, shrink: 0, minSize: 1 })
    ;(current as TuiAltScreen).setLayoutRoot(root)
  }

  function rebuildMainLayout(): void {
    const semantic = surfaces.linearLayout(terminal.columns, terminal.rows)
    current.children.splice(0, current.children.length,
      ...(semantic.header === undefined ? [] : [linearLanes.header]),
      ...contentChildren,
      ...(semantic.left === undefined ? [] : [linearLanes.left]),
      ...(semantic.right === undefined ? [] : [linearLanes.right]),
      ...(semantic.bottom === undefined ? [] : [linearLanes.bottom]),
      ...orderedDock(),
    )
    current.requestRender()
  }

  rebuildSurfaceLayout = alternate ? rebuildAlternateLayout : rebuildMainLayout
  rebuildSurfaceLayout()
  let contentScrollOffset = 0
  let contentScrollManual = false
  // The dock must also sit on the terminal's last rows even when the mounted
  // content is shorter than the viewport (boot with no session yet, a fresh
  // /new) — pi-tui stacks root children top-down, so an unpadded tree leaves
  // the editor floating right under the content. Wrapping the renderer's own
  // line collection is the one seam where the flat output can be split back
  // into content and dock: the dock block is measured again (its components
  // are a few cheap rows) and blank filler is inserted between the blocks
  // until the frame spans the viewport. Full viewports render untouched, and
  // an empty or dock-less tree pads nothing (no blank flood at boot).
  //
  // The same wrapper is the exit backstop (D48): every frame line, on both
  // return paths, is clamped to `width` before pi-tui's differential writer
  // can crash on it — an over-wide component row degrades to a truncated
  // row plus one deduplicated mayfly-overflow.log entry instead of a dead
  // session. `width` is the very value pi-tui's guard compares against.
  const collectLines = current.render.bind(current)
  if (!alternate) current.render = (width: number): string[] => {
    const lines = collectLines(width)
    if (lines.length === 0 || bottomChildren.size === 0) {
      return clampFrame(lines, width, overflow)
    }
    let dockRows = 0
    for (const child of orderedDock()) dockRows += child.render(width).length
    const boundary = lines.length - dockRows
    /* v8 ignore next -- covered by the real-terminal and VT layout tiers */
    if (lines.length >= terminal.rows) {
      // Keep the newest transcript rows visible while reserving the terminal
      // tail for the editor/status dock. Returning the full over-height frame
      // lets long streams push the input out of view and makes the apparent
      // scroll position jump back toward the beginning on each repaint.
      const contentRows = Math.max(0, terminal.rows - dockRows)
      const end = Math.max(contentRows, boundary - contentScrollOffset)
      return clampFrame([
        ...lines.slice(Math.max(0, end - contentRows), end),
        ...lines.slice(boundary),
      ], width, overflow)
    }
    const filler = terminal.rows - lines.length
    return clampFrame([
      ...lines.slice(0, boundary),
      ...Array.from({ length: filler }, () => ''),
      ...lines.slice(boundary),
    ], width, overflow)
  }
  /** Dock children in render order: the regular block, then the pinned tail. */
  function orderedDock(): MayflyComponent[] {
    return [
      ...[...bottomChildren].filter(child => !bottomPinned.has(child)),
      ...bottomPinned,
    ]
  }
  const background = backgroundFromRgb(await probe())
  current.start()
  // Dynamic Host plugins intentionally log straight to process stdout/stderr.
  // In alternate-screen mode that bypasses the renderer at its hardware
  // cursor (normally inside the editor), so the text can overwrite both the
  // draft and footer until another input happens to redraw them. Preserve the
  // host write, then force a full frame on the next tick. Renderer writes are
  // excluded by the recovery handle's terminal-write guard.
  const outputRecovery = alternate && ambientOutput !== undefined
    ? createOutputRecovery(terminal, ambientOutput, () => current.requestRender(true))
    : undefined
  outputRecovery?.activate()
  current.setTerminalColorSchemeNotifications(true)
  if (onSchemeChange !== undefined) current.onTerminalColorSchemeChange(onSchemeChange)
  let stopped = false
  let suspended = false
  const runtime: MayflyTerminalRuntime = {
    mode: screenMode,
    get columns() {
      return current.terminal.columns
    },
    get rows() {
      return terminal.rows
    },
    background,
    get kittyKeyboard() {
      return terminal.kittyProtocolActive
    },
    tui: stable,
    surfaces,
    surfaceViewport(id) {
      const layout = screenMode === 'main'
        ? surfaces.linearLayout(terminal.columns, terminal.rows)
        : surfaces.layout(terminal.columns, terminal.rows)
      const lane = ([layout.header, layout.left, layout.right, layout.bottom] as const)
        .find(candidate => candidate?.entries.some(entry => entry.id === id))
      const columns = lane?.placement === 'left' || lane?.placement === 'right' ? lane.width ?? terminal.columns : terminal.columns
      if (screenMode === 'main') return { columns: Math.max(1, terminal.columns), rows: Math.max(1, terminal.rows) }
      const tabs = lane === undefined ? 0 : surfaceLaneTabRows(lane)
      const dockRows = lastDockRows
      const rows = lane?.placement === 'header'
        ? Math.max(1, (lastSurfaceHeaderRows || SURFACE_HEADER_MAX_ROWS) - tabs)
        : lane?.placement === 'bottom'
          ? Math.max(1, bottomLaneBudget() - tabs)
          : Math.max(1, terminal.rows - dockRows - lastSurfaceHeaderRows - lastSurfaceBottomRows - tabs)
      return { columns: Math.max(1, Math.min(terminal.columns, columns)), rows: Math.min(terminal.rows, rows) }
    },
    surfaceLaneRows() {
      return measuredLaneRows(terminal.rows, surfaceHeaderRows(), surfaceBottomRows())
    },
    releaseSurfaceFocus(id) {
      if (surfaces.focusedId !== id) return
      surfaces.setFocused(undefined)
      const target = mountedSurfaceBase()
      stable.setFocus(target)
      surfacePreFocus = null
    },
    hasCapturingOverlay() {
      const stack = (current as unknown as { overlayStack: { readonly options?: { readonly nonCapturing?: boolean }, readonly hidden?: boolean }[] }).overlayStack
      return stack.some(entry => entry.hidden !== true && entry.options?.nonCapturing !== true)
    },
    addChild(component) {
      contentChildren.add(component)
      if (contentContainer !== undefined) {
        contentContainer.addChild(component)
        return
      }
      rebuildMainLayout()
    },
    addBottomChild(component, position) {
      bottomChildren.add(component)
      if (position === 'bottom') {
        // Pinned members render at the very bottom of the dock: re-append
        // on the renderer so the array order — and therefore the painted
        // row order — keeps them after every regular dock child.
        bottomPinned.add(component)
        if (dockContainer !== undefined) {
          dockContainer.addDockChild(component, { priority: Number.MAX_SAFE_INTEGER }, true, true)
        } else {
          rebuildMainLayout()
        }
      } else {
        bottomPinned.delete(component)
        // Regular dock children insert before the first pinned member (or
        // append when none is pinned), preserving mount order among
        // themselves while the pinned tail stays last.
        if (dockContainer !== undefined) dockContainer.addDockChild(component, {}, true)
        else rebuildMainLayout()
      }
    },
    addDockChild(component, options) {
      bottomChildren.add(component)
      bottomPinned.delete(component)
      if (dockContainer !== undefined) {
        dockContainer.addDockChild(component, options)
        return
      }
      rebuildMainLayout()
    },
    removeChild(component) {
      contentChildren.delete(component)
      bottomChildren.delete(component)
      bottomPinned.delete(component)
      if (contentContainer !== undefined && dockContainer !== undefined) {
        contentContainer.removeChild(component)
        dockContainer.removeChild(component)
      } else rebuildMainLayout()
    },
    setFocus(component) {
      const previous = (current as unknown as { getFocusedComponent(): Component | null }).getFocusedComponent()
      const previousSurfaceId = surfaces.focusedId
      surfaces.setFocusedComponent(component)
      if (previousSurfaceId === undefined && surfaces.focusedId !== undefined && previous !== component) surfacePreFocus = previous
      stable.setFocus(component)
    },
    /* v8 ignore start -- exercised through the real PTY interaction path */
    revealContent(component, row) {
      let target = Math.max(0, row)
      for (const child of contentChildren) {
        if (child === component) break
        target += child.render(current.terminal.columns).length
      }
      if (current instanceof TuiAltScreen) current.scrollBy(target - current.viewportTop)
      else {
        const lines = collectLines(current.terminal.columns)
        const dockRows = orderedDock().reduce((sum, child) => sum + child.render(current.terminal.columns).length, 0)
        const available = Math.max(1, terminal.rows - dockRows)
        contentScrollOffset = Math.max(0, lines.length - dockRows - available - target)
        contentScrollManual = true
        stable.requestRender(true)
      }
    },
    scrollContent(direction, amount = 1) {
      if (current instanceof TuiAltScreen) {
        const before = current.viewportTop
        current.scrollBy(direction === 'up' ? -Math.max(1, Math.floor(amount)) : Math.max(1, Math.floor(amount)))
        const moved = current.viewportTop !== before
        return moved
      }
      const lines = collectLines(current.terminal.columns)
      let dockRows = 0
      for (const child of orderedDock()) dockRows += child.render(current.terminal.columns).length
      const contentRows = Math.max(1, terminal.rows - dockRows)
      const max = Math.max(0, lines.length - dockRows - contentRows)
      if (max === 0) return false
      const step = Math.max(1, Math.floor(amount))
      const next = direction === 'up'
        ? Math.min(max, contentScrollOffset + step)
        : Math.max(0, contentScrollOffset - step)
      if (next === contentScrollOffset) return false
      contentScrollOffset = next
      contentScrollManual = next > 0
      stable.requestRender(true)
      return true
    },
    contentChanged() {
      if (current instanceof TuiAltScreen) {
        const paused = !current.isFollowingOutput
        current.requestRender()
        return paused
      }
      const wasManual = contentScrollManual
      if (!contentScrollManual) contentScrollOffset = 0
      stable.requestRender()
      return wasManual
    },
    followContent() {
      if (current instanceof TuiAltScreen) {
        current.scrollToBottom()
        return
      }
      contentScrollOffset = 0
      contentScrollManual = false
      stable.requestRender(true)
    },
    setContentScrollHandler(handler) {
      contentScrollHandler = handler
      return () => {
        if (contentScrollHandler === handler) contentScrollHandler = undefined
      }
    },
    /* v8 ignore stop */
    showOverlay(component, options) {
      if (options?.maxWidth === undefined) return stable.showOverlay(component, options)
      const maximum = Math.max(1, Math.floor(options.maxWidth))
      const source = options.width
      const sourceMinWidth = options.minWidth
      const adapted = {
        ...options,
      }
      Object.defineProperties(adapted, {
        width: {
          enumerable: true,
          get: () => {
            const requested = typeof source === 'string'
              ? Math.floor(terminal.columns * Number.parseFloat(source) / 100)
              : source ?? Math.min(80, terminal.columns)
            return Math.max(1, Math.min(maximum, requested))
          },
        },
        minWidth: {
          enumerable: true,
          get: () => Math.max(1, Math.min(terminal.columns, maximum, Math.floor(sourceMinWidth ?? 1))),
        },
      })
      return stable.showOverlay(component, adapted)
    },
    requestRender(force) {
      stable.requestRender(force)
    },
    async suspend<T>(fn: () => Promise<T>): Promise<T> {
      if (suspended) throw new Error('mayfly terminal suspend is already in flight')
      if (stopped) throw new Error('mayfly terminal is stopped; suspend refused')
      suspended = true
      outputRecovery?.deactivate()
      // Main-screen mode: the child appends below the content in the
      // scrollback tail, so stop() takes no preserveScreen option — the
      // cursor drops below the rendered content and the external editor
      // opens in place (kimi's main-screen ordering).
      current.stop(alternate ? { preserveScreen: true } : undefined)
      // One setImmediate beat lets the stop escape sequences flush before
      // the child takes over the tty.
      await new Promise<void>(resolve => setImmediate(resolve))
      try {
        return await fn()
      } finally {
        suspended = false
        // Pause before start(): bytes buffered while suspended must not
        // surface as application input once raw mode re-arms.
        process.stdin.pause()
        // Torn down mid-suspend (fiber unload / fail-loud release): the
        // renderer must not restart; the settlement propagates as-is.
        if (!stopped && activeRuntime === runtime) {
          current.start()
          outputRecovery?.activate()
          // stop() disabled OSC 2031 notifications; re-arm them, then force
          // a full repaint — start()'s self-SIGWINCH (Unix) has already
          // refreshed dimensions stale from any resize while suspended.
          current.setTerminalColorSchemeNotifications(true)
          current.requestRender(true)
        }
      }
    },
    setTitle(title) {
      // Bypass pi-tui's Terminal.setTitle (it writes to process.stdout
      // directly, with no injection point); the runtime owns the terminal
      // instance, and the sequence itself is the pure core helper's.
      terminal.write(buildTitleOsc0(title))
    },
    async stop() {
      if (stopped) return
      stopped = true
      if (suspended) {
        // The renderer is already stopped and a child owns the tty: draining
        // here would steal the child's input, and a second tui stop would
        // replay the teardown sequences. Just unregister.
        removeWheelNormalizer()
        removeViewportInput()
        removeContentScrollHandler()
        removeNavigationNormalizer()
        outputRecovery?.deactivate()
        if (activeRuntime === runtime) activeRuntime = undefined
        return
      }
      // Drain before stopping so in-flight Kitty key releases cannot leak
      // into the parent shell as literal escape sequences.
      await terminal.drainInput()
      outputRecovery?.deactivate()
      current.stop()
      removeWheelNormalizer()
      removeViewportInput()
      removeContentScrollHandler()
      removeNavigationNormalizer()
      if (activeRuntime === runtime) activeRuntime = undefined
    },
  }
  activeRuntime = runtime
  return runtime
}
