/** Owned notification records shared by surfaces and the prompt feedback lane.
 * @module @ephemeral-ai/mayfly/core/ui-interaction-notifications
 */
import { freezeWire, type MayflyFeedback, type MayflyFeedbackRecord, type MayflyUiScope } from '@ephemeral-ai/mayfly-ui'
import { validateMayflyUiNode } from './ui-validator.ts'

const SHORT_VISIBLE_MS = 5_000

export interface UiNotificationIdentity {
  readonly owner: string
  readonly scope: MayflyUiScope
  readonly operationId?: string
}

export function admitNotificationMessage(value: unknown): string {
  const result = validateMayflyUiNode({ kind: 'text', content: value })
  if (!result.ok) throw new TypeError('UI feedback must be bounded text')
  return (result.value as { readonly content: string }).content
}

/** Timer-owning record store; time advances only while its presentation is visible. */
export class UiNotificationStore {
  private readonly records = new Map<string, MayflyFeedbackRecord>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly accruedAt = new Map<string, number>()
  private visible = true
  private visibleSince = Date.now()
  private live = true

  constructor(private readonly changed: () => void) {}

  snapshot(): readonly MayflyFeedbackRecord[] {
    const now = Date.now()
    return freezeWire([...this.records.values()].map(record => ({
      ...record,
      visibleMs: record.visibleMs + (this.visible ? Math.max(0, now - this.accruedFrom(record)) : 0),
    })))
  }

  get(id: string): MayflyFeedbackRecord | undefined { return this.records.get(id) }

  report(id: string, identity: UiNotificationIdentity, feedback: MayflyFeedback): void {
    if (!this.live) return
    try {
      const previous = this.records.get(id)
      const now = Date.now()
      const settlesProgress = previous?.purpose === 'progress' && feedback.purpose !== 'progress'
      const visibleMs = previous === undefined || settlesProgress ? 0
        : previous.visibleMs + (this.visible ? Math.max(0, now - this.accruedFrom(previous)) : 0)
      const record = freezeWire({
        ...feedback,
        id,
        ...identity,
        state: 'active' as const,
        createdAt: previous === undefined || settlesProgress ? now : previous.createdAt,
        visibleMs,
        message: admitNotificationMessage(feedback.message),
        ...(feedback.detail === undefined ? {} : { detail: admitNotificationMessage(feedback.detail) }),
      })
      this.records.set(id, record)
      this.accruedAt.set(id, now)
      this.cancelTimer(id)
      this.schedule(id, record)
    } catch {
      this.records.set(id, Object.freeze({
        id,
        owner: identity.owner,
        scope: identity.scope,
        ...(identity.operationId === undefined ? {} : { operationId: identity.operationId }),
        state: 'active',
        createdAt: Date.now(),
        visibleMs: 0,
        message: 'The operation returned invalid feedback',
        severity: 'error',
      }))
    }
    this.trim()
    this.changed()
  }

  clear(id: string, notify = true): void {
    this.cancelTimer(id)
    this.accruedAt.delete(id)
    if (this.records.delete(id) && notify) this.changed()
  }

  clearOwner(owner: string): void {
    let changed = false
    for (const [id, record] of this.records) if (record.owner === owner) {
      this.cancelTimer(id)
      this.accruedAt.delete(id)
      this.records.delete(id)
      changed = true
    }
    if (changed) this.changed()
  }

  handle(id: string): void {
    const record = this.records.get(id)
    if (record === undefined || record.state === 'handled') return
    this.cancelTimer(id)
    this.records.set(id, freezeWire({ ...record, state: 'handled' as const }))
    this.changed()
  }

  setVisible(visible: boolean): void {
    if (!this.live || this.visible === visible) return
    const now = Date.now()
    if (!visible) {
      for (const [id, record] of this.records) {
        this.records.set(id, freezeWire({ ...record, visibleMs: record.visibleMs + Math.max(0, now - this.accruedFrom(record)) }))
        this.accruedAt.set(id, now)
        this.cancelTimer(id)
      }
      this.visible = false
    } else {
      this.visibleSince = now
      this.visible = true
      for (const [id, record] of this.records) this.schedule(id, record)
    }
    this.changed()
  }

  dispose(): void {
    if (!this.live) return
    this.live = false
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.records.clear()
  }

  private cancelTimer(id: string): void {
    const timer = this.timers.get(id)
    if (timer !== undefined) clearTimeout(timer)
    this.timers.delete(id)
  }

  /** Time up to which this record's visible interval is already banked. */
  private accruedFrom(record: MayflyFeedbackRecord): number {
    return Math.max(this.accruedAt.get(record.id) ?? record.createdAt, this.visibleSince)
  }

  private schedule(id: string, record: MayflyFeedbackRecord): void {
    if (!this.visible || record.purpose === 'progress' || (record.severity !== 'success' && record.severity !== 'info')) return
    const remaining = Math.max(0, SHORT_VISIBLE_MS - record.visibleMs)
    this.timers.set(id, setTimeout(() => {
      if (this.records.get(id) === record) this.clear(id)
    }, remaining))
  }

  private trim(): void {
    if (this.records.size <= 64) return
    const removable = [...this.records.values()]
      .filter(record => record.state === 'handled' || (record.purpose !== 'progress' && record.severity !== 'warning' && record.severity !== 'error'))
      .toSorted((left, right) => left.createdAt - right.createdAt)
    for (const record of removable) {
      if (this.records.size <= 64) break
      this.clear(record.id, false)
    }
  }
}

/** A producer-scoped handle whose disposal removes only its own records. */
export class UiNotificationOwner {
  private live = true

  constructor(readonly id: string, private readonly store: UiNotificationStore) {}

  report(id: string, scope: MayflyUiScope, feedback: MayflyFeedback, operationId?: string): void {
    if (!this.live) return
    this.store.report(`${this.id}/${id}`, { owner: this.id, scope, ...(operationId === undefined ? {} : { operationId }) }, feedback)
  }

  clear(id: string): void { this.store.clear(`${this.id}/${id}`) }
  clearAll(): void { if (this.live) this.store.clearOwner(this.id) }
  handle(id: string): void { this.store.handle(`${this.id}/${id}`) }
  dispose(): void { if (this.live) { this.live = false; this.store.clearOwner(this.id) } }
}
