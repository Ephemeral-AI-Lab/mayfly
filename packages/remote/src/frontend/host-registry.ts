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

  /**
   * @param operation - superseded operation.
   * @param host - affected Host identity.
   */
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

/** Owns attached Host Clients and one retained current Session selection per registry. */
export class HostRegistry {
  private readonly clients = new Map<HostKey, HostClient>()
  private readonly attaching = new Map<HostKey, AttachRecord>()
  private readonly detaching = new Map<HostKey, Promise<void>>()
  private readonly revisions = new Map<HostKey, number>()
  private readonly pendingSelections = new Map<HostKey, Set<SessionReference>>()
  private selection: Selection | undefined
  private selectionGeneration = 0

  /** @param attachFactory - factory used for new Host generations; never called for an attached or in-flight key. */
  constructor(private readonly attachFactory: HostAttachFactory) {}

  /** Current committed selection, absent before selection and after its Host detaches. */
  get current(): SessionRef | undefined {
    return this.selection?.ref
  }

  /**
   * Borrowed current reference owned by this registry. Consumers must not release it;
   * acquire an independent reference for work that outlives the selection.
   */
  get currentReference(): SessionReference | undefined {
    return this.selection?.reference
  }

  /**
   * List committed Host Clients in attach order. Pending and detached generations are absent.
   * @returns a new readonly snapshot of attached Clients.
   */
  list(): readonly HostClient[] {
    return [...this.clients.values()]
  }

  /**
   * Find one attached Host Client.
   * @param key - Host identity.
   * @returns the committed Client, or undefined while absent or attaching.
   */
  get(key: HostKey): HostClient | undefined {
    return this.clients.get(key)
  }

  /**
   * Attach one Host generation. Concurrent calls for a key share one factory call;
   * a failed generation can be retried. Detaching invalidates the pending generation,
   * whose eventual Client is released instead of committed.
   * @param key - Host identity to attach.
   * @returns the committed Client, or a rejection when attachment or stale cleanup fails.
   */
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

  /**
   * Select and retain an exact Host/Session pair. The previous selection remains
   * committed until the new reference is ready. Only the newest selection on the
   * same Host revision may commit; stale and failed acquisitions release themselves.
   * @param ref - Host-namespaced Session identity.
   * @param signal - optional cancellation of this acquisition wait, not Agent cancellation.
   * @returns the committed immutable selection.
   */
  select(ref: SessionRef, signal?: AbortSignal): Promise<SessionRef> {
    const generation = ++this.selectionGeneration
    const client = this.clients.get(ref.host)
    if (client === undefined) return Promise.reject(new HostNotAttachedError(ref.host))
    const revision = this.revisionOf(ref.host)
    if (this.selection?.ref.host === ref.host
      && this.selection.ref.sessionId === ref.sessionId
      && this.selection.client === client
      && this.selection.revision === revision) return Promise.resolve(this.selection.ref)

    let reference: SessionReference
    try {
      reference = client.sessions.retain(ref.sessionId, {
        source: mayflySessionReferenceSource,
        signal,
      })
    } catch (error) {
      return Promise.reject(error)
    }
    let references = this.pendingSelections.get(ref.host)
    if (references === undefined) {
      references = new Set()
      this.pendingSelections.set(ref.host, references)
    }
    references.add(reference)
    return this.commitSelection(ref, client, reference, revision, generation).finally(() => {
      references.delete(reference)
      if (references.size === 0 && this.pendingSelections.get(ref.host) === references) {
        this.pendingSelections.delete(ref.host)
      }
    })
  }

  /**
   * Withdraw one Host synchronously, then release only its selected/pending references
   * and Client generations. A later attach or select on the same key is independent;
   * completion of this detach cannot clear or release that newer generation.
   * @param key - Host identity to detach.
   * @returns after captured cleanups settle; cleanup failures reject after all cleanups finish.
   */
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
