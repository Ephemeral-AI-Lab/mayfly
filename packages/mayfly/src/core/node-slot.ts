/**
 * Node-backed screen slots: a core-private lease whose wire node compiles through the surface path (the same compiler
 * entry, surface runtime, and caches as a pane) into one of the screen's fixed hosts. The slot's interaction state is a
 * `slot` model in `mayflyUiInteraction`, so it outlives a renderer gap and a core reload: a screen teardown revokes the
 * leases and keeps their models for the next lease of the same id, and only an explicit `dispose()` drops a model.
 *
 * @module @ephemeral-ai/mayfly/core/node-slot
 */
import { freezeWire, type MayflyUiEventEndpoint, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { compileMayflyUiSurfaceNode, MayflyUiSurfaceRuntime, type MayflyCompiledUi, type MayflyUiViewport } from './ui-compiler.ts'
import type { MayflyUiImageSource } from './ui-images.ts'
import type { UiAnimationClock } from './ui-loader-animation.ts'
import type { UiInteractionService } from './ui-interaction-state.ts'
import type { UiSurfaceModel, UiSurfaceSnapshot } from './ui-interaction-surface.ts'
import type { MayflyWorkCounters } from './ui-work-counters.ts'
import type { MayflyComponent, MayflyComponents, MayflyFocusable, MayflyKeymap, MayflyScreenSlot, MayflySemanticColors } from './types.ts'

/** Where a node slot sits: the scroll region, the dock above the footer (the prompt's host), or the footer. */
export type MayflyNodeSlotRegion = 'content' | 'dock' | 'footer'

/** A lease on one node-backed screen slot. */
export interface MayflyNodeSlot {
  readonly id: string
  readonly disposed: boolean
  /** Publish the slot's node; `null` shows nothing and resets its interaction state, as a pane's `set(null)` does. */
  set(node: MayflyUiNode | null): void
  /** Give the slot keyboard focus. */
  focus(): void
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
  readonly translateHint?: (key: string) => string
  /** The host tree's byte source behind `image` nodes, as a pane's runtime receives it. */
  readonly images?: MayflyUiImageSource
  /**
   * Changes whenever a painted string can change without a publish (a key rebound, a new locale): a slot whose model
   * did not move then repaints its frame. Static leaves keep their rows and the hint row its text-keyed memo.
   */
  readonly epoch?: () => number
  /** Measurement sink for admission, compilation, and painting; production passes none. */
  readonly counters?: MayflyWorkCounters
}

const NO_ROWS = Object.freeze([]) as unknown as string[]

/**
 * A renderer's paint epoch: its keymap's revision plus its locale's, two counters that only grow.
 * @param keymap - the renderer's keymap; a fixture keymap without a revision counts as 0.
 * @param locale - the frontend locale service, absent outside a frontend tree.
 * @returns a number that changes whenever either changes.
 */
export function nodeSlotEpoch(keymap: MayflyKeymap, locale: { readonly snapshot: { readonly revision: number } } | undefined): number {
  return ((keymap as { readonly revision?: number }).revision ?? 0) + (locale?.snapshot.revision ?? 0)
}

/** Slots route no events yet: an action settles without a handler, as a disposed endpoint's does. */
const SLOT_EVENTS: MayflyUiEventEndpoint<MayflyUiNode | null> = Object.freeze({
  /* The surface never publishes a reply-less preparation. */
  prepare: async () => Object.freeze({ reply: undefined, /* v8 ignore next */ publish: () => false }),
})

/** Focus follows the compiled surface's focus target; a slot without controls takes no focus. */
function setCompiledFocus(compiled: MayflyCompiledUi | null, focused: boolean): void {
  const target = compiled?.focusTarget
  if (target !== undefined && target !== null) target.focused = focused
}

/** One slot's compile state under one bound renderer; a renderer gap disposes it and keeps the model. */
class SlotAttachment {
  readonly runtime: MayflyUiSurfaceRuntime
  compiled: MayflyCompiledUi | null = null
  private renderedRevision = -1
  private renderedEpoch: number | undefined
  private readonly off: () => void

  constructor(
    readonly model: UiSurfaceModel,
    private readonly compiler: MayflyNodeSlotCompiler,
    private readonly viewport: () => MayflyUiViewport,
    invalidate: () => void,
  ) {
    this.runtime = new MayflyUiSurfaceRuntime(model, () => { invalidate(); compiler.requestRender() }, compiler.clock, compiler.images)
    this.off = model.subscribe(() => { compiler.requestRender() })
  }

  /** The compiled node, recompiled when the model moved on since the last paint (a pane recompiles on the same signal). */
  current(focused: boolean): MayflyCompiledUi | null {
    const epoch = this.compiler.epoch?.()
    if (this.renderedRevision === this.model.revision) {
      if (epoch !== this.renderedEpoch) this.compiled?.component.invalidate()
      this.renderedEpoch = epoch
      return this.compiled
    }
    this.renderedEpoch = epoch
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
        contextHints: compiler.translateHint === undefined ? {} : { translate: compiler.translateHint },
        surfaceRuntime: this.runtime,
        ...(compiler.counters === undefined ? {} : { counters: compiler.counters }),
      })
      /* v8 ignore next -- the model's own admitted node skips validation, and the surface compiler contains its failures. */
      this.compiled = result.ok ? result.value : { node, component: result.errorComponent, focusTarget: null }
    }
    this.renderedRevision = this.model.revision
    setCompiledFocus(this.compiled, focused)
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

  get focused(): boolean { return this.focusedValue }
  set focused(value: boolean) {
    this.focusedValue = value
    if (this.attachment !== undefined) setCompiledFocus(this.attachment.compiled, value)
  }

  render(width: number): string[] { return this.attachment?.current(this.focusedValue)?.component.render(width) ?? NO_ROWS }
  invalidate(): void { this.attachment?.compiled?.component.invalidate() }
  handleInput(data: string): void { this.attachment?.current(this.focusedValue)?.focusTarget?.handleInput?.(data) }
}

class NodeSlotLease implements MayflyNodeSlot {
  private live = true
  private node: MayflyUiNode | null = null
  /** Whether `set` ran: until then a lease adopts a retained model without touching it. */
  private published = false
  private revision = 0
  /** The interaction owner that held this slot's model last; it outlives a renderer gap. */
  private interaction: UiInteractionService | undefined

  constructor(
    readonly id: string,
    private readonly surface: NodeSlotSurface,
    private readonly screen: MayflyScreenSlot,
    private readonly viewport: () => MayflyUiViewport,
    private readonly host: NodeSlotHost,
  ) {}

  get disposed(): boolean { return !this.live }

  set(node: MayflyUiNode | null): void {
    if (!this.live) return
    this.node = node === null ? null : freezeWire(node)
    this.published = true
    this.revision += 1
    this.attach(this.host.compiler)
  }

  focus(): void { if (this.live) this.screen.focus() }

  /** Publishes the slot's node into its model and compiles from it, under the bound renderer. */
  attach(compiler: MayflyNodeSlotCompiler | undefined): void {
    if (compiler === undefined || !this.published) return
    const snapshot: UiSurfaceSnapshot = {
      id: this.id,
      node: this.node,
      revision: this.revision,
      source: [],
      scope: { kind: 'app', targetId: this.id },
      update: { reason: 'data' },
      events: SLOT_EVENTS,
      definition: {},
    }
    const model = compiler.interaction.upsert('slot', snapshot, compiler.counters === undefined ? {} : { counters: compiler.counters })
    model.setVisible(this.node !== null)
    this.interaction = compiler.interaction
    // The endpoint is shared by every slot, so the owner keeps one model per id: an attachment already holds it.
    this.surface.attachment ??= new SlotAttachment(model, compiler, this.viewport, () => { this.surface.invalidate() })
  }

  /** A renderer gap: the compile state goes, the model stays. */
  detach(): void {
    this.surface.attachment?.dispose()
    this.surface.attachment = undefined
  }

  /** The screen's teardown (of a live lease): the lease ends and its model stays for the next lease of its id. */
  revoke(): void {
    this.live = false
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
  ) {}

  get compiler(): MayflyNodeSlotCompiler | undefined { return this.bound }

  /** Claims the region's host for `id`; it throws, leaving nothing behind, when the host is unknown or taken. */
  mount(id: string, region: MayflyNodeSlotRegion): MayflyNodeSlot {
    const surface = new NodeSlotSurface()
    const screen = this.mountScreenSlot(id, region, surface)
    const lease = new NodeSlotLease(id, surface, screen, () => this.viewport(region), this)
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
