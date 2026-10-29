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
  if (!result.ok) throw new RemoteCallError(result.error.code, result.error.message)
  return result.value
}

/** Render an operation error while removing every supplied secret value. */
export function remoteErrorMessage(error: unknown, secrets: readonly string[] = []): string {
  let message = error instanceof Error ? error.message : String(error)
  for (const secret of secrets) {
    if (secret.length > 0) message = message.replaceAll(secret, '[redacted]')
  }
  return message
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
  private disposed = false

  constructor(
    private readonly context: Pick<RemoteFeatureContext, 'hosts'>,
    readonly client: HostClient,
    readonly selection?: RemoteFeatureSelection,
    parent?: AbortSignal,
  ) {
    this.combined = parent === undefined ? this.lifetime.signal : AbortSignal.any([this.lifetime.signal, parent])
    this.onDispose(() => {
      if (parent !== undefined) this.combined.removeEventListener('abort', this.abortFromParent)
    })
    parent?.addEventListener('abort', this.abortFromParent, { once: true })
  }

  private readonly abortFromParent = (): void => { this.lifetime.abort() }

  /** Cancellation applies to local reads/watches only, never implicit Host cancellation. */
  get signal(): AbortSignal { return this.combined }

  /** Whether a late result may still update this operation's panel or notice. */
  valid(): boolean {
    if (this.disposed || this.combined.aborted || !this.context.hosts.list().includes(this.client)) return false
    if (this.selection === undefined) return true
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
  private disposed = false

  protected constructor(protected readonly context: RemoteFeatureContext) {
    this.offTopology = context.hosts.subscribe(() => { this.invalidateStale() })
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
    for (const operation of this.operations) operation.dispose()
    this.operations.clear()
  }

  private invalidateStale(): void {
    for (const operation of this.operations) if (!operation.valid()) operation.dispose()
  }

  private track(operation: RemoteFeatureOperation): RemoteFeatureOperation {
    this.operations.add(operation)
    operation.onDispose(() => { this.operations.delete(operation) })
    return operation
  }
}
