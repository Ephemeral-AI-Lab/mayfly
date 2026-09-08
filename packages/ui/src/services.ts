/** Direct Fiber-owned snapshot registries for Mayfly UI contributions.
 * @module @ephemeral-ai/mayfly-ui/services
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-include'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { freezeWire } from './builders.ts'
import { admitSnapshotUpdate, UiEventEndpoint, validateScope, validateSource } from './snapshot-events.ts'
import type {
  MayflyEditorDecoration,
  MayflyEditorExtensionDefinition,
  MayflyEditorExtensionEntry,
  MayflyEditorExtensionRegistration,
  MayflyEditorExtensionRegistry,
  MayflyOverlayDefinition,
  MayflyOverlayEntry,
  MayflyOverlayHandle,
  MayflyOverlayRegistry,
  MayflyPaneDefinition,
  MayflyPaneEntry,
  MayflyPaneRegistration,
  MayflyPaneRegistry,
  MayflyRegistryDelta,
  MayflyStatusDefinition,
  MayflyStatusEntry,
  MayflyStatusNode,
  MayflyStatusRegistration,
  MayflyStatusRegistry,
  MayflyUiNode,
  MayflySnapshotUpdate,
  MayflySnapshotChange,
  MayflyUiEventHandlers,
  MayflyInteractionDefinition,
  MayflyInteractionSnapshot,
} from './contracts.ts'

const ID = /^[a-z0-9][a-z0-9._/-]*$/u
const PANE_PLACEMENTS = new Set(['header', 'left', 'right', 'bottom'])
const NARROW_POLICIES = new Set(['bottom', 'overlay', 'hidden'])
const STATUS_BANDS = new Set(['left', 'center', 'right'])
const STATUS_OVERFLOW = new Set(['truncate', 'hide'])
const OVERLAY_ANCHORS = new Set(['center', 'top', 'bottom', 'left', 'right'])
const PERCENTAGE = /^\d+(?:\.\d+)?%$/u

function assertId(id: string, kind: string): void {
  if (!ID.test(id)) throw new TypeError(`${kind} id "${id}" is invalid`)
}

function assertRecord(value: unknown, kind: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${kind} definition must be an object`)
}

function optionalString(value: unknown, path: string): void {
  if (value !== undefined && typeof value !== 'string') throw new TypeError(`${path} must be a string`)
}

function optionalBoolean(value: unknown, path: string): void {
  if (value !== undefined && typeof value !== 'boolean') throw new TypeError(`${path} must be a boolean`)
}

function optionalNonNegativeInteger(value: unknown, path: string): void {
  if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError(`${path} must be a non-negative safe integer`)
  }
}

function optionalInteger(value: unknown, path: string): void {
  if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value))) {
    throw new TypeError(`${path} must be a safe integer`)
  }
}

function optionalCallback(value: unknown, path: string): void {
  if (value !== undefined && typeof value !== 'function') throw new TypeError(`${path} must be a function`)
}

function optionalEventHandlers(value: unknown, path: string): void {
  if (value === undefined) return
  assertRecord(value, path)
  if (Object.keys(value).some(key => key !== 'observe' && key !== 'action')) throw new TypeError(`${path} contains an unknown handler`)
  optionalCallback(value.observe, `${path}.observe`)
  optionalCallback(value.action, `${path}.action`)
  if (value.observe === undefined && value.action === undefined) throw new TypeError(`${path} requires an observe or action handler`)
}

function validateSize(value: unknown, path: string): void {
  if (value === undefined) return
  assertRecord(value, path)
  optionalNonNegativeInteger(value.min, `${path}.min`)
  optionalNonNegativeInteger(value.max, `${path}.max`)
  if (value.preferred !== undefined && value.preferred !== 'auto') optionalNonNegativeInteger(value.preferred, `${path}.preferred`)
  const min = value.min as number | undefined
  const max = value.max as number | undefined
  const preferred = value.preferred === 'auto' || value.preferred === undefined ? undefined : value.preferred as number
  if (min !== undefined && max !== undefined && min > max) throw new TypeError(`${path}.min must not exceed max`)
  if (preferred !== undefined && min !== undefined && preferred < min) throw new TypeError(`${path}.preferred must not be below min`)
  if (preferred !== undefined && max !== undefined && preferred > max) throw new TypeError(`${path}.preferred must not exceed max`)
}

function validateSurfaceDefinition(definition: unknown, kind: string): asserts definition is Record<string, unknown> {
  assertRecord(definition, kind)
  if (typeof definition.id !== 'string') throw new TypeError(`${kind} id must be a string`)
  assertId(definition.id, kind)
  if (definition.scope !== undefined) validateScope(definition.scope)
  if (definition.source !== undefined) validateSource(definition.source)
}

function validatePaneDefinition(definition: unknown): void {
  validateSurfaceDefinition(definition, 'pane')
  if (!PANE_PLACEMENTS.has(definition.placement as string)) throw new TypeError('pane placement is invalid')
  optionalString(definition.title, 'pane title')
  optionalInteger(definition.priority, 'pane priority')
  validateSize(definition.size, 'pane size')
  if (definition.narrow !== undefined && !NARROW_POLICIES.has(definition.narrow as string)) throw new TypeError('pane narrow policy is invalid')
  optionalEventHandlers(definition.onEvent, 'pane onEvent')
  optionalCallback(definition.load, 'pane load')
}

function validateStatusDefinition(definition: unknown): void {
  validateSurfaceDefinition(definition, 'status')
  optionalInteger(definition.priority, 'status priority')
  if (definition.band !== undefined && !STATUS_BANDS.has(definition.band as string)) throw new TypeError('status band is invalid')
  if (definition.row !== undefined && (definition.row !== 1 && definition.row !== 2)) throw new TypeError('status row is invalid')
  if (definition.overflow !== undefined && !STATUS_OVERFLOW.has(definition.overflow as string)) throw new TypeError('status overflow policy is invalid')
}

function validateOverlaySize(value: unknown, path: string): void {
  if (value === undefined) return
  if (typeof value === 'number') {
    optionalNonNegativeInteger(value, path)
    return
  }
  if (typeof value !== 'string' || !PERCENTAGE.test(value) || Number.parseFloat(value) > 100) throw new TypeError(`${path} must be a safe pixel value or percentage up to 100%`)
}

function validateOverlayDefinition(definition: unknown): void {
  validateSurfaceDefinition(definition, 'overlay')
  optionalString(definition.title, 'overlay title')
  optionalBoolean(definition.capturing, 'overlay capturing')
  optionalBoolean(definition.dismissible, 'overlay dismissible')
  if (definition.dismissal !== undefined && definition.dismissal !== 'confirm-dirty' && definition.dismissal !== 'discard') throw new TypeError('overlay dismissal is invalid')
  if (definition.presentation !== undefined && definition.presentation !== 'overlay' && definition.presentation !== 'editor') throw new TypeError('overlay presentation is invalid')
  if (definition.presentation === 'editor' && definition.capturing !== true) throw new TypeError('editor presentations must capture input')
  if (definition.anchor !== undefined && !OVERLAY_ANCHORS.has(definition.anchor as string)) throw new TypeError('overlay anchor is invalid')
  validateOverlaySize(definition.width, 'overlay width')
  validateOverlaySize(definition.maxHeight, 'overlay maxHeight')
  optionalNonNegativeInteger(definition.minWidth, 'overlay minWidth')
  optionalEventHandlers(definition.onEvent, 'overlay onEvent')
  optionalCallback(definition.load, 'overlay load')
}

function validateEditorExtensionDefinition(definition: unknown): void {
  validateSurfaceDefinition(definition, 'editor extension')
  optionalInteger(definition.priority, 'editor extension priority')
  optionalEventHandlers(definition.onEvent, 'editor extension onEvent')
  optionalCallback(definition.complete, 'editor extension complete')
  optionalCallback(definition.transformSubmit, 'editor extension transformSubmit')
}

abstract class ObservableRegistry<Entry extends { readonly id: string }> extends Service {
  protected readonly listeners = new Set<(delta: MayflyRegistryDelta<Entry>) => void>()
  abstract list(): readonly Entry[]

  subscribe(listener: (delta: MayflyRegistryDelta<Entry>) => void): () => void {
    this.listeners.add(listener)
    for (const entry of this.list()) listener({ kind: 'upsert', entry })
    return this.ctx.effect(() => () => { this.listeners.delete(listener) })
  }

  protected upsert(entry: Entry): void {
    const delta = Object.freeze({ kind: 'upsert' as const, entry })
    for (const listener of this.listeners) listener(delta)
  }

  protected remove(id: string, revision: number): void {
    const delta = Object.freeze({ kind: 'remove' as const, id, revision })
    for (const listener of this.listeners) listener(delta)
  }
}

function snapshotMetadata(definition: MayflyInteractionDefinition): (update: MayflySnapshotChange) => MayflyInteractionSnapshot {
  let scope = definition.scope ?? freezeWire({ kind: 'app' as const, targetId: 'application' })
  let source = definition.source ?? freezeWire([])
  return update => {
    if ('scope' in update && update.scope !== undefined) scope = update.scope
    if (update.source !== undefined) source = update.source
    return { scope, source }
  }
}

class SnapshotHandle<Node> {
  private live = true
  private revisionValue = 0
  readonly events: UiEventEndpoint<Node>

  constructor(
    private readonly publish: (node: Node, revision: number, update?: MayflySnapshotChange) => void,
    private readonly cleanup: (revision: number) => void,
    id: string,
    handler?: MayflyUiEventHandlers<Node>,
  ) {
    this.events = new UiEventEndpoint(id, handler, (node, update) => this.commit(node, update))
  }

  get disposed(): boolean { return !this.live }
  get revision(): number { return this.revisionValue }

  set(node: Node, update?: MayflySnapshotUpdate): void {
    if (!this.live) return
    const frozen = freezeWire(node)
    const admittedUpdate = admitSnapshotUpdate(update)
    if (admittedUpdate.reason === 'replace' || node === null) this.events.replace()
    this.commit(frozen, admittedUpdate)
  }

  private commit(node: Node, update: MayflySnapshotChange): void {
    this.revisionValue += 1
    this.publish(node, this.revisionValue, update)
  }

  dispose(): void {
    this.live = false
    this.events.dispose()
    this.revisionValue += 1
    this.cleanup(this.revisionValue)
  }
}

export class MayflyPaneService extends ObservableRegistry<MayflyPaneEntry> implements MayflyPaneRegistry {
  private readonly entries = new Map<string, MayflyPaneEntry>()

  constructor(ctx: Context) { super(ctx, 'mayflyPanes') }

  register(definition: MayflyPaneDefinition, initialNode: MayflyUiNode | null = null): MayflyPaneRegistration {
    const admittedDefinition = freezeWire(definition)
    validatePaneDefinition(admittedDefinition)
    const id = admittedDefinition.id
    if (this.entries.has(id)) throw new Error(`pane "${id}" is already registered`)
    const admittedNode = freezeWire(initialNode)
    const metadata = snapshotMetadata(admittedDefinition)
    const publish = (node: MayflyUiNode | null, revision: number, update: MayflySnapshotChange = {}): void => {
      const entry = Object.freeze({ id, definition: admittedDefinition, node, revision, ...metadata(update), update: freezeWire(update), events: handle.events.endpoint })
      this.entries.set(id, entry)
      this.upsert(entry)
    }
    let handle!: SnapshotHandle<MayflyUiNode | null> & MayflyPaneRegistration
    const remove = (revision: number): void => {
      this.entries.delete(id)
      this.remove(id, revision)
    }
    handle = new SnapshotHandle(publish, remove, id, admittedDefinition.onEvent) as SnapshotHandle<MayflyUiNode | null> & MayflyPaneRegistration
    let activeLoad: AbortController | undefined
    let nextCursor: string | undefined
    let cursorRevision = 0
    const cleanup = this.ctx.effect(() => () => handle.dispose())
    const originalDispose = handle.dispose.bind(handle)
    handle.dispose = (): void => {
      if (handle.disposed) return
      activeLoad?.abort()
      originalDispose()
      cleanup()
    }
    handle.refresh = async (): Promise<void> => {
      const load = admittedDefinition.load
      if (load === undefined || handle.disposed) return
      nextCursor = undefined
      activeLoad?.abort()
      const controller = new AbortController()
      activeLoad = controller
      const revision = handle.revision
      try {
        const page = await load({ signal: controller.signal })
        if (!controller.signal.aborted && handle.revision === revision) {
          nextCursor = page.nextCursor
          cursorRevision = revision + 1
          handle.set(page.node ?? null)
        }
      } catch (error) {
        if (!controller.signal.aborted && handle.revision === revision) throw error
      } finally {
        if (activeLoad === controller) activeLoad = undefined
        controller.abort()
      }
    }
    handle.loadMore = async (): Promise<boolean> => {
      const load = admittedDefinition.load
      if (load === undefined || handle.disposed || nextCursor === undefined || cursorRevision !== handle.revision) return false
      activeLoad?.abort()
      const controller = new AbortController()
      activeLoad = controller
      const revision = handle.revision
      try {
        const page = await load({ cursor: nextCursor, signal: controller.signal })
        if (controller.signal.aborted || handle.revision !== revision) return false
        nextCursor = page.nextCursor
        cursorRevision = revision + 1
        handle.set(page.node)
        return true
      } catch (error) {
        if (!controller.signal.aborted && handle.revision === revision) throw error
        return false
      } finally {
        if (activeLoad === controller) activeLoad = undefined
        controller.abort()
      }
    }
    publish(admittedNode, 0, { reason: 'replace', ...(admittedDefinition.source === undefined ? {} : { source: admittedDefinition.source }), ...(admittedDefinition.scope === undefined ? {} : { scope: admittedDefinition.scope }) })
    void handle.refresh().catch(error => { this.ctx.logger.warn(`pane "${id}" snapshot load failed`, error) })
    return handle
  }

  list(): readonly MayflyPaneEntry[] {
    return Object.freeze([...this.entries.values()].sort((left, right) =>
      (left.definition.priority ?? 0) - (right.definition.priority ?? 0) || left.id.localeCompare(right.id)))
  }
}

class OverlayHandle implements MayflyOverlayHandle {
  private live = true
  private revisionValue = 0
  private snapshotRevisionValue = 0
  private hiddenValue = false
  private focusRevisionValue = 0
  readonly events: UiEventEndpoint<MayflyUiNode>

  constructor(
    private readonly publish: (revision: number, hidden: boolean, focusRevision: number, node?: MayflyUiNode, update?: MayflySnapshotChange) => void,
    private readonly cleanup: (revision: number) => void,
    private node: MayflyUiNode,
    id: string,
    handler?: MayflyUiEventHandlers,
  ) {
    this.events = new UiEventEndpoint(id, handler, (node, update) => this.commit(node, update))
  }

  get disposed(): boolean { return !this.live }
  get closed(): boolean { return !this.live }
  get revision(): number { return this.revisionValue }
  get snapshotRevision(): number { return this.snapshotRevisionValue }

  set(node: MayflyUiNode, update?: MayflySnapshotUpdate): void {
    if (!this.live) return
    const frozen = freezeWire(node)
    const admittedUpdate = admitSnapshotUpdate(update)
    if (admittedUpdate.reason === 'replace') this.events.replace()
    this.commit(frozen, admittedUpdate)
  }

  private commit(node: MayflyUiNode, update: MayflySnapshotChange): void {
    this.node = node
    this.snapshotRevisionValue += 1
    this.revisionValue += 1
    this.publish(this.revisionValue, this.hiddenValue, this.focusRevisionValue, this.node, update)
  }

  focus(): void {
    if (!this.live) return
    this.focusRevisionValue += 1
    this.publish(this.revisionValue, this.hiddenValue, this.focusRevisionValue)
  }

  hide(): void { this.setHidden(true) }
  show(): void { this.setHidden(false) }
  close(): void { this.dispose() }

  dispose(): void {
    this.live = false
    this.events.dispose()
    this.revisionValue += 1
    this.cleanup(this.revisionValue)
  }

  private setHidden(hidden: boolean): void {
    if (!this.live || this.hiddenValue === hidden) return
    this.hiddenValue = hidden
    this.revisionValue += 1
    this.publish(this.revisionValue, hidden, this.focusRevisionValue)
  }
}

export class MayflyOverlayService extends ObservableRegistry<MayflyOverlayEntry> implements MayflyOverlayRegistry {
  private readonly entries = new Map<string, MayflyOverlayEntry>()
  private readonly handles = new Map<string, OverlayHandle>()
  private nextOrder = 0

  constructor(ctx: Context) { super(ctx, 'mayflyOverlays') }

  open(definition: MayflyOverlayDefinition, initialNode: MayflyUiNode): MayflyOverlayHandle {
    const admittedDefinition = freezeWire(definition)
    validateOverlayDefinition(admittedDefinition)
    const id = admittedDefinition.id
    if (this.entries.has(id)) throw new Error(`overlay "${id}" is already open`)
    let node = freezeWire(initialNode)
    let order = this.nextOrder++
    let focusedRevision = 0
    const metadata = snapshotMetadata(admittedDefinition)
    const publish = (revision: number, hidden: boolean, focusRevision: number, nextNode?: MayflyUiNode, update: MayflySnapshotChange = {}): void => {
      if (focusRevision > focusedRevision) order = this.nextOrder++
      focusedRevision = focusRevision
      node = nextNode ?? node
      const entry = Object.freeze({ id, definition: admittedDefinition, node, revision, order, hidden, focusRevision, ...metadata(update), update: freezeWire(update), events: handle.events.endpoint })
      this.entries.set(id, entry)
      this.upsert(entry)
    }
    let handle!: OverlayHandle
    const remove = (revision: number): void => {
      this.handles.delete(id)
      this.entries.delete(id)
      this.remove(id, revision)
    }
    handle = new OverlayHandle(publish, remove, node, id, admittedDefinition.onEvent)
    let activeLoad: AbortController | undefined
    this.handles.set(id, handle)
    const cleanup = this.ctx.effect(() => () => handle.dispose())
    const originalDispose = handle.dispose.bind(handle)
    handle.dispose = (): void => {
      if (handle.disposed) return
      activeLoad?.abort()
      originalDispose()
      cleanup()
    }
    const load = admittedDefinition.load
    publish(0, false, 0, node, { reason: 'replace', ...(admittedDefinition.source === undefined ? {} : { source: admittedDefinition.source }), ...(admittedDefinition.scope === undefined ? {} : { scope: admittedDefinition.scope }) })
    if (load !== undefined && !handle.disposed) {
      void (async () => {
        const controller = new AbortController()
        activeLoad = controller
        const revision = handle.snapshotRevision
        try {
          const page = await load({ signal: controller.signal })
          if (!controller.signal.aborted && handle.snapshotRevision === revision) handle.set(page.node)
        } catch (error) {
          if (!controller.signal.aborted && handle.snapshotRevision === revision) {
            this.ctx.logger.warn(`overlay "${id}" snapshot load failed`, error)
          }
        } finally {
          activeLoad = undefined
          controller.abort()
        }
      })()
    }
    return handle
  }

  close(id: string): boolean {
    const handle = this.handles.get(id)
    if (handle === undefined) return false
    handle.close()
    return true
  }

  focus(id: string): boolean {
    const handle = this.handles.get(id)
    if (handle === undefined) return false
    handle.focus()
    return true
  }

  list(): readonly MayflyOverlayEntry[] {
    return Object.freeze([...this.entries.values()].sort((left, right) => left.order - right.order))
  }
}

export class MayflyStatusService extends ObservableRegistry<MayflyStatusEntry> implements MayflyStatusRegistry {
  private readonly entries = new Map<string, MayflyStatusEntry>()

  constructor(ctx: Context) { super(ctx, 'mayflyStatus') }

  register(definition: MayflyStatusDefinition, initialNode: MayflyStatusNode | null = null): MayflyStatusRegistration {
    const admittedDefinition = freezeWire(definition)
    validateStatusDefinition(admittedDefinition)
    const id = admittedDefinition.id
    if (this.entries.has(id)) throw new Error(`status "${id}" is already registered`)
    const admittedNode = freezeWire(initialNode)
    const publish = (node: MayflyStatusNode | null, revision: number): void => {
      const entry = Object.freeze({ id, definition: admittedDefinition, node, revision })
      this.entries.set(id, entry)
      this.upsert(entry)
    }
    let handle!: SnapshotHandle<MayflyStatusNode | null>
    const remove = (revision: number): void => {
      this.entries.delete(id)
      this.remove(id, revision)
    }
    handle = new SnapshotHandle(publish, remove, id)
    const cleanup = this.ctx.effect(() => () => handle.dispose())
    const originalDispose = handle.dispose.bind(handle)
    handle.dispose = (): void => {
      if (handle.disposed) return
      originalDispose()
      cleanup()
    }
    publish(admittedNode, 0)
    return handle
  }

  list(): readonly MayflyStatusEntry[] {
    return Object.freeze([...this.entries.values()].sort((left, right) =>
      (left.definition.priority ?? 0) - (right.definition.priority ?? 0) || left.id.localeCompare(right.id)))
  }
}

export class MayflyEditorExtensionService extends ObservableRegistry<MayflyEditorExtensionEntry> implements MayflyEditorExtensionRegistry {
  private readonly entries = new Map<string, MayflyEditorExtensionEntry>()

  constructor(ctx: Context) { super(ctx, 'mayflyEditorExtensions') }

  register(definition: MayflyEditorExtensionDefinition, initialDecoration: MayflyEditorDecoration = {}): MayflyEditorExtensionRegistration {
    const admittedDefinition = freezeWire(definition)
    validateEditorExtensionDefinition(admittedDefinition)
    const id = admittedDefinition.id
    if (this.entries.has(id)) throw new Error(`editor extension "${id}" is already registered`)
    const admittedDecoration = freezeWire(initialDecoration)
    const metadata = snapshotMetadata(admittedDefinition)
    const publish = (decoration: MayflyEditorDecoration, revision: number, update: MayflySnapshotChange = {}): void => {
      const entry = Object.freeze({ id, definition: admittedDefinition, decoration, revision, ...metadata(update), update: freezeWire(update), events: handle.events.endpoint })
      this.entries.set(id, entry)
      this.upsert(entry)
    }
    let handle!: SnapshotHandle<MayflyEditorDecoration>
    const remove = (revision: number): void => {
      this.entries.delete(id)
      this.remove(id, revision)
    }
    handle = new SnapshotHandle(publish, remove, id, admittedDefinition.onEvent)
    const cleanup = this.ctx.effect(() => () => handle.dispose())
    const originalDispose = handle.dispose.bind(handle)
    handle.dispose = (): void => {
      if (handle.disposed) return
      originalDispose()
      cleanup()
    }
    publish(admittedDecoration, 0, { reason: 'replace', ...(admittedDefinition.source === undefined ? {} : { source: admittedDefinition.source }), ...(admittedDefinition.scope === undefined ? {} : { scope: admittedDefinition.scope }) })
    return handle
  }

  list(): readonly MayflyEditorExtensionEntry[] {
    return Object.freeze([...this.entries.values()].sort((left, right) =>
      (left.definition.priority ?? 0) - (right.definition.priority ?? 0) || left.id.localeCompare(right.id)))
  }
}
