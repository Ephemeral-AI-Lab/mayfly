/**
 * Official Client declarations, results, and exact-generation operation scopes.
 * @module @ephemeral-ai/mayfly/remote/features/official
 */

import type {} from '@deepseek-ai/dsh-goal/remote'
import type {} from '@deepseek-ai/dsh-schedule/remote'
import type {} from '@deepseek-ai/dsh-api-job-controller/remote'
import type {} from '../../client/remote-face.ts'

export type {
  JobFollowFrame,
  JobFollowRequest,
  JobKillValue,
  JobListFrame,
  JobView,
} from '@deepseek-ai/dsh-api-job-controller/types'
export type { GoalView } from '@deepseek-ai/dsh-goal/client'
export type { ScheduleCatalogEntry, ScheduleRecord } from '@deepseek-ai/dsh-schedule/client'

import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { HostClient } from '../../client/types.ts'
import {
  isRemoteFeatureSelection,
  type RemoteFeatureContext,
  type RemoteFeatureSelection,
} from './contracts.ts'

/** A failed official Remote call, retaining only its safe code and message. */
export class RemoteCallError extends Error {
  override readonly name = 'RemoteCallError'

  constructor(readonly code: string, message: string) {
    super(message)
  }
}

/** Unwrap one official result without introducing a generic RPC surface. */
export async function remoteValue<T>(operation: Promise<RemoteResult<T>>): Promise<T> {
  const result = await operation
  // A Host may answer with a code and no text; an empty Error message leaves a
  // blank notice, so the code stands in for it.
  if (!result.ok) {
    throw new RemoteCallError(
      result.error.code,
      result.error.message.trim() === '' ? result.error.code : result.error.message,
    )
  }
  return result.value
}

/** The longest Host message this frontend renders; longer text is cut. */
const REMOTE_MESSAGE_LIMIT = 2_000

/**
 * One Host or transport message as a single bounded line.
 *
 * A Host may answer with a multi-line diagnostic or with nothing at all; both
 * are useless in a notice row, so an empty message falls back to the code and
 * a long one is collapsed and cut.
 * @param error - the thrown value, of any shape.
 * @param secrets - values to redact before the text can be shown or logged.
 * @param fallback - the text to use when the value carries no message.
 * @returns one line, never empty.
 */
export function remoteErrorMessage(error: unknown, secrets: readonly string[] = [], fallback = 'operation failed'): string {
  const raw = error instanceof Error
    ? error.message
    : typeof error === 'object' && error !== null && 'message' in error && typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message
      : String(error)
  let message = raw
  for (const secret of secrets) {
    if (secret.length > 0) message = message.replaceAll(secret, '[redacted]')
  }
  const oneLine = message.replace(/\s*[\r\n]+\s*/gu, ' · ').trim()
  return (oneLine === '' ? fallback : oneLine).slice(0, REMOTE_MESSAGE_LIMIT)
}

/** Narrow official settings event omitted by the installed generated stream union. */
export function onRemoteSettingsDocumentUpdated(
  client: HostClient,
  listener: (ns: string, revision: number) => void,
): () => void {
  const remote = client.remote as HostClient['remote'] & {
    $on(event: 'settings/document-updated', listener: (ns: string, revision: number) => void): () => void
  }
  return remote.$on('settings/document-updated', listener)
}

/** Read a record property at a wire/projection validation boundary. */
export function remoteProperty(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? Reflect.get(value, key) : undefined
}

/** Read one string-valued projection, or undefined for an absent/malformed value. */
export function remoteStringProjection(value: unknown, key: string): string | undefined {
  const nested = remoteProperty(value, key)
  return typeof nested === 'string' ? nested : undefined
}

/** An operation bound to one exact attached Client and optional displayed Session binding. */
export class RemoteFeatureOperation {
  private readonly lifetime = new AbortController()
  private readonly combined: AbortSignal
  private readonly cleanups = new Set<() => void>()
  private readonly generation: number | undefined
  private readonly activeClient: HostClient | undefined
  private disposed = false

  constructor(
    private readonly context: Pick<RemoteFeatureContext, 'hosts'>,
    readonly client: HostClient,
    readonly selection?: RemoteFeatureSelection,
    parent?: AbortSignal,
  ) {
    this.generation = client.state?.getSnapshot().generation
    this.activeClient = context.hosts.current()?.client ?? context.hosts.active?.()
    this.combined = parent === undefined ? this.lifetime.signal : AbortSignal.any([this.lifetime.signal, parent])
    this.onDispose(() => {
      parent?.removeEventListener('abort', this.abortFromParent)
    })
    parent?.addEventListener('abort', this.abortFromParent, { once: true })
    if (parent?.aborted === true) this.dispose()
  }

  private readonly abortFromParent = (): void => { this.dispose() }

  /** Cancellation applies to local reads/watches only, never implicit Host cancellation. */
  get signal(): AbortSignal { return this.combined }

  /** Whether a late result may still update this operation's panel or notice. */
  valid(): boolean {
    if (this.disposed || this.combined.aborted || !this.context.hosts.list().includes(this.client)) return false
    if (this.client.state?.getSnapshot().generation !== this.generation) return false
    if (this.selection === undefined) return (this.context.hosts.current()?.client ?? this.context.hosts.active?.()) === this.activeClient
    const current = this.context.hosts.current()
    return isRemoteFeatureSelection(current, this.client, this.selection.ref)
      && current.binding === this.selection.binding
  }

  /** Register idempotent local cleanup owned by this operation. */
  onDispose(cleanup: () => void): void {
    if (this.disposed) { cleanup(); return }
    this.cleanups.add(cleanup)
  }

  /** Stop local listeners and async continuations without cancelling remote work. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.lifetime.abort()
    for (const cleanup of [...this.cleanups].reverse()) cleanup()
    this.cleanups.clear()
  }
}

/** Shared owner for all per-Host and per-Session operations of one feature mount. */
export abstract class RemoteFeatureController {
  private readonly operations = new Set<RemoteFeatureOperation>()
  private readonly offTopology: () => void
  private readonly connections = new Map<HostClient, () => void>()
  private disposed = false

  protected constructor(protected readonly context: RemoteFeatureContext) {
    this.offTopology = context.hosts.subscribe(() => { this.reconcileConnections(); this.invalidateStale() })
    this.reconcileConnections()
  }

  /** Begin an exact Host operation; detached Clients cannot be captured. */
  protected hostOperation(client: HostClient, parent?: AbortSignal): RemoteFeatureOperation | undefined {
    if (this.disposed || !this.context.hosts.list().includes(client)) return undefined
    return this.track(new RemoteFeatureOperation(this.context, client, undefined, parent))
  }

  /** Begin an exact displayed Session operation, including binding replacement fencing. */
  protected sessionOperation(selection: RemoteFeatureSelection, parent?: AbortSignal): RemoteFeatureOperation | undefined {
    if (this.disposed || !this.context.hosts.list().includes(selection.client)) return undefined
    return this.track(new RemoteFeatureOperation(this.context, selection.client, selection, parent))
  }

  /** Dispose only operations rooted at one detached Host generation. */
  protected invalidateHost(client: HostClient): void {
    for (const operation of this.operations) if (operation.client === client) operation.dispose()
  }

  /** Stop every feature listener and ignore every late result. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.offTopology()
    for (const off of this.connections.values()) off()
    this.connections.clear()
    for (const operation of this.operations) operation.dispose()
    this.operations.clear()
  }

  private invalidateStale(): void {
    for (const operation of this.operations) if (!operation.valid()) operation.dispose()
  }

  private reconcileConnections(): void {
    if (this.disposed) return
    const attached = new Set(this.context.hosts.list())
    for (const [client, off] of this.connections) {
      if (attached.has(client)) continue
      off()
      this.connections.delete(client)
    }
    for (const client of attached) {
      if (this.connections.has(client) || client.state === undefined) continue
      this.connections.set(client, client.state.subscribe(() => { this.invalidateStale() }))
    }
  }

  private track(operation: RemoteFeatureOperation): RemoteFeatureOperation {
    this.operations.add(operation)
    operation.onDispose(() => { this.operations.delete(operation) })
    return operation
  }
}
