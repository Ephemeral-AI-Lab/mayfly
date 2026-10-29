/**
 * Multi-Host Client ownership and generation-safe Session selection.
 * @module @ephemeral-ai/mayfly/frontend/host-registry
 */
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { HostClient, HostKey, SessionRef } from '../client/types.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** Mayfly frontend selection and operation references. */
    mayflyFrontend: unknown
  }
}

/** Reference source used by Mayfly's official Session acquisitions. */
export const mayflySessionReferenceSource = 'mayflyFrontend'

/** Factory for one independent Host Client. */
export type HostAttachFactory = (key: HostKey) => HostClient | Promise<HostClient>

/** An operation addressed a Host that is not currently attached. */
export class HostNotAttachedError extends Error {
  override readonly name = 'HostNotAttachedError'

  /** @param host - missing Host identity. */
  constructor(readonly host: HostKey) {
    super(`Host "${host}" is not attached`)
  }
}

/** A newer operation or Host detach made an asynchronous result ineligible to commit. */
export class HostOperationSupersededError extends Error {
  override readonly name = 'HostOperationSupersededError'

  /** @param operation - superseded operation. @param host - affected Host identity. */
  constructor(readonly operation: 'attach' | 'select', readonly host: HostKey) {
    super(`Host ${operation} for "${host}" was superseded`)
  }
}

type AttachSettlement =
  | { readonly status: 'attached', readonly client: HostClient }
  | {
    readonly status: 'failed'
    readonly error: unknown
    readonly cleanup?: { readonly error: unknown }
  }

interface AttachRecord {
  readonly revision: number
  readonly promise: Promise<HostClient>
  readonly settled: Promise<AttachSettlement>
}

interface Selection {
  readonly ref: SessionRef
  readonly client: HostClient
  readonly reference: SessionReference
  readonly revision: number
}

/** UI-owned binding role; distinct roles never share registry.current. */
export type HostViewRole = string

/** Exact identity of one independent Transcript, BTW, subagent, or cold-history binding. */
export interface HostViewKey {
  readonly ref: SessionRef
  readonly role: HostViewRole
}

/** Reference-counted lease over one registry-owned view binding. */
export interface HostViewLease {
  readonly key: HostViewKey
  /** Borrowed official reference; call lease.release(), never reference.release(). */
  readonly reference: SessionReference
  readonly ready: Promise<SessionReference['binding']>
  release(): void
}

interface ViewRecord {
  readonly key: HostViewKey
  readonly reference: SessionReference
  leases: number
}

/** Stable map key for one exact Host/Session/view-role binding. */
export function hostViewKey(key: HostViewKey): string {
  return JSON.stringify([key.ref.host, key.ref.sessionId, key.role])
}

/** Owns attached Host Clients, the primary selection, and independent view-role bindings. */
export class HostRegistry {
  private readonly clients = new Map<HostKey, HostClient>()
  private readonly attaching = new Map<HostKey, AttachRecord>()
  private readonly detaching = new Map<HostKey, Promise<void>>()
  private readonly revisions = new Map<HostKey, number>()
  private readonly pendingSelections = new Map<HostKey, Set<SessionReference>>()
  private readonly views = new Map<string, ViewRecord>()
  private selection: Selection | undefined
  private selectionGeneration = 0
  private selectionTail: Promise<void> = Promise.resolve()

  /** @param attachFactory - factory used for new Host generations; never called for an attached or in-flight key. */
  constructor(private readonly attachFactory: HostAttachFactory) {}

  /** Current committed selection, absent before selection and after its Host detaches. */
  get current(): SessionRef | undefined {
    return this.selection?.ref
  }

  /** Borrowed current reference owned by this registry; acquire a view lease for independent panels. */
  get currentReference(): SessionReference | undefined {
    return this.selection?.reference
  }

  /** List committed Host Clients in attach order. */
  list(): readonly HostClient[] {
    return [...this.clients.values()]
  }

  /** Find one attached Host Client, or undefined while absent or attaching. */
  get(key: HostKey): HostClient | undefined {
    return this.clients.get(key)
  }

  /** Attach one shared Host generation and release stale or mismatched Clients. */
  attach(key: HostKey): Promise<HostClient> {
    const attached = this.clients.get(key)
    if (attached !== undefined) return Promise.resolve(attached)
    const pending = this.attaching.get(key)
    if (pending !== undefined) return pending.promise

    const revision = this.bumpRevision(key)
    let produced: Promise<HostClient>
    try {
      produced = Promise.resolve(this.attachFactory(key))
    } catch (error) {
      produced = Promise.reject(error)
    }

    const settled: Promise<AttachSettlement> = produced.then(
      async client => {
        if (client.key !== key) {
          const error = new Error(`Host factory for "${key}" returned Client "${client.key}"`)
          const cleanup = await releaseRejectedClient(client)
          return { status: 'failed', error, ...cleanup }
        }
        if (this.revisionOf(key) !== revision) {
          const error = new HostOperationSupersededError('attach', key)
          const cleanup = await releaseRejectedClient(client)
          return { status: 'failed', error, ...cleanup }
        }
        this.clients.set(key, client)
        return { status: 'attached', client }
      },
      (error: unknown) => ({ status: 'failed', error }),
    )
    const promise = settled.then(settlement => {
      if (settlement.status === 'attached') return settlement.client
      if (settlement.cleanup !== undefined) {
        throw new AggregateError(
          [settlement.error, settlement.cleanup.error],
          `Host attach for "${key}" failed and Client cleanup also failed`,
        )
      }
      throw settlement.error
    })
    const record: AttachRecord = { revision, promise, settled }
    this.attaching.set(key, record)
    void settled.then(() => {
      if (this.attaching.get(key) === record) this.attaching.delete(key)
    })
    return promise
  }

  /** Select the primary Host/Session pair in serialized, stale-fenced call order. */
  select(ref: SessionRef, signal?: AbortSignal): Promise<SessionRef> {
    const generation = ++this.selectionGeneration
    const client = this.clients.get(ref.host)
    if (client === undefined) return Promise.reject(new HostNotAttachedError(ref.host))
    const revision = this.revisionOf(ref.host)
    if (this.selection?.ref.host === ref.host
      && this.selection.ref.sessionId === ref.sessionId
      && this.selection.client === client
      && this.selection.revision === revision) return Promise.resolve(this.selection.ref)

    const operation = this.selectionTail.then(() => this.acquireSelection(ref, client, revision, generation, signal))
    this.selectionTail = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async acquireSelection(
    ref: SessionRef,
    client: HostClient,
    revision: number,
    generation: number,
    signal: AbortSignal | undefined,
  ): Promise<SessionRef> {
    if (generation !== this.selectionGeneration
      || revision !== this.revisionOf(ref.host)
      || this.clients.get(ref.host) !== client) {
      throw new HostOperationSupersededError('select', ref.host)
    }
    const reference = client.sessions.retain(ref.sessionId, {
      source: mayflySessionReferenceSource,
      signal,
    })
    let references = this.pendingSelections.get(ref.host)
    if (references === undefined) {
      references = new Set()
      this.pendingSelections.set(ref.host, references)
    }
    references.add(reference)
    try {
      return await this.commitSelection(ref, client, reference, revision, generation)
    } finally {
      references.delete(reference)
      if (references.size === 0 && this.pendingSelections.get(ref.host) === references) {
        this.pendingSelections.delete(ref.host)
      }
    }
  }

  /** Retain one independent official binding for a UI role, refcounted per exact key. */
  retainView(ref: SessionRef, role: HostViewRole): HostViewLease {
    if (role.trim() === '') throw new Error('Host view role must not be empty')
    const client = this.clients.get(ref.host)
    if (client === undefined) throw new HostNotAttachedError(ref.host)
    const key: HostViewKey = {
      ref: Object.freeze({ host: ref.host, sessionId: ref.sessionId }),
      role,
    }
    const identity = hostViewKey(key)
    let record = this.views.get(identity)
    if (record === undefined) {
      const reference = client.sessions.retain(ref.sessionId, { source: mayflySessionReferenceSource })
      record = { key, reference, leases: 0 }
      this.views.set(identity, record)
    }
    record.leases += 1
    const retained = record
    let released = false
    return Object.freeze({
      key: retained.key,
      reference: retained.reference,
      ready: retained.reference.ready,
      release: () => {
        if (released || this.views.get(identity) !== retained) return
        released = true
        retained.leases -= 1
        if (retained.leases > 0) return
        this.views.delete(identity)
        retained.reference.release()
      },
    })
  }

  /** List all currently retained view identities, including cold and background panels. */
  viewKeys(): readonly HostViewKey[] {
    return [...this.views.values()].map(record => record.key)
  }

  /** Force-close one view binding and invalidate its outstanding leases. */
  closeView(key: HostViewKey): void {
    const identity = hostViewKey(key)
    const record = this.views.get(identity)
    if (record === undefined) return
    this.views.delete(identity)
    record.reference.release()
  }

  /** Withdraw one Host and release only its selected, pending, and view generations. */
  detach(key: HostKey): Promise<void> {
    this.bumpRevision(key)
    const client = this.clients.get(key)
    if (client !== undefined) this.clients.delete(key)
    const attaching = this.attaching.get(key)
    if (attaching !== undefined) this.attaching.delete(key)
    if (this.selection?.ref.host === key) {
      const selected = this.selection
      this.selection = undefined
      selected.reference.release()
    }
    const selecting = this.pendingSelections.get(key)
    if (selecting !== undefined) {
      this.pendingSelections.delete(key)
      for (const reference of selecting) reference.release()
    }
    for (const [identity, record] of [...this.views]) {
      if (record.key.ref.host !== key) continue
      this.views.delete(identity)
      record.reference.release()
    }

    const cleanups: Promise<void>[] = []
    const previous = this.detaching.get(key)
    if (previous !== undefined) cleanups.push(previous)
    if (client !== undefined) cleanups.push(Promise.resolve().then(() => client.detach()))
    if (attaching !== undefined) {
      cleanups.push(attaching.settled.then(settlement => {
        if (settlement.status === 'failed' && settlement.cleanup !== undefined) throw settlement.cleanup.error
      }))
    }
    const operation = settleCleanups(key, cleanups)
    this.detaching.set(key, operation)
    void operation.then(
      () => { if (this.detaching.get(key) === operation) this.detaching.delete(key) },
      () => { if (this.detaching.get(key) === operation) this.detaching.delete(key) },
    )
    return operation
  }

  private revisionOf(key: HostKey): number {
    return this.revisions.get(key) ?? 0
  }

  private bumpRevision(key: HostKey): number {
    const revision = this.revisionOf(key) + 1
    this.revisions.set(key, revision)
    return revision
  }

  private async commitSelection(
    ref: SessionRef,
    client: HostClient,
    reference: SessionReference,
    revision: number,
    generation: number,
  ): Promise<SessionRef> {
    try {
      await reference.ready
    } catch (error) {
      reference.release()
      throw error
    }
    if (generation !== this.selectionGeneration
      || revision !== this.revisionOf(ref.host)
      || this.clients.get(ref.host) !== client) {
      reference.release()
      throw new HostOperationSupersededError('select', ref.host)
    }
    const selected = Object.freeze({ host: ref.host, sessionId: ref.sessionId })
    const previous = this.selection
    this.selection = { ref: selected, client, reference, revision }
    previous?.reference.release()
    return selected
  }
}

async function releaseRejectedClient(client: HostClient): Promise<Pick<AttachSettlement & { status: 'failed' }, 'cleanup'>> {
  try {
    await client.detach()
    return {}
  } catch (error) {
    return { cleanup: { error } }
  }
}

async function settleCleanups(key: HostKey, cleanups: readonly Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(cleanups)
  const errors: unknown[] = []
  for (const result of results) if (result.status === 'rejected') errors.push(result.reason)
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, `Multiple cleanups failed while detaching Host "${key}"`)
}
