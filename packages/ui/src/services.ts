/** Direct Fiber-owned snapshot registries for Mayfly UI contributions.
 * @module @ephemeral-ai/mayfly-ui/services
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-include'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { freezeWire } from './builders.ts'
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
} from './contracts.ts'

const ID = /^[a-z0-9][a-z0-9._/-]*$/u

function assertId(id: string, kind: string): void {
  if (!ID.test(id)) throw new TypeError(`${kind} id "${id}" is invalid`)
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

class SnapshotHandle<Node> {
  private live = true
  private revisionValue = 0

  constructor(
    private readonly publish: (node: Node, revision: number, update?: MayflySnapshotUpdate) => void,
    private readonly cleanup: (revision: number) => void,
  ) {}

  get disposed(): boolean { return !this.live }
  get revision(): number { return this.revisionValue }

  set(node: Node, update?: MayflySnapshotUpdate): void {
    if (!this.live) return
    const frozen = freezeWire(node)
    this.revisionValue += 1
    this.publish(frozen, this.revisionValue, update)
  }

  dispose(): void {
    this.live = false
    this.revisionValue += 1
    this.cleanup(this.revisionValue)
  }
}

export class MayflyPaneService extends ObservableRegistry<MayflyPaneEntry> implements MayflyPaneRegistry {
  private readonly entries = new Map<string, MayflyPaneEntry>()

  constructor(ctx: Context) { super(ctx, 'mayflyPanes') }

  register(definition: MayflyPaneDefinition, initialNode: MayflyUiNode | null = null): MayflyPaneRegistration {
    assertId(definition.id, 'pane')
    if (this.entries.has(definition.id)) throw new Error(`pane "${definition.id}" is already registered`)
    const admittedDefinition = freezeWire(definition)
    const publish = (node: MayflyUiNode | null, revision: number, update?: MayflySnapshotUpdate): void => {
      const entry = Object.freeze({ id: definition.id, definition: admittedDefinition, node, revision, ...(update?.eventRevision === undefined ? {} : { eventRevision: update.eventRevision }) })
      this.entries.set(definition.id, entry)
      this.upsert(entry)
    }
    let handle!: SnapshotHandle<MayflyUiNode | null>
    const remove = (revision: number): void => {
      this.entries.delete(definition.id)
      this.remove(definition.id, revision)
    }
    handle = new SnapshotHandle(publish, remove)
    const cleanup = this.ctx.effect(() => () => handle.dispose())
    const originalDispose = handle.dispose.bind(handle)
    handle.dispose = (): void => {
      if (handle.disposed) return
      originalDispose()
      cleanup()
    }
    publish(freezeWire(initialNode), 0)
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
  private hiddenValue = false
  private focusRevisionValue = 0

  constructor(
    private readonly publish: (revision: number, hidden: boolean, focusRevision: number, node?: MayflyUiNode, update?: MayflySnapshotUpdate) => void,
    private readonly cleanup: (revision: number) => void,
    private node: MayflyUiNode,
  ) {}

  get disposed(): boolean { return !this.live }
  get closed(): boolean { return !this.live }
  get revision(): number { return this.revisionValue }

  set(node: MayflyUiNode, update?: MayflySnapshotUpdate): void {
    if (!this.live) return
    this.node = freezeWire(node)
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
    assertId(definition.id, 'overlay')
    if (this.entries.has(definition.id)) throw new Error(`overlay "${definition.id}" is already open`)
    const admittedDefinition = freezeWire(definition)
    let node = freezeWire(initialNode)
    const order = this.nextOrder++
    const publish = (revision: number, hidden: boolean, focusRevision: number, nextNode?: MayflyUiNode, update?: MayflySnapshotUpdate): void => {
      node = nextNode ?? node
      const entry = Object.freeze({ id: definition.id, definition: admittedDefinition, node, revision, order, hidden, focusRevision, ...(update?.eventRevision === undefined ? {} : { eventRevision: update.eventRevision }) })
      this.entries.set(definition.id, entry)
      this.upsert(entry)
    }
    let handle!: OverlayHandle
    const remove = (revision: number): void => {
      this.handles.delete(definition.id)
      this.entries.delete(definition.id)
      this.remove(definition.id, revision)
    }
    handle = new OverlayHandle(publish, remove, node)
    this.handles.set(definition.id, handle)
    const cleanup = this.ctx.effect(() => () => handle.dispose())
    const originalDispose = handle.dispose.bind(handle)
    handle.dispose = (): void => {
      if (handle.disposed) return
      originalDispose()
      cleanup()
    }
    publish(0, false, 0)
    return handle
  }

  close(id: string): boolean {
    const handle = this.handles.get(id)
    if (handle === undefined) return false
    handle.close()
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
    assertId(definition.id, 'status')
    if (this.entries.has(definition.id)) throw new Error(`status "${definition.id}" is already registered`)
    const admittedDefinition = freezeWire(definition)
    const publish = (node: MayflyStatusNode | null, revision: number): void => {
      const entry = Object.freeze({ id: definition.id, definition: admittedDefinition, node, revision })
      this.entries.set(definition.id, entry)
      this.upsert(entry)
    }
    let handle!: SnapshotHandle<MayflyStatusNode | null>
    const remove = (revision: number): void => {
      this.entries.delete(definition.id)
      this.remove(definition.id, revision)
    }
    handle = new SnapshotHandle(publish, remove)
    const cleanup = this.ctx.effect(() => () => handle.dispose())
    const originalDispose = handle.dispose.bind(handle)
    handle.dispose = (): void => {
      if (handle.disposed) return
      originalDispose()
      cleanup()
    }
    publish(freezeWire(initialNode), 0)
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
    assertId(definition.id, 'editor extension')
    if (this.entries.has(definition.id)) throw new Error(`editor extension "${definition.id}" is already registered`)
    const admittedDefinition = freezeWire(definition)
    const publish = (decoration: MayflyEditorDecoration, revision: number, update?: MayflySnapshotUpdate): void => {
      const entry = Object.freeze({ id: definition.id, definition: admittedDefinition, decoration, revision, ...(update?.eventRevision === undefined ? {} : { eventRevision: update.eventRevision }) })
      this.entries.set(definition.id, entry)
      this.upsert(entry)
    }
    let handle!: SnapshotHandle<MayflyEditorDecoration>
    const remove = (revision: number): void => {
      this.entries.delete(definition.id)
      this.remove(definition.id, revision)
    }
    handle = new SnapshotHandle(publish, remove)
    const cleanup = this.ctx.effect(() => () => handle.dispose())
    const originalDispose = handle.dispose.bind(handle)
    handle.dispose = (): void => {
      if (handle.disposed) return
      originalDispose()
      cleanup()
    }
    publish(freezeWire(initialDecoration), 0)
    return handle
  }

  list(): readonly MayflyEditorExtensionEntry[] {
    return Object.freeze([...this.entries.values()].sort((left, right) =>
      (left.definition.priority ?? 0) - (right.definition.priority ?? 0) || left.id.localeCompare(right.id)))
  }
}
