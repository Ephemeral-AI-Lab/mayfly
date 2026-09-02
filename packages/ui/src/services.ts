/** Direct Fiber-owned Mayfly UI registries.
 * @module @ephemeral-ai/mayfly-ui/services
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-include'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {
  MayflyEditorExtensionContribution,
  MayflyEditorExtensionRegistry,
  MayflyOverlayEntry,
  MayflyOverlayHandle,
  MayflyOverlayRegistry,
  MayflyOverlayRequest,
  MayflyPaneContribution,
  MayflyPaneEntry,
  MayflyPaneRegistration,
  MayflyPaneRegistry,
  MayflyRefreshRegistration,
  MayflyStatusEntry,
  MayflyStatusRegistry,
  MayflyStatusSource,
} from './contracts.ts'

const ID = /^[a-z0-9][a-z0-9._/-]*$/u

function assertId(id: string, kind: string): void {
  if (!ID.test(id)) throw new TypeError(`${kind} id "${id}" is invalid`)
}

class RefreshHandle implements MayflyRefreshRegistration {
  private live = true
  constructor(private readonly cleanup: () => void, private readonly onRefresh: () => void) {}
  get disposed(): boolean { return !this.live }
  refresh(): void { if (this.live) this.onRefresh() }
  dispose(): void {
    if (!this.live) return
    this.live = false
    this.cleanup()
  }
}

class OverlayHandle extends RefreshHandle implements MayflyOverlayHandle {
  get closed(): boolean { return this.disposed }
  close(): void { this.dispose() }
}

abstract class ObservableRegistry<T> extends Service {
  protected readonly listeners = new Set<(entries: readonly T[]) => void>()
  abstract list(): readonly T[]
  subscribe(listener: (entries: readonly T[]) => void): () => void {
    this.listeners.add(listener)
    listener(this.list())
    return this.ctx.effect(() => () => { this.listeners.delete(listener) })
  }
  protected emit(): void {
    const snapshot = this.list()
    for (const listener of this.listeners) listener(snapshot)
  }
}

export class MayflyPaneService extends ObservableRegistry<MayflyPaneEntry> implements MayflyPaneRegistry {
  private readonly entries = new Map<string, MayflyPaneEntry>()
  constructor(ctx: Context) { super(ctx, 'mayflyPanes') }
  register(contribution: MayflyPaneContribution): MayflyPaneRegistration {
    assertId(contribution.id, 'pane')
    if (typeof contribution.render !== 'function') throw new TypeError(`pane "${contribution.id}" needs a render function`)
    if (this.entries.has(contribution.id)) throw new Error(`pane "${contribution.id}" is already registered`)
    let revision = 0
    let hidden = false
    const frozen = Object.freeze({ ...contribution })
    const publish = (): void => {
      this.entries.set(contribution.id, Object.freeze({ id: contribution.id, contribution: frozen, hidden, revision }))
      this.emit()
    }
    publish()
    const cleanup = this.ctx.effect(() => () => {
      /* v8 ignore else -- Cordis runs and unregisters each effect disposer once. */
      if (this.entries.delete(contribution.id)) this.emit()
    })
    const base = new RefreshHandle(cleanup, () => { revision += 1; publish() })
    return Object.assign(base, {
      setHidden: (value: boolean): void => {
        if (base.disposed || hidden === value) return
        hidden = value
        revision += 1
        publish()
      },
    })
  }
  list(): readonly MayflyPaneEntry[] { return Object.freeze([...this.entries.values()]) }
}

export class MayflyOverlayService extends ObservableRegistry<MayflyOverlayEntry> implements MayflyOverlayRegistry {
  private readonly entries = new Map<string, MayflyOverlayEntry>()
  private readonly handles = new Map<string, RefreshHandle>()
  private nextOrder = 0
  constructor(ctx: Context) { super(ctx, 'mayflyOverlays') }
  open(request: MayflyOverlayRequest): MayflyOverlayHandle {
    assertId(request.id, 'overlay')
    if (typeof request.render !== 'function') throw new TypeError(`overlay "${request.id}" needs a render function`)
    if (this.entries.has(request.id)) throw new Error(`overlay "${request.id}" is already open`)
    let revision = 0
    const order = this.nextOrder++
    const frozen = Object.freeze({ ...request })
    const publish = (): void => {
      this.entries.set(request.id, Object.freeze({ id: request.id, request: frozen, revision, order }))
      this.emit()
    }
    publish()
    const cleanup = this.ctx.effect(() => () => {
      this.handles.delete(request.id)
      /* v8 ignore else -- Cordis runs and unregisters each effect disposer once. */
      if (this.entries.delete(request.id)) this.emit()
    })
    const handle = new OverlayHandle(cleanup, () => { revision += 1; publish() })
    this.handles.set(request.id, handle)
    return handle
  }
  close(id: string): boolean {
    const handle = this.handles.get(id)
    if (handle === undefined) return false
    handle.dispose()
    return true
  }
  list(): readonly MayflyOverlayEntry[] { return Object.freeze([...this.entries.values()].sort((left, right) => left.order - right.order)) }
}

interface StatusRecord { readonly source: MayflyStatusSource, readonly fallback: MayflyStatusEntry }
function statusValue(source: MayflyStatusSource): MayflyStatusEntry | null { return typeof source === 'function' ? source() : source }

export class MayflyStatusService extends Service implements MayflyStatusRegistry {
  private readonly entries = new Map<string, StatusRecord>()
  private readonly listeners = new Set<() => void>()
  constructor(ctx: Context) { super(ctx, 'mayflyStatus') }
  register(source: MayflyStatusSource): MayflyRefreshRegistration {
    const initial = statusValue(source)
    if (initial === null) throw new TypeError('a status source must return an initial entry')
    assertId(initial.id, 'status')
    if (this.entries.has(initial.id)) throw new Error(`status "${initial.id}" is already registered`)
    this.entries.set(initial.id, { source, fallback: initial })
    this.emit()
    const cleanup = this.ctx.effect(() => () => {
      /* v8 ignore else -- Cordis runs and unregisters each effect disposer once. */
      if (this.entries.delete(initial.id)) this.emit()
    })
    return new RefreshHandle(cleanup, () => this.refresh(initial.id))
  }
  refresh(id: string): void { if (this.entries.has(id)) this.emit() }
  list(): readonly MayflyStatusEntry[] {
    return Object.freeze([...this.entries.values()].flatMap(record => {
      try {
        const value = statusValue(record.source)
        return value === null ? [] : [value]
      } catch {
        return [{ ...record.fallback, visible: true, node: { kind: 'text' as const, content: `Status ${record.fallback.id} failed`, tone: 'danger' as const } }]
      }
    }).sort((left, right) => (left.priority ?? 0) - (right.priority ?? 0) || left.id.localeCompare(right.id)))
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    listener()
    return this.ctx.effect(() => () => { this.listeners.delete(listener) })
  }
  private emit(): void { for (const listener of this.listeners) listener() }
}

export class MayflyEditorExtensionService extends Service implements MayflyEditorExtensionRegistry {
  private readonly entries = new Map<string, MayflyEditorExtensionContribution>()
  private readonly listeners = new Set<(entries: readonly MayflyEditorExtensionContribution[], revision: number) => void>()
  private revision = 0
  constructor(ctx: Context) { super(ctx, 'mayflyEditorExtensions') }
  register(contribution: MayflyEditorExtensionContribution): MayflyRefreshRegistration {
    assertId(contribution.id, 'editor extension')
    if (this.entries.has(contribution.id)) throw new Error(`editor extension "${contribution.id}" is already registered`)
    this.entries.set(contribution.id, Object.freeze({ ...contribution }))
    this.emit()
    const cleanup = this.ctx.effect(() => () => {
      /* v8 ignore else -- Cordis runs and unregisters each effect disposer once. */
      if (this.entries.delete(contribution.id)) this.emit()
    })
    return new RefreshHandle(cleanup, () => this.emit())
  }
  list(): readonly MayflyEditorExtensionContribution[] {
    return Object.freeze([...this.entries.values()].sort((left, right) => (left.priority ?? 0) - (right.priority ?? 0) || left.id.localeCompare(right.id)))
  }
  subscribe(listener: (entries: readonly MayflyEditorExtensionContribution[], revision: number) => void): () => void {
    this.listeners.add(listener)
    listener(this.list(), this.revision)
    return this.ctx.effect(() => () => { this.listeners.delete(listener) })
  }
  private emit(): void {
    this.revision += 1
    const entries = this.list()
    for (const listener of this.listeners) listener(entries, this.revision)
  }
}
