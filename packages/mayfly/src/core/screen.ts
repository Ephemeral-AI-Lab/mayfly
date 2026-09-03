/**
 * `ctx.mayflyScreen` service: the L1 component-mounting contract, delegating
 * to the L0 terminal runtime.
 *
 * @module @ephemeral-ai/mayfly/core/screen
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { MayflyTerminalRuntime } from './terminal.ts'
import type { MayflyComponent, MayflyFocusable, MayflyOverlayHandle, MayflyOverlayOptions, MayflyScreen, MayflyScreenSlot } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    mayflyScreen: MayflyScreenService
  }
}

class StableSlotHost implements MayflyFocusable {
  private active = true
  private focusedValue = false

  constructor(
    readonly id: string,
    private target: MayflyComponent | null,
    private readonly runtime: MayflyTerminalRuntime,
  ) {}

  get focused(): boolean { return this.active && this.focusedValue }
  set focused(value: boolean) {
    this.focusedValue = this.active && this.target !== null && value
    const target = this.focusTarget()
    if (target !== null) target.focused = this.focusedValue
  }

  replace(component: MayflyComponent | null): void {
    if (!this.active || component === this.target) return
    const previous = this.focusTarget()
    if (previous !== null) previous.focused = false
    this.target = component
    const next = this.focusTarget()
    if (next !== null) next.focused = this.focusedValue
    this.runtime.requestRender()
  }

  focus(): void {
    if (!this.active || this.target === null) return
    this.runtime.setFocus(this)
  }

  render(width: number): string[] { return this.target?.render(width) ?? [] }
  invalidate(): void { this.target?.invalidate() }
  handleInput(data: string): void { this.target?.handleInput?.(data) }

  clear(): void {
    if (this.focusedValue) this.runtime.setFocus(null)
    const target = this.focusTarget()
    if (target !== null) target.focused = false
    this.focusedValue = false
    this.target = null
    this.runtime.requestRender()
  }

  deactivate(): void {
    this.clear()
    this.active = false
  }

  private focusTarget(): MayflyFocusable | null {
    return this.target !== null && typeof (this.target as MayflyFocusable).focused === 'boolean'
      ? this.target as MayflyFocusable
      : null
  }
}

class ScreenSlotLease implements MayflyScreenSlot {
  private live = true

  constructor(
    readonly id: string,
    private readonly host: StableSlotHost,
    private readonly release: () => void,
  ) {}

  get disposed(): boolean { return !this.live }
  get component(): MayflyFocusable { return this.host }

  replace(component: MayflyComponent | null): void { if (this.live) this.host.replace(component) }
  focus(): void { if (this.live) this.host.focus() }

  dispose(): void {
    if (!this.live) return
    this.live = false
    this.release()
  }
}

/** Fixed root region containing ephemeral local notices and shell echoes. */
class LocalActivityRegion implements MayflyComponent {
  private readonly children = new Map<string, StableSlotHost>()

  add(id: string, child: StableSlotHost): void { this.children.set(id, child) }
  remove(id: string): void { this.children.delete(id) }
  render(width: number): string[] { return [...this.children.values()].flatMap(child => child.render(width)) }
  invalidate(): void { for (const child of this.children.values()) child.invalidate() }
}

const CONTENT_HOSTS = ['transcript.prelude', 'transcript.conversation'] as const
const DOCK_HOSTS = ['editor.prompt', 'status.footer'] as const

/**
 * The `mayflyScreen` service. Registered by the `mayfly-core` plugin together
 * with the terminal runtime it delegates to; unregistered automatically when
 * the plugin's fiber unloads.
 */
export class MayflyScreenService extends Service implements MayflyScreen {
  private readonly runtime: MayflyTerminalRuntime
  private readonly fixed = new Map<string, StableSlotHost>()
  private readonly claimed = new Set<string>()
  private readonly local = new LocalActivityRegion()

  /**
   * Create and register the service.
   * @param ctx - the owning Cordis context.
   * @param runtime - the terminal runtime started by the `mayfly-core` plugin.
   */
  constructor(ctx: Context, runtime: MayflyTerminalRuntime) {
    super(ctx, 'mayflyScreen')
    this.runtime = runtime
    for (const id of CONTENT_HOSTS) {
      const host = new StableSlotHost(id, null, runtime)
      this.fixed.set(id, host)
      runtime.addChild(host)
    }
    runtime.addChild(this.local)
    const editor = new StableSlotHost('editor.prompt', null, runtime)
    const footer = new StableSlotHost('status.footer', null, runtime)
    this.fixed.set('editor.prompt', editor)
    this.fixed.set('status.footer', footer)
    runtime.addBottomChild(editor)
    runtime.addBottomChild(footer, 'bottom')
    runtime.requestRender()
  }

  /** Current terminal width in columns. */
  get columns(): number {
    return this.runtime.columns
  }

  /** Current terminal height in rows. */
  get rows(): number {
    return this.runtime.rows
  }

  mountContentSlot(id: string, component: MayflyComponent | null): MayflyScreenSlot {
    const fixed = this.fixed.get(id)
    return fixed === undefined ? this.mountLocal(id, component) : this.claim(id, fixed, component)
  }

  mountDockSlot(id: string, component: MayflyComponent | null, position?: 'bottom'): MayflyScreenSlot {
    const host = this.fixed.get(id)
    if (host === undefined || !DOCK_HOSTS.includes(id as typeof DOCK_HOSTS[number])) {
      throw new Error(`unknown dock slot "${id}"`)
    }
    if ((id === 'status.footer') !== (position === 'bottom')) throw new Error(`dock slot "${id}" has a fixed position`)
    return this.claim(id, host, component)
  }

  private claim(id: string, host: StableSlotHost, component: MayflyComponent | null): MayflyScreenSlot {
    if (this.claimed.has(id)) throw new Error(`screen slot "${id}" is already mounted`)
    this.claimed.add(id)
    host.replace(component)
    return new ScreenSlotLease(id, host, () => {
      host.clear()
      this.claimed.delete(id)
    })
  }

  private mountLocal(id: string, component: MayflyComponent | null): MayflyScreenSlot {
    if (this.claimed.has(id)) throw new Error(`screen slot "${id}" is already mounted`)
    const host = new StableSlotHost(id, component, this.runtime)
    this.claimed.add(id)
    this.local.add(id, host)
    this.runtime.requestRender()
    return new ScreenSlotLease(id, host, () => {
      host.deactivate()
      this.local.remove(id)
      this.claimed.delete(id)
      this.runtime.requestRender()
    })
  }

  /**
   * Move keyboard focus; `null` releases focus entirely.
   * @param component - the component to focus, or `null`.
   */
  setFocus(component: MayflyComponent | null): void {
    this.runtime.setFocus(component)
  }

  scrollContent = (direction: 'up' | 'down', amount?: number): boolean => {
    return this.runtime.scrollContent(direction, amount)
  }

  contentChanged = (): boolean => {
    return this.runtime.contentChanged()
  }

  /* v8 ignore start -- exercised by End in the real input path */
  followContent = (): void => {
    /* v8 ignore next */
    this.runtime.followContent()
  }

  /* v8 ignore start -- exercised through the real terminal input boundary */
  setContentScrollHandler = (handler: ((data: string) => boolean) | undefined): (() => void) => {
    return this.runtime.setContentScrollHandler(handler)
  }
  /* v8 ignore stop */

  /**
   * Mount a component as an overlay above the base content.
   * @param component - the overlay component.
   * @param options - positioning and sizing options.
   * @returns the overlay's control handle.
   */
  showOverlay(component: MayflyComponent, options?: MayflyOverlayOptions): MayflyOverlayHandle {
    return this.runtime.showOverlay(component, options)
  }

  /**
   * Schedule a throttled re-render.
   * @param force - reset differential render state before drawing.
   */
  requestRender(force?: boolean): void {
    this.runtime.requestRender(force)
  }

  /**
   * Suspend the renderer and run `fn` with the terminal released for a
   * child process; resumes with a forced full repaint. See
   * {@link MayflyScreen.suspend} for the exclusivity and teardown semantics.
   * @param fn - the async body owning the terminal while it is released.
   * @returns settles with fn's outcome after the renderer resumed.
   */
  suspend<T>(fn: () => Promise<T>): Promise<T> {
    return this.runtime.suspend(fn)
  }

  /**
   * Set the terminal's window/tab title (a sanitized OSC 0 write; inside
   * tmux, the tmux window name).
   * @param title - untrusted title text; control characters are stripped
   *   and the payload capped before the write.
   */
  setTitle(title: string): void {
    this.runtime.setTitle(title)
  }
}
