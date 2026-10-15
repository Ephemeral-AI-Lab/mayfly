/**
 * Node-backed screen slots: a core-private lease whose wire node compiles through the surface path (the same compiler
 * entry, surface runtime, and caches as a pane) into one of the screen's fixed hosts. The slot's interaction state is a
 * `slot` model in `mayflyUiInteraction`, so it outlives a renderer gap and a core reload: a screen teardown revokes the
 * leases and keeps their models for the next lease of the same id, and only an explicit `dispose()` drops a model.
 *
 * @module @ephemeral-ai/mayfly/core/node-slot
 */
import { matchesKey, type KeyId } from '@earendil-works/pi-tui'
import { freezeWire, type MayflyTranslate, type MayflyUiEvent, type MayflyUiEventContext, type MayflyUiEventEndpoint, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { compileMayflyUiSurfaceNode, MayflyUiSurfaceRuntime, type MayflyCompiledUi, type MayflyUiViewport } from './ui-compiler.ts'
import type { MayflyContentCache } from './ui-content-cache.ts'
import type { MayflyUiImageSource } from './ui-images.ts'
import { ACTION_CANCEL, ACTION_FOCUS_NEXT } from './key-actions.ts'
import type { UiAnimationClock } from './ui-loader-animation.ts'
import type { UiInteractionService } from './ui-interaction-state.ts'
import type { UiSurfaceModel, UiSurfaceSnapshot } from './ui-interaction-surface.ts'
import type { MayflyWorkCounters } from './ui-work-counters.ts'
import type { MayflyComponent, MayflyComponents, MayflyFocusable, MayflyKeymap, MayflyScreenSlot, MayflySemanticColors } from './types.ts'

/** Where a node slot sits: the scroll region, the dock above the footer (the prompt's host), or the footer. */
export type MayflyNodeSlotRegion = 'content' | 'dock' | 'footer'

/** What the owner of a slot hears and decides. */
export interface MayflyNodeSlotOptions {
  readonly region: MayflyNodeSlotRegion
  /** An event the slot's controls emitted: an accepted row, an activated action, the cursor moving. */
  readonly onEvent?: (event: MayflyUiEvent) => void
  /** The slot received keyboard focus (the prompt handed it over). */
  readonly onFocus?: () => void
  /** `false`: the slot draws no key-hint row; its owner shows the keys somewhere else. */
  readonly hints?: boolean
  /** The slot gained or lost keyboard focus, by any path. */
  readonly onFocusChange?: (focused: boolean) => void
  /**
   * Keys the slot answers while it holds focus, by key id, each as an action of the slot's own: the key reaches the
   * owner as an `activate` event of the control `keys`. For a key a surface action may not claim (`ctrl+c` is reserved).
   */
  readonly keys?: Readonly<Record<string, string>>
  /** A list of the slot moved its cursor to another row (or lost it): the control and what the owner does with the row's item id. */
  readonly cursor?: { readonly control: string, readonly onMove: (itemId: string | undefined) => void }
  /** The reader asked to leave the focused slot (`Esc` or `Alt+↓`); the owner decides, typically with {@link MayflyNodeSlot.release}. */
  readonly onLeave?: () => void
}

/** A lease on one node-backed screen slot. */
export interface MayflyNodeSlot {
  readonly id: string
  readonly disposed: boolean
  /** Publish the slot's node; `null` shows nothing and resets its interaction state, as a pane's `set(null)` does. */
  set(node: MayflyUiNode | null): void
  /**
   * The number of the newest turn of the agent loop the slot's content holds. The owner knows turns, and the screen only
   * rows; the screen compares the number over time for its `N new turns` tally.
   */
  setTurns(latest: number): void
  /** Give the slot keyboard focus. */
  focus(): void
  /** Hand keyboard focus back to the prompt. */
  release(): void
  /** Replace the keys the slot answers itself while it holds focus (see {@link MayflyNodeSlotOptions.keys}). */
  setKeys(keys: Readonly<Record<string, string>>): void
  /**
   * Draw the slot as it is drawn while it holds focus (windowed around its cursor, the cursor row banded) without taking
   * keyboard focus: a search steps through the stream while its own line holds the keys.
   */
  spotlight(on: boolean): void
  /**
   * Stand the keyboard focus on one row of a list the slot shows, once the slot has compiled its newest node: the cursor
   * a list's `focusItem` moves is only the list's own, and the key that follows (`Enter`, `c`) acts on the focused row.
   */
  focusRow(controlId: string, itemId: string): void
  /**
   * The row the cursor of a list control stands on.
   * @param controlId - the list's id.
   * @returns the item id, or `undefined` when the slot shows no such list or it has no cursor yet.
   */
  cursor(controlId: string): string | undefined
  /** Release the slot and drop its interaction state. */
  dispose(): void
}

/** What a renderer lends the slots to compile them: the dependencies a pane compiles with. */
export interface MayflyNodeSlotCompiler {
  readonly interaction: UiInteractionService
  readonly components: MayflyComponents
  readonly colors: MayflySemanticColors
  readonly keymap: MayflyKeymap
  readonly mode: 'main' | 'alternate'
  readonly requestRender: () => void
  /** The renderer's one animation clock. */
  readonly clock?: UiAnimationClock
  /** The renderer's one painted-segment cache, shared by its panes, overlays, and slots. */
  readonly content?: MayflyContentCache
  /**
   * The translator a slot's contextual hints paint with and the locale revision behind it, as a pane receives them:
   * a moved revision repaints a slot whose model did not move through the compiler's own frame inputs.
   */
  readonly contextHints?: {
    readonly rows?: boolean
    readonly translate?: MayflyTranslate
    readonly revision?: () => number
  }
  /** The host tree's byte source behind `image` nodes, as a pane's runtime receives it. */
  readonly images?: MayflyUiImageSource
  /** Measurement sink for admission, compilation, and painting; production passes none. */
  readonly counters?: MayflyWorkCounters
}

const NO_ROWS = Object.freeze([]) as unknown as string[]

/**
 * The endpoint of one slot id, owned by the interaction service so it outlives the screen that leased the slot. An event
 * reaches the lease that currently holds the route and nobody else: a revoked or replaced lease has let go of it. The slot
 * answers without a reply, so nothing is published back; the owner changes what it shows by setting the slot's node.
 */
class SlotRoute implements MayflyUiEventEndpoint<MayflyUiNode | null> {
  private holder: NodeSlotLease | undefined

  hold(lease: NodeSlotLease): void { this.holder = lease }

  /** Only the current holder lets go; a stale lease cannot take the route from its successor. */
  letGo(lease: NodeSlotLease): void { if (this.holder === lease) this.holder = undefined }

  async prepare(event: MayflyUiEvent, context: MayflyUiEventContext): Promise<{ readonly reply: undefined, readonly publish: () => boolean }> {
    if (!context.signal.aborted) this.holder?.hear(event)
    return Object.freeze({ reply: undefined, publish: () => false })
  }
}

/** Focus follows the compiled surface's focus target; a slot without controls takes no focus. */
function setCompiledFocus(compiled: MayflyCompiledUi | null, focused: boolean): void {
  const target = compiled?.focusTarget
  if (target !== undefined && target !== null) target.focused = focused
}

/** One slot's compile state under one bound renderer; a renderer gap disposes it and keeps the model. */
class SlotAttachment {
  readonly runtime: MayflyUiSurfaceRuntime
  compiled: MayflyCompiledUi | null = null
  /** A row to stand focus on as soon as the compiled node has it (applied after the next compile). */
  pendingFocus: { readonly controlId: string, readonly itemId: string } | undefined
  private renderedRevision = -1
  private readonly off: () => void
  get keymap(): MayflyKeymap { return this.compiler.keymap }

  constructor(
    readonly model: UiSurfaceModel,
    private readonly compiler: MayflyNodeSlotCompiler,
    private readonly viewport: () => MayflyUiViewport,
    invalidate: () => void,
    private readonly flowRegion: boolean,
    private readonly hints: boolean,
  ) {
    this.runtime = new MayflyUiSurfaceRuntime(model, () => { invalidate(); compiler.requestRender() }, compiler.clock, compiler.images, () => { compiler.requestRender() }, compiler.content)
    this.runtime.flow = flowRegion
    this.off = model.subscribe(() => { compiler.requestRender() })
  }

  /** The content region is the outer scroll's content while the slot holds no focus; a focused slot keeps its cursor window. */
  focus(focused: boolean): void {
    this.runtime.flow = this.flowRegion && !focused
  }

  /** Ask for a paint, so a pending focus is applied. */
  invalidateSoon(): void { this.compiler.requestRender() }

  private applyPendingFocus(): void {
    const pending = this.pendingFocus
    const target = this.compiled?.focusTarget
    if (pending === undefined || target === undefined || target === null) return
    if (target.restoreFocusIdentity?.({ pagePath: [], controlId: pending.controlId, itemId: pending.itemId }) === true) this.pendingFocus = undefined
  }

  /** The compiled node, recompiled when the model moved on since the last paint (a pane recompiles on the same signal). */
  current(focused: boolean): MayflyCompiledUi | null {
    this.focus(focused)
    if (this.renderedRevision === this.model.revision) {
      this.applyPendingFocus()
      return this.compiled
    }
    setCompiledFocus(this.compiled, false)
    const node = this.model.decisionNode ?? this.model.node
    const compiler = this.compiler
    if (node === null) {
      this.runtime.deactivate()
      this.compiled = null
    } else {
      const result = compileMayflyUiSurfaceNode(node, {
        components: compiler.components,
        colors: compiler.colors,
        keymap: compiler.keymap,
        getViewport: this.viewport,
        screenMode: compiler.mode,
        emit: this.model.emit.bind(this.model),
        contextHints: { ...compiler.contextHints, ...this.hints ? {} : { rows: false } },
        surfaceRuntime: this.runtime,
        ...(compiler.counters === undefined ? {} : { counters: compiler.counters }),
      })
      /* the model's own admitted node skips validation, and the surface compiler contains its failures. */
      this.compiled = result.ok ? result.value : { node, component: result.errorComponent, focusTarget: null }
    }
    this.renderedRevision = this.model.revision
    setCompiledFocus(this.compiled, focused)
    this.applyPendingFocus()
    return this.compiled
  }

  dispose(): void {
    this.off()
    setCompiledFocus(this.compiled, false)
    this.compiled = null
    this.runtime.dispose()
  }
}

/** The component a screen host shows for one slot. */
class NodeSlotSurface implements MayflyFocusable {
  attachment: SlotAttachment | undefined
  private focusedValue = false
  private spotlit = false

  constructor(private readonly leave: (() => void) | undefined, private readonly changed: ((focused: boolean) => void) | undefined, public keys: Readonly<Record<string, string>>, private readonly onKey: (actionId: string) => void) {}

  get focused(): boolean { return this.focusedValue }
  set focused(value: boolean) {
    const before = this.focusedValue
    this.focusedValue = value
    if (before !== value) this.changed?.(value)
    this.attachment?.focus(this.shown)
    if (this.attachment !== undefined) setCompiledFocus(this.attachment.compiled, this.shown)
  }

  /** Whether the slot is drawn as focused: it holds focus, or a search is stepping through it. */
  private get shown(): boolean { return this.focusedValue || this.spotlit }

  set spotlight(on: boolean) {
    if (this.spotlit === on) return
    this.spotlit = on
    this.attachment?.focus(this.shown)
    if (this.attachment !== undefined) setCompiledFocus(this.attachment.compiled, this.shown)
    this.attachment?.invalidateSoon()
  }

  render(width: number): string[] { return this.attachment?.current(this.shown)?.component.render(width) ?? NO_ROWS }
  invalidate(): void { this.attachment?.compiled?.component.invalidate() }
  handleInput(data: string): void {
    const attachment = this.attachment
    if (attachment === undefined) return
    // Leaving is the owner's call: a focused slot gives `Esc` and `Alt+↓` (the way back down the focus levels) to it.
    if (this.leave !== undefined && (attachment.keymap.matches(data, ACTION_CANCEL) || attachment.keymap.matches(data, ACTION_FOCUS_NEXT))) {
      this.leave()
      return
    }
    for (const [key, actionId] of Object.entries(this.keys)) {
      if (matchesKey(data, key as KeyId)) {
        this.onKey(actionId)
        return
      }
    }
    attachment.current(this.shown)?.focusTarget?.handleInput?.(data)
  }
}

class NodeSlotLease implements MayflyNodeSlot {
  private live = true
  private node: MayflyUiNode | null = null
  /** Whether `set` ran: until then a lease adopts a retained model without touching it. */
  private published = false
  /** The newest turn the owner reported in this slot's content. */
  turns = 0
  private revision = 0
  /** The interaction owner that held this slot's model last; it outlives a renderer gap. */
  private interaction: UiInteractionService | undefined

  constructor(
    readonly id: string,
    private readonly surface: NodeSlotSurface,
    private readonly screen: MayflyScreenSlot,
    private readonly viewport: () => MayflyUiViewport,
    private readonly host: NodeSlotHost,
    readonly region: MayflyNodeSlotRegion,
    private readonly options: MayflyNodeSlotOptions,
  ) {}

  /** The route this lease holds; it is the interaction service's, so the next lease of the same id finds the same one. */
  private route: SlotRoute | undefined
  /** Ends the watch of the cursor the owner asked for. */
  private cursorOff: (() => void) | undefined

  get disposed(): boolean { return !this.live }

  /** An event the slot's controls emitted, from the route; a lease that ended hears nothing. */
  hear(event: MayflyUiEvent): void { if (this.live) this.options.onEvent?.(event) }

  set(node: MayflyUiNode | null): void {
    if (!this.live) return
    this.node = node === null ? null : freezeWire(node)
    this.published = true
    this.revision += 1
    this.attach(this.host.compiler)
  }

  setTurns(latest: number): void {
    if (!this.live) return
    const next = Math.max(0, Math.floor(latest))
    if (next === this.turns) return
    this.turns = next
    if (this.region === 'content') this.host.contentTurnsChanged()
  }

  /** Whether the lease shows content, so there is something to focus. */
  get filled(): boolean { return this.live && this.node !== null }

  focus(): void {
    if (!this.live) return
    this.screen.focus()
    this.options.onFocus?.()
  }

  release(): void { if (this.live) this.host.focusPrompt() }

  spotlight(on: boolean): void { if (this.live) this.surface.spotlight = on }

  setKeys(keys: Readonly<Record<string, string>>): void { if (this.live) this.surface.keys = keys }

  focusRow(controlId: string, itemId: string): void {
    const attachment = this.surface.attachment
    if (!this.live || attachment === undefined) return
    attachment.pendingFocus = { controlId, itemId }
    attachment.invalidateSoon()
  }

  cursor(controlId: string): string | undefined {
    return this.surface.attachment?.model.choice({ pagePath: [], controlId })?.focusedId
  }

  /** Publishes the slot's node into its model and compiles from it, under the bound renderer. */
  attach(compiler: MayflyNodeSlotCompiler | undefined): void {
    if (compiler === undefined || !this.published || !this.live) return
    const route = compiler.interaction.endpoint('slot', this.id, () => new SlotRoute())
    if (this.route !== route) this.route?.letGo(this)
    route.hold(this)
    this.route = route
    const snapshot: UiSurfaceSnapshot = {
      id: this.id,
      node: this.node,
      revision: this.revision,
      source: [],
      scope: { kind: 'app', targetId: this.id },
      update: { reason: 'data' },
      events: route,
      definition: {},
    }
    const model = compiler.interaction.upsert('slot', snapshot, compiler.counters === undefined ? {} : { counters: compiler.counters })
    model.setVisible(this.node !== null)
    this.interaction = compiler.interaction
    const watched = this.options.cursor
    if (watched !== undefined && this.cursorOff === undefined) {
      let last: string | undefined
      this.cursorOff = model.subscribe(() => {
        const next = this.cursor(watched.control)
        if (next === last) return
        last = next
        watched.onMove(next)
      })
    }
    // The route is one object per id for as long as the owner keeps the id, so the owner hands every lease of it the one model.
    this.surface.attachment ??= new SlotAttachment(model, compiler, this.viewport, () => { this.surface.invalidate() }, this.region === 'content', this.options.hints !== false)
  }

  /** A renderer gap: the compile state goes, the model stays. */
  detach(): void {
    this.surface.attachment?.dispose()
    this.surface.attachment = undefined
  }

  /** The screen's teardown (of a live lease): the lease ends and its model stays for the next lease of its id. */
  revoke(): void {
    this.live = false
    this.cursorOff?.()
    this.cursorOff = undefined
    this.route?.letGo(this)
    this.route = undefined
    this.detach()
    this.screen.dispose()
  }

  dispose(): void {
    if (!this.live) return
    this.revoke()
    this.host.release(this, this.interaction)
  }
}

/** The node slots of one screen: their leases, and the renderer that compiles them while one is bound. */
export class NodeSlotHost {
  private readonly leases = new Map<string, NodeSlotLease>()
  private bound: MayflyNodeSlotCompiler | undefined
  /** Ids whose leases ended explicitly before any renderer held their model; the next bind drops those models. */
  private readonly forgotten = new Set<string>()

  constructor(
    private readonly mountScreenSlot: (id: string, region: MayflyNodeSlotRegion, component: MayflyComponent) => MayflyScreenSlot,
    private readonly viewport: (region: MayflyNodeSlotRegion) => MayflyUiViewport,
    private readonly focusPromptHost: () => void,
  ) {}

  /** Hand keyboard focus back to the prompt. */
  focusPrompt(): void { this.focusPromptHost() }

  /**
   * Focus the conversation: the scroll region's slot that shows content.
   * @returns whether one took focus; `false` leaves the key to the prompt.
   */
  focusContent(): boolean {
    for (const lease of this.leases.values()) {
      if (lease.region === 'content' && lease.filled) {
        lease.focus()
        return true
      }
    }
    return false
  }

  get compiler(): MayflyNodeSlotCompiler | undefined { return this.bound }

  private readonly turnListeners = new Set<() => void>()

  /** Listen to the newest content turn changing. */
  onContentTurns(listener: () => void): () => void {
    this.turnListeners.add(listener)
    return () => { this.turnListeners.delete(listener) }
  }

  contentTurnsChanged(): void {
    for (const listener of [...this.turnListeners]) listener()
  }

  /** The newest turn the owners of the scroll region's slots reported. */
  contentTurns(): number {
    let latest = 0
    for (const lease of this.leases.values()) if (lease.region === 'content') latest = Math.max(latest, lease.turns)
    return latest
  }

  /** Claims the region's host for `id`; it throws, leaving nothing behind, when the host is unknown or taken. */
  mount(id: string, options: MayflyNodeSlotOptions): MayflyNodeSlot {
    const { region } = options
    const surface = new NodeSlotSurface(options.onLeave, options.onFocusChange, options.keys ?? {}, actionId => { options.onEvent?.({ kind: 'activate', pagePath: [], controlId: 'keys', actionId }) })
    const screen = this.mountScreenSlot(id, region, surface)
    const lease = new NodeSlotLease(id, surface, screen, () => this.viewport(region), this, region, options)
    this.leases.set(id, lease)
    return lease
  }

  /** Lends a renderer to every slot until the returned disposer runs. */
  bind(compiler: MayflyNodeSlotCompiler): () => void {
    // A newer renderer replaces the older one's compile state; nothing may paint with stale dependencies.
    if (this.bound !== undefined) for (const lease of this.leases.values()) lease.detach()
    this.bound = compiler
    for (const id of this.forgotten) compiler.interaction.remove('slot', id)
    this.forgotten.clear()
    for (const lease of this.leases.values()) lease.attach(compiler)
    return () => {
      if (this.bound !== compiler) return
      this.bound = undefined
      for (const lease of this.leases.values()) lease.detach()
    }
  }

  /** An explicit dispose drops the slot's model now, or at the next bind when no interaction owner is known yet. */
  release(lease: NodeSlotLease, interaction: UiInteractionService | undefined): void {
    this.leases.delete(lease.id)
    const owner = this.bound?.interaction ?? interaction
    if (owner === undefined) this.forgotten.add(lease.id)
    else owner.remove('slot', lease.id)
  }

  /** The screen's teardown: every lease is revoked and every model kept. */
  dispose(): void {
    for (const lease of this.leases.values()) lease.revoke()
    this.leases.clear()
  }
}
