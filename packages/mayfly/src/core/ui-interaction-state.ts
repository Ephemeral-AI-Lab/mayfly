/** Frontend-Fiber-owned surface instances and direct UI-registry subscriptions.
 * @module @ephemeral-ai/mayfly/core/ui-interaction-state
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { MayflyFeedbackRecord, MayflyOverlayEntry, MayflyPaneEntry } from '@ephemeral-ai/mayfly-ui'
import { UiSurfaceModel, type UiSurfaceBindings, type UiSurfaceSnapshot } from './ui-interaction-surface.ts'
import { UiNotificationOwner, UiNotificationStore } from './ui-interaction-notifications.ts'

export type UiSurfaceKind = 'pane' | 'overlay' | 'editor-panel'

declare module '@deepseek-ai/cordis' {
  interface Context { mayflyUiInteraction: UiInteractionService }
}

interface SurfaceRecord {
  readonly kind: UiSurfaceKind
  readonly model: UiSurfaceModel
  readonly unsubscribe: () => void
}

/** Registrations, not renderer objects, define the lifetime of an interaction. */
export class UiInteractionService extends Service {
  private live = true
  private serial = 0
  private notificationSerial = 0
  private readonly records = new Map<string, SurfaceRecord>()
  private readonly listeners = new Set<() => void>()
  private readonly notifications: UiNotificationStore

  constructor(ctx: Context) {
    super(ctx, 'mayflyUiInteraction')
    this.notifications = new UiNotificationStore(() => this.changed())
  }

  private key(kind: UiSurfaceKind, id: string): string { return JSON.stringify([kind, id]) }

  upsert(kind: UiSurfaceKind, snapshot: UiSurfaceSnapshot, bindings: UiSurfaceBindings = {}): UiSurfaceModel {
    if (!this.live) throw new Error('UI interaction owner is disposed')
    const key = this.key(kind, snapshot.id)
    const previous = this.records.get(key)
    if (previous?.model.endpoint === snapshot.events) {
      previous.model.receive(snapshot)
      return previous.model
    }
    this.remove(kind, snapshot.id)
    const model = new UiSurfaceModel(`${kind}/${++this.serial}`, snapshot, bindings)
    const unsubscribe = model.subscribe(() => this.changed())
    this.records.set(key, { kind, model, unsubscribe })
    this.changed()
    return model
  }

  get(kind: UiSurfaceKind, id: string): UiSurfaceModel | undefined { return this.records.get(this.key(kind, id))?.model }
  list(kind?: UiSurfaceKind): readonly UiSurfaceModel[] {
    return Object.freeze([...this.records.values()].filter(record => kind === undefined || record.kind === kind).map(record => record.model))
  }
  panes(): readonly MayflyPaneEntry[] { return this.list('pane').map(model => model.registration as MayflyPaneEntry) }
  overlays(): readonly MayflyOverlayEntry[] { return this.list('overlay').map(model => model.registration as MayflyOverlayEntry) }
  createNotificationOwner(label: string): UiNotificationOwner { return new UiNotificationOwner(`${label}/${++this.notificationSerial}`, this.notifications) }
  notificationSnapshot(): readonly MayflyFeedbackRecord[] { return this.notifications.snapshot() }
  setNotificationVisibility(visible: boolean): void { this.notifications.setVisible(visible) }
  handleNotification(id: string): void { this.notifications.handle(id) }

  remove(kind: UiSurfaceKind, id: string, expected?: UiSurfaceModel): void {
    const key = this.key(kind, id)
    const record = this.records.get(key)
    if (record === undefined || (expected !== undefined && record.model !== expected)) return
    record.unsubscribe()
    record.model.dispose()
    this.records.delete(key)
    this.changed()
  }

  subscribe(listener: () => void): () => void {
    if (!this.live) return () => {}
    this.listeners.add(listener)
    return this.ctx.effect(() => () => { this.listeners.delete(listener) })
  }

  private changed(): void {
    if (!this.live) return
    for (const listener of this.listeners) {
      try { listener() } catch (error) { this.ctx.logger.warn('UI interaction observer failed', error) }
    }
  }

  dispose(): void {
    if (!this.live) return
    this.live = false
    for (const record of this.records.values()) { record.unsubscribe(); record.model.dispose() }
    this.records.clear()
    this.notifications.dispose()
    this.listeners.clear()
  }
}

/** Each observer depends on only its own registry; provider gaps cannot reset siblings. */
export function mountUiRegistryObservers(ctx: Context): void {
  ctx.plugin({
    name: 'mayfly-pane-interaction-state',
    inject: ['mayflyPanes', 'mayflyUiInteraction'],
    apply(observer: Context) {
      const owned = new Map<string, UiSurfaceModel>()
      const upsert = (entry: MayflyPaneEntry): void => {
        const model = observer.mayflyUiInteraction.upsert('pane', entry)
        model.setVisible(entry.node !== null)
        owned.set(entry.id, model)
      }
      const off = observer.mayflyPanes.subscribe(delta => {
        if (delta.kind === 'upsert') upsert(delta.entry)
        else { observer.mayflyUiInteraction.remove('pane', delta.id, owned.get(delta.id)); owned.delete(delta.id) }
      })
      observer.effect(() => () => {
        off()
        for (const [id, model] of owned) observer.mayflyUiInteraction.remove('pane', id, model)
        owned.clear()
      })
    },
  })
  ctx.plugin({
    name: 'mayfly-overlay-interaction-state',
    inject: ['mayflyOverlays', 'mayflyUiInteraction'],
    apply(observer: Context) {
      const owned = new Map<string, UiSurfaceModel>()
      const upsert = (entry: MayflyOverlayEntry): void => {
        const model = observer.mayflyUiInteraction.upsert('overlay', entry, { close: () => observer.mayflyOverlays.close(entry.id) })
        model.setVisible(!entry.hidden)
        owned.set(entry.id, model)
      }
      const off = observer.mayflyOverlays.subscribe(delta => {
        if (delta.kind === 'upsert') upsert(delta.entry)
        else { observer.mayflyUiInteraction.remove('overlay', delta.id, owned.get(delta.id)); owned.delete(delta.id) }
      })
      observer.effect(() => () => {
        off()
        for (const [id, model] of owned) observer.mayflyUiInteraction.remove('overlay', id, model)
        owned.clear()
      })
    },
  })
}
