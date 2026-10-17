/**
 * L0 pi-tui adapter: the only code in the tree that constructs pi-tui
 * renderers and touches the process terminal. Owns the terminal lifecycle
 * (start, drain, stop) and the TUI renderer the runtime hands to core.
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
import { clampFrame, clampFrameFrom, clampRow, createFileOverflowSink, defaultOverflowDirectory, type OverflowSink } from './frame-clamp.ts'
import { createOutputRecovery, type AmbientOutput } from './output-recovery.ts'
import { createOutputOptimizer } from './output-optimizer.ts'
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
import { concatRows, isVirtualRows, mapRows, prepareRows } from './ui-rows.ts'
import type { MayflyComponent, MayflyDockOptions, MayflyOverlayHandle, MayflyOverlayOptions, MayflySemanticColors } from './types.ts'
import { BarredScrollView } from './ui-scroll-region.ts'

/** The runtime's own overlay options: a width cap, and an absolute cell the renderer places the overlay at. */
interface MayflyRuntimeOverlayOptions extends MayflyOverlayOptions { readonly maxWidth?: number, readonly row?: number, readonly col?: number }

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
type MayflyScreenMode = 'main' | 'alternate'

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
  /** The row each child's first line stood on in the last frame. */
  private readonly starts = new Map<Component, number>()

  constructor(private readonly overflow: OverflowSink) {
    super()
  }

  override render(width: number): string[] {
    const children = [...this.children]
    const cached = this.cached
    let reusable = cached !== undefined && cached.width === width && cached.children.length === children.length
    let offset = 0
    this.starts.clear()
    const parts = children.map((child, index) => {
      this.starts.set(child, offset)
      const part = this.clampChild(child, width, offset)
      offset += part.length
      if (reusable && (cached!.children[index] !== child || cached!.parts[index] !== part)) reusable = false
      return part
    })
    if (reusable) return cached!.rows
    const rows = parts.length === 1 ? parts[0]! : concatRows(...parts)
    this.cached = { width, children, parts, rows }
    return rows
  }

  /** The row `child`'s first line stood on in the last frame, or `undefined` when it was not a child of it. */
  startOf(child: Component): number | undefined {
    return this.starts.get(child)
  }

  /**
   * Clamp one child's rows, reporting overflow at frame-relative indexes. A
   * new array at the same width is clamped against the previous one, so a
   * live transcript frame measures only the rows that changed. A virtual
   * source keeps its window: the clamped rows are a facade that clamps the
   * source row someone reads instead of scanning every row up front.
   */
  private clampChild(child: Component, width: number, offset: number): string[] {
    const source = child.render(width)
    const previous = this.clampedChildren.get(child)
    if (previous?.width === width && previous.source === source) return previous.rows
    const sink: OverflowSink = offset === 0
      ? this.overflow
      : { record: entry => this.overflow.record({ ...entry, index: entry.index + offset }) }
    const prior = previous?.width === width ? previous : undefined
    // A virtual source clamps each row as it is read, so the backstop measures only the rows a frame shows.
    const rows = isVirtualRows(source)
      ? mapRows(source, (line, index) => clampRow(line, index, width, sink))
      : clampFrameFrom(prior, source, width, sink)
    this.clampedChildren.set(child, { width, source, rows })
    return rows
  }
}

/** Fixed rows painted as one layout leaf. */
function rowsLeaf(rows: readonly string[]): Component {
  return {
    render: () => [...rows],
    /* a leaf holds one frame's planned rows; the lane re-plans every frame */
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
/** What a lane answers a measure nobody reads. */
const NO_ROWS: string[] = []

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
    readonly maxRows: number
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
      const maxRows = this.maxRows()
      const measured = this.measured
      // pi-tui measures the lane and then lays it out in the same frame; the plan renders every passive pane. Reuse
      // it while the layout, width, and budget are unchanged instead of planning the same rows twice.
      const plan = measured?.layout === layout && measured.width === width && measured.maxRows === maxRows && measured.plan !== undefined
        ? measured.plan
        : planBottomLane(lane, width, maxRows)
      this.measured = { width, layout, maxRows, rows: plan.rows, plan }
      return bottomLaneRows(plan)
    }
    // The row that holds a side lane gives it its height, so pi-tui's measure of one is never used: its pane is not
    // rendered for it, and prepares itself when the native layout reaches it.
    if (this.placement === 'left' || this.placement === 'right') return NO_ROWS
    const rows = renderSurfaceLane(lane, width, this.maxRows())
    this.measured = { width, layout, maxRows: this.maxRows(), rows: rows.length }
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
    return measured?.width === width && measured.layout === layout && measured.maxRows === this.maxRows() ? measured.rows : this.render(width).length
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
      /* a bottom measurement always carries a plan and precedes any layout */
      const maxRows = this.maxRows()
      const plan = measured?.layout === layout && measured.maxRows === maxRows && measured.plan !== undefined
        ? measured.plan
        : planBottomLane(lane, measured?.width ?? 1, maxRows)
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
    // A side lane's one pane fills what the tabs leave, whatever its own height; only the header is sized by its rows.
    const basis = this.placement === 'header' ? 'auto' as const : 0
    for (const entry of renderedSurfaceEntries(lane)) {
      stack.addChild(entry.component as Component, {
        basis,
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

/** F1, F2, and F4 as kitty sends them unmodified (`CSI P`): pi-tui decodes only the SS3 forms. F3 is `CSI 13 ~`. */
const FUNCTION_KEY_LETTERS: Readonly<Record<string, string>> = { P: '\x1bOP', Q: '\x1bOQ', S: '\x1bOS' }
/** The xterm numbers of F1-F12 in the `CSI <n> ~` form. */
const FUNCTION_KEY_NUMBERS = new Set(['11', '12', '13', '14', '15', '17', '18', '19', '20', '21', '23', '24'])

/**
 * Normalize kitty's unmodified function-key forms to the legacy sequences pi-tui decodes (spec §3.5): `CSI P`, `CSI Q`,
 * and `CSI S`, and the explicit-state and repeat forms (`CSI 1;1:2 Q`, `CSI 15;1:2 ~`). Releases and modified keys keep
 * their encoding; `CSI R` stays a cursor report.
 * @param data - one decoded terminal input sequence.
 * @returns the legacy sequence, or `undefined` when the input passes through unchanged.
 */
export function normalizeFunctionKeyInput(data: string): string | undefined {
  const lettered = /^\x1b\[(?:1;1(?::[12])?)?([PQS])$/u.exec(data)
  if (lettered !== null) return FUNCTION_KEY_LETTERS[lettered[1]!]
  const numbered = /^\x1b\[(\d+);1(?::[12])?~$/u.exec(data)
  return numbered !== null && FUNCTION_KEY_NUMBERS.has(numbered[1]!) ? `\x1b[${numbered[1]!}~` : undefined
}

/** Alt+arrow in the "meta sends escape" encoding: the arrow, in CSI or SS3 form, after a bare ESC. */
const ESC_PREFIXED_ARROW = /^\x1b[[O]([ABCD])$/u
/** An SS3 prefix that carries an xterm modifier (`ESC O 3`), which pi-tui's input buffer cuts off its final byte. */
const SS3_MODIFIER = /^\x1bO([2-8])$/u

/**
 * Rejoin the two encodings of a modified key that pi-tui's input buffer delivers in two parts (spec §3.5): a bare
 * `ESC` before an arrow (`ESC ESC [ A`) and an SS3 modifier before its final byte (`ESC O 3`, `A`), each as the xterm
 * form `CSI 1;<mods> A` pi-tui decodes. Both parts arrive in one synchronous burst, so a held prefix that nothing
 * completes is delivered unchanged on the next microtask; a lone Escape keeps its meaning.
 * @param onInput - the receiver of decoded input sequences.
 * @returns the receiver to hand the terminal.
 */
export function joinSplitModifiers(onInput: (data: string) => void): (data: string) => void {
  let held: string | undefined
  const release = (): void => {
    if (held === undefined) return
    const prefix = held
    held = undefined
    onInput(prefix)
  }
  return (data) => {
    const prefix = held
    held = undefined
    if (prefix === '\x1b') {
      const arrow = ESC_PREFIXED_ARROW.exec(data)
      if (arrow !== null) return onInput(`\x1b[1;3${arrow[1]!}`)
    } else if (prefix !== undefined && /^[ABCDPQRS]$/u.test(data)) {
      return onInput(`\x1b[1;${prefix.slice(2)}${data}`)
    }
    if (prefix !== undefined) onInput(prefix)
    if (data === '\x1b' || SS3_MODIFIER.test(data)) {
      held = data
      queueMicrotask(release)
      return
    }
    onInput(data)
  }
}

/**
 * A terminal whose input passes through {@link joinSplitModifiers}; everything else is the terminal itself.
 * @param terminal - the terminal to wrap.
 * @returns the wrapped terminal.
 */
export function withJoinedModifiers(terminal: Terminal): Terminal {
  return new Proxy(terminal, {
    get(target, property, receiver) {
      if (property === 'start') return (onInput: (data: string) => void, onResize: () => void) => target.start(joinSplitModifiers(onInput), onResize)
      return Reflect.get(target, property, receiver)
    },
  })
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
  /** The TUI renderer behind the runtime; core-internal (pi-tui type). */
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
  /** The rows the dock (the search line, the editor, the footer) takes now. */
  dockRows(): number
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
  scrollContent(direction: 'up' | 'down', amount?: number): boolean
  /**
   * Where the content scroll stands against its tail, on the alternate screen: `undefined` on the main screen, whose
   * scrollback the terminal owns.
   */
  contentTail(): MayflyContentTail | undefined
  /**
   * Call back after each layout of the content scroll, when its standing against the tail may have changed.
   * @param listener - called with no arguments.
   * @returns a disposer.
   */
  watchContentTail(listener: () => void): () => void
  /**
   * Give the content scroll's bar its palette, read at each paint; until then the bar paints plain glyphs.
   * @param colors - reads the current theme's colors.
   */
  setContentScrollbarColors(colors: () => Pick<MayflySemanticColors, 'primary' | 'muted'> | undefined): void
  followContent(): void
  /**
   * Scroll the content so `row` stands at the top of the view, on the alternate screen; a row too low for a full view
   * lands on the tail, which follows it again.
   * @param row - the content row to bring to the top.
   */
  scrollContentTo(row: number): void
  /**
   * The row a root component's first line stands on among the scroll content's rows, as of the last frame.
   * @param component - a component mounted with `addChild`.
   * @returns the row, or `undefined` on the main screen or when the component is not in the content.
   */
  contentStart(component: MayflyComponent): number | undefined
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
   * Restore the terminal: deactivate the output guard, drain pending input,
   * then stop the renderer and the underlying terminal. Memoized: a second
   * caller receives the first call's promise and so settles only once the
   * terminal is restored. Terminal restore starts first at Fiber unload and
   * is awaited by it; the Fiber's children dispose concurrently and must
   * tolerate a stopping runtime.
   * @returns settles when the terminal state is restored.
   */
  stop(): Promise<void>
}

/** The content scroll's standing against its tail, and the cells its last row occupies on the screen. */
export interface MayflyContentTail {
  /** Whether the view is scrolled away from the newest content. */
  readonly away: boolean
  /** Rows that arrived below the view since it left the tail. */
  readonly unseen: number
  /** The content row the view's top stands on, and how many rows the view shows. */
  readonly top: number
  readonly viewport: number
  /** The viewport's last row and the columns the content region spans, in screen cells. */
  readonly row: number
  readonly col: number
  readonly width: number
}

/**
 * The content scroll view. It remembers how tall its content was the last time it showed the tail (for the pill's
 * count), and keeps a reader who scrolled away away: pi-tui clamps a view to the end when its content shrinks, which
 * switches follow back on, and a stream that rewrites its rows (a live draft settling into its message) shrinks for a
 * frame. The position the reader had is held until the content is tall enough again or they move.
 */
class TailScrollView extends BarredScrollView {
  /** The content height at the last layout that showed the tail. */
  tailHeight = 0
  measuredHeight = 0
  /** Where a reader scrolled away stood when the content shrank under them. */
  private heldTop: number | undefined
  /** Asks the layout for another frame (the callback of the last layout). */
  private relayout: (() => void) | undefined
  /** Frames in a row that ended with the rows at another length than the layout measured. */
  private unsettled = 0
  /** Called after each layout. */
  readonly watchers = new Set<() => void>()

  override updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
    const away = !this.isFollowingEnd
    const top = this.heldTop ?? this.scrollTop
    this.relayout = requestRender
    // A lazy document reports an estimate until its units paint, and the layout read the length before any row was read:
    // paint the window, and lay out again against the length it settles on, so follow-end lands on painted rows.
    const height = this.settledHeight(contentHeight, viewportHeight, requestRender)
    this.measuredHeight = height
    if (away && this.isFollowingEnd) {
      // The clamp followed the end for a reader who was away: put them back, or as near as the content allows.
      this.heldTop = top
      this.quietly(() => { super.scrollTo(top, { disableFollow: true }) })
    } else if (this.heldTop !== undefined) {
      const held = this.heldTop
      this.quietly(() => { super.scrollTo(held, { disableFollow: true }) })
      if (this.heldTop <= Math.max(0, height - viewportHeight)) this.heldTop = undefined
    }
    if (this.isFollowingEnd || height <= viewportHeight) this.tailHeight = height
    // The rows are read when the frame paints, after this layout: a count that moves then is found in the next
    // microtask and gets its own frame, whichever source painted it and whether or not that source says so.
    const rows = this.contentRows
    if (rows !== undefined) {
      queueMicrotask(() => {
        if (rows.length === this.measuredHeight) this.unsettled = 0
        else if ((this.unsettled += 1) <= SETTLE_FRAMES) this.relayout?.()
      })
    }
    for (const watcher of [...this.watchers]) watcher()
  }

  /** Lay out at `contentHeight`, then at the length the window's rows settle on (a few passes at most); the height laid out. */
  private settledHeight(contentHeight: number, viewportHeight: number, requestRender: () => void): number {
    super.updateLayout(contentHeight, viewportHeight, requestRender)
    const rows = this.contentRows
    let height = contentHeight
    for (let pass = 0; rows !== undefined && pass < SETTLE_PASSES; pass += 1) {
      prepareRows(rows, this.scrollTop, this.scrollTop + viewportHeight)
      if (rows.length === height) break
      height = rows.length
      super.updateLayout(height, viewportHeight, requestRender)
    }
    return height
  }

  /** A move the content cannot take is a stale height: lay out again, so the next press finds the real bottom. */
  override scrollBy(lines: number): number {
    this.heldTop = undefined
    const remaining = super.scrollBy(lines)
    if (remaining !== 0) this.relayout?.()
    return remaining
  }

  override scrollTo(scrollTop: number, options?: Parameters<ScrollView['scrollTo']>[1]): void {
    this.heldTop = undefined
    super.scrollTo(scrollTop, options)
  }

  override scrollToEnd(): void {
    this.heldTop = undefined
    super.scrollToEnd()
  }

  override scrollToStart(): void {
    this.heldTop = undefined
    super.scrollToStart()
  }
}

/** Layouts a view repeats at most, once its rows have painted and moved the length it measured. */
const SETTLE_PASSES = 6

/** Frames in a row a view asks for because its painted length moved; past it the content is not settling and waits for the next change. */
const SETTLE_FRAMES = 8

/** Constructor options for {@link startMayflyTerminal}. */
export interface MayflyTerminalOptions {
  /**
   * The probed terminal background ('dark'/'light'), already classified by
   * `backgroundFromRgb`. The caller owns the asynchronous probe so this
   * function can start the renderer synchronously: between acquiring the tty
   * and returning the runtime to its Fiber owner there is no `await`.
   */
  readonly background?: 'dark' | 'light' | undefined
  /** Called when the terminal reports a dark/light color-scheme switch. */
  readonly onSchemeChange?: (scheme: 'dark' | 'light') => void
  /**
   * Where the exit backstop records clamped lines; defaults to the
   * deduplicating file sink under pi-tui's log directory. Tests inject a
   * recorder.
   */
  readonly overflow?: OverflowSink
  /**
   * Renderer buffer mode. The Mayfly plugin selects `'alternate'`;
   * `'main'` remains available for compatibility fixtures.
   */
  readonly screenMode?: MayflyScreenMode
  /**
   * Filter alternate-screen frame output through the shadow-grid optimizer:
   * unchanged rows are dropped and a dominant vertical shift becomes one
   * scrolling-region update. Ignored on the main screen, whose scrollback the
   * terminal owns. Off by default.
   */
  readonly outputOptimizer?: boolean
  /**
   * stdout/stderr streams that host plugins may write around the renderer.
   * Production passes process streams; source-plane VT tests inject
   * recording streams.
   */
  readonly ambientOutput?: AmbientOutput
}

/**
 * Start the Mayfly terminal stack: a pi-tui renderer over a `ProcessTerminal`.
 * The renderer starts and subscribes to terminal color-scheme (mode 2031)
 * notifications, forwarded through `onSchemeChange`.
 * Production uses the alternate screen; main-screen mode remains an explicit
 * compatibility option. The returned runtime holds the renderer itself, so
 * the concrete pi-tui class never leaks past core.
 *
 * The function is synchronous by contract: its caller owns the asynchronous
 * background probe and registers the runtime's owner (a Fiber effect) before
 * acquiring the tty, so a runtime handed out here is always already owned.
 * @param hostTerminal - the terminal to drive; defaults to a real
 *   `ProcessTerminal` on process stdin/stdout. Tests inject a fake.
 * @param options - see {@link MayflyTerminalOptions}.
 * @returns the running stack's Mayfly-typed face.
 */
export function startMayflyTerminal(
  hostTerminal: Terminal = new ProcessTerminal(),
  options: MayflyTerminalOptions = {},
): MayflyTerminalRuntime {
  const alternate = (options.screenMode ?? 'main') === 'alternate'
  const onSchemeChange = options.onSchemeChange
  const overflow = options.overflow ?? createFileOverflowSink({ directory: defaultOverflowDirectory() })
  // Dynamic Host plugins intentionally log straight to process stdout/stderr.
  // In alternate-screen mode that bypasses the renderer at its hardware
  // cursor (normally inside the editor), so the text can overwrite both the
  // draft and footer until another input happens to redraw them. Preserve the
  // host write, then force a full frame on the next tick. Every renderer
  // write goes through the facade; output that did not is ambient.
  const outputRecovery = alternate && options.ambientOutput !== undefined
    ? createOutputRecovery(options.ambientOutput, () => current.requestRender(true))
    : undefined
  const terminal = alternate && options.outputOptimizer === true
    ? createOutputOptimizer(outputRecovery?.renderer(hostTerminal) ?? hostTerminal)
    : outputRecovery?.renderer(hostTerminal) ?? hostTerminal
  // The renderer reads input through the joiner, so a modified key split in two arrives as one sequence.
  const input = withJoinedModifiers(terminal)
  const current: TUI = alternate
    ? new TuiAltScreen(input, undefined, undefined, {
        wheelScrollLines: 3,
        copySelection: text => copySelectionText(text, terminal),
      })
    : new TuiMainScreen(input)
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
    const normalized = normalizeNavigationInput(data) ?? normalizeFunctionKeyInput(data)
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
    /* exercised by the real PTY input path */
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
  let scrollbarColors: () => Pick<MayflySemanticColors, 'primary' | 'muted'> | undefined = () => undefined
  const scrollView = contentContainer === undefined ? undefined : new TailScrollView(contentContainer, {
    follow: 'end',
    primary: true,
    overscroll: 'chain',
    scrollbar: true,
    colors: () => scrollbarColors(),
    // The stream moves only when the reader scrolls it (or follows its tail, which shows nothing), so focus does not gate it.
    focusGated: false,
    repaint: () => { current.requestRender() },
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
      if (internal.getFocusedComponent() === previous) current.setFocus(target)
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
    /* covered by the real-terminal and VT layout tiers */
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
  const background = options.background
  current.start()
  outputRecovery?.activate()
  current.setTerminalColorSchemeNotifications(true)
  if (onSchemeChange !== undefined) current.onTerminalColorSchemeChange(onSchemeChange)
  let stopped = false
  let suspended = false
  let stopping: Promise<void> | undefined
  const runtime: MayflyTerminalRuntime = {
    mode: alternate ? 'alternate' : 'main',
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
    tui: current,
    surfaces,
    surfaceViewport(id) {
      const layout = !alternate
        ? surfaces.linearLayout(terminal.columns, terminal.rows)
        : surfaces.layout(terminal.columns, terminal.rows)
      const lane = ([layout.header, layout.left, layout.right, layout.bottom] as const)
        .find(candidate => candidate?.entries.some(entry => entry.id === id))
      const columns = lane?.placement === 'left' || lane?.placement === 'right' ? lane.width ?? terminal.columns : terminal.columns
      if (!alternate) return { columns: Math.max(1, terminal.columns), rows: Math.max(1, terminal.rows) }
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
    dockRows() {
      if (alternate) return lastDockRows
      let rows = 0
      for (const child of orderedDock()) rows += child.render(current.terminal.columns).length
      return rows
    },
    releaseSurfaceFocus(id) {
      if (surfaces.focusedId !== id) return
      surfaces.setFocused(undefined)
      const target = mountedSurfaceBase()
      current.setFocus(target)
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
      current.setFocus(component)
    },
    /* exercised through the real PTY interaction path */
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
      current.requestRender(true)
      return true
    },
    watchContentTail(listener) {
      scrollView?.watchers.add(listener)
      return () => { scrollView?.watchers.delete(listener) }
    },
    contentTail() {
      if (scrollView === undefined) return undefined
      const layout = surfaces.layout(terminal.columns, terminal.rows)
      const left = layout.left === undefined ? 0 : (layout.left.width ?? 0) + 1
      const right = layout.right === undefined ? 0 : (layout.right.width ?? 0) + 1
      const away = !scrollView.isFollowingEnd && scrollView.measuredHeight > scrollView.viewportHeight
      return {
        away,
        unseen: away ? Math.max(0, scrollView.measuredHeight - scrollView.tailHeight) : 0,
        top: scrollView.scrollTop,
        viewport: scrollView.viewportHeight,
        row: lastSurfaceHeaderRows + Math.max(1, scrollView.viewportHeight) - 1,
        col: left,
        width: Math.max(1, terminal.columns - left - right - scrollView.barColumns),
      }
    },
    scrollContentTo(row) {
      scrollView?.scrollTo(Math.max(0, Math.floor(row)))
    },
    contentStart(component) {
      return contentContainer?.startOf(component)
    },
    setContentScrollbarColors(colors) {
      scrollbarColors = colors
      current.requestRender()
    },
    followContent() {
      if (current instanceof TuiAltScreen) {
        current.scrollToBottom()
        return
      }
      contentScrollOffset = 0
      current.requestRender(true)
    },
    setContentScrollHandler(handler) {
      contentScrollHandler = handler
      return () => {
        if (contentScrollHandler === handler) contentScrollHandler = undefined
      }
    },
    showOverlay(component, options) {
      if (options?.maxWidth === undefined) return current.showOverlay(component, options)
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
      return current.showOverlay(component, adapted)
    },
    requestRender(force) {
      current.requestRender(force)
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
      // Stopped while the stop sequences flushed: the child must not take
      // the tty at all; the teardown already ran the suspended branch.
      if (stopped) {
        suspended = false
        throw new Error('mayfly terminal stopped while suspending')
      }
      try {
        return await fn()
      } finally {
        suspended = false
        // Pause before start(): bytes buffered while suspended must not
        // surface as application input once raw mode re-arms.
        process.stdin.pause()
        // Torn down mid-suspend (fiber unload / fail-loud release): the
        // renderer must not restart; the settlement propagates as-is.
        if (!stopped) {
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
      // Memoized single-shot: every caller receives the first caller's
      // promise and so settles only once the terminal is restored.
      stopping ??= (async () => {
        stopped = true
        // The guard leaves first so the drain below never repaints into a
        // screen that is about to be left.
        outputRecovery?.deactivate()
        try {
          if (!suspended) {
            // Drain before stopping so in-flight Kitty key releases cannot
            // leak into the parent shell as literal escape sequences.
            await terminal.drainInput()
            current.stop()
          }
          // Suspended: the renderer is already stopped and a child owns the
          // tty — draining would steal the child's input and a second tui
          // stop would replay the teardown sequences.
        } finally {
          removeWheelNormalizer()
          removeViewportInput()
          removeContentScrollHandler()
          removeNavigationNormalizer()
          // Final teardown: drain overflow telemetry still queued off the
          // render path before the runtime goes away.
          await overflow.dispose?.()
        }
      })()
      return stopping
    },
  }
  return runtime
}
