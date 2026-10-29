/**
 * Incremental Host tool-presentation cache for the synchronous published Transcript mapper.
 * @module @ephemeral-ai/mayfly/frontend/tool-presentations
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConversationProjection, ConversationToolEntry } from '@ephemeral-ai/mayfly/conversation'
import { parseToolArguments, type ToolPresentationFacts, type ToolPresentationSource } from '@ephemeral-ai/mayfly/transcript'
import type { SessionRef } from '../client/types.ts'

type ToolOutcome = NonNullable<ToolPresentationFacts['outcome']>

/** Official Host-computed call and result views for one tool entry. */
export interface RemoteToolPresentation {
  readonly call?: ToolPresentationFacts['call']
  readonly result?: ToolPresentationFacts['result']
}

/** One changed tool entry sent to the generated Host presentation adapter. */
export interface RemoteToolPresentationCall {
  readonly sessionId: SessionId
  readonly callId: string
  readonly updatedSeq: number
  readonly name: string
  readonly arguments: unknown
  readonly result?: ToolOutcome
}

/** One batch of changed entries from one exact Host/Session/revision generation. */
export interface RemoteToolPresentationRequest {
  readonly ref: SessionRef
  readonly presentationRevision: string
  readonly calls: readonly RemoteToolPresentationCall[]
}

/** Generated-Host adapter supplied after the mayflyHost Remote contribution is mounted. */
export interface RemoteToolPresentationGeneration {
  readonly presentationRevision: string
  readonly present: (
    request: RemoteToolPresentationRequest,
    signal: AbortSignal,
  ) => Promise<RemoteResult<Readonly<Record<string, RemoteToolPresentation>>>>
}

/** Resolve the current generated Host presenter and its revision for an exact Session. */
export type RemoteToolPresentationResolver = (ref: SessionRef) => RemoteToolPresentationGeneration

/** Optional scoped source implemented by the asynchronous Host presentation cache. */
export interface ScopedRemoteToolPresentationSource extends ToolPresentationSource {
  /** Synchronize changed entries and return a synchronous mapper source scoped to their order. */
  source(ref: SessionRef, projection: ConversationProjection): ToolPresentationSource
  /** Subscribe to newly available Host presentation values. */
  subscribe(listener: () => void): () => void
}

/** Complete identity of one cached tool presentation, including multi-Host isolation. */
export interface RemoteToolPresentationKey {
  readonly ref: SessionRef
  readonly callId: string
  readonly updatedSeq: number
  readonly presentationRevision: string
}

/** Stable string form of the full cache key tuple. */
export function remoteToolPresentationKey(key: RemoteToolPresentationKey): string {
  return JSON.stringify([key.ref.host, key.ref.sessionId, key.callId, key.updatedSeq, key.presentationRevision])
}

interface PendingBatch {
  readonly calls: readonly RemoteToolPresentationCall[]
  readonly keys: readonly string[]
}

/** Cache Host presenters without invoking them during a synchronous render or replaying failed batches. */
export class RemoteToolPresentationCache implements ScopedRemoteToolPresentationSource {
  private readonly values = new Map<string, RemoteToolPresentation>()
  private readonly errors = new Map<string, unknown>()
  private readonly pending = new Map<string, RemoteToolPresentationCall>()
  private readonly listeners = new Set<() => void>()
  private ref: SessionRef | undefined
  private remote: RemoteToolPresentationGeneration | undefined
  private generation = 0
  private scheduled = false
  private inflight: { readonly generation: number, readonly controller: AbortController, readonly promise: Promise<void> } | undefined
  private disposed = false

  /** @param resolve - generated Host presenter lookup for the selected Session. */
  constructor(private readonly resolve: RemoteToolPresentationResolver) {}

  /** Unscoped access is deliberately generic; RemoteConversationModelSource uses source(). */
  get(): undefined {
    return undefined
  }

  /** Subscribe to successful incremental cache fills. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Return a structured or thrown failure for one exact entry, when its only batch failed. */
  error(ref: SessionRef, entry: ConversationToolEntry, presentationRevision: string): unknown {
    return this.errors.get(remoteToolPresentationKey({ ref, callId: entry.callId, updatedSeq: entry.updatedSeq, presentationRevision }))
  }

  /** Queue only entries absent from the current key generation, then scope one synchronous mapper pass. */
  source(ref: SessionRef, projection: ConversationProjection): ToolPresentationSource {
    this.sync(ref, projection)
    const entries = projection.entries.filter((entry): entry is ConversationToolEntry => entry.kind === 'tool')
    const revision = this.remote?.presentationRevision
    let index = 0
    return {
      get: (name: string) => {
        const entry = entries[index]
        index += 1
        if (entry === undefined || entry.name !== name || revision === undefined) return undefined
        const presentation = this.values.get(remoteToolPresentationKey({
          ref,
          callId: entry.callId,
          updatedSeq: entry.updatedSeq,
          presentationRevision: revision,
        }))
        if (presentation === undefined) return undefined
        return {
          ...(presentation.call === undefined ? {} : { presentCall: () => presentation.call }),
          ...(presentation.result === undefined ? {} : { presentResult: () => presentation.result }),
        }
      },
    }
  }

  /** Drop every cached value and in-flight continuation, allowing explicit read refreshes. */
  invalidate(): void {
    this.reset()
  }

  /** Abort the active batch and wait for its continuation before releasing the owner. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const inflight = this.inflight
    this.reset()
    await inflight?.promise
    this.listeners.clear()
  }

  private sync(ref: SessionRef, projection: ConversationProjection): void {
    if (this.disposed) return
    const remote = this.resolve(ref)
    if (!sameRef(this.ref, ref)
      || this.remote?.presentationRevision !== remote.presentationRevision
      || this.remote.present !== remote.present) {
      this.reset()
      this.ref = ref
      this.remote = remote
    }
    for (const entry of projection.entries) {
      if (entry.kind !== 'tool') continue
      const key = remoteToolPresentationKey({
        ref,
        callId: entry.callId,
        updatedSeq: entry.updatedSeq,
        presentationRevision: remote.presentationRevision,
      })
      if (this.values.has(key) || this.errors.has(key) || this.pending.has(key)) continue
      this.pending.set(key, presentationCall(ref, entry))
    }
    this.schedule()
  }

  private schedule(): void {
    if (this.disposed || this.scheduled || this.pending.size === 0 || this.inflight !== undefined) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      if (!this.disposed) void this.flush()
    })
  }

  private async flush(): Promise<void> {
    const ref = this.ref
    const remote = this.remote
    const generation = this.generation
    if (this.disposed || ref === undefined || remote === undefined || this.pending.size === 0 || this.inflight !== undefined) return
    const batch: PendingBatch = { calls: [...this.pending.values()], keys: [...this.pending.keys()] }
    this.pending.clear()
    const controller = new AbortController()
    const operation = { generation, controller, promise: Promise.resolve() }
    const promise = Promise.resolve().then(() => remote.present({
      ref,
      presentationRevision: remote.presentationRevision,
      calls: batch.calls,
    }, controller.signal)).then((result) => {
      if (!this.owns(generation)) return
      if (!result.ok) {
        for (const key of batch.keys) this.errors.set(key, result.error)
        return
      }
      let changed = false
      for (const [index, key] of batch.keys.entries()) {
        const call = batch.calls[index]!
        this.values.set(key, result.value[call.callId] ?? {})
        changed = true
      }
      if (changed) this.publish()
    }, (error: unknown) => {
      if (!this.owns(generation)) return
      for (const key of batch.keys) this.errors.set(key, error)
    }).finally(() => {
      if (this.inflight?.promise === promise) this.inflight = undefined
      if (!this.disposed && generation === this.generation) this.schedule()
    })
    operation.promise = promise
    this.inflight = operation
    await promise
  }

  private owns(generation: number): boolean {
    return !this.disposed && this.generation === generation
  }

  private reset(): void {
    this.generation += 1
    this.inflight?.controller.abort(new Error('Tool presentation generation changed'))
    this.inflight = undefined
    this.values.clear()
    this.errors.clear()
    this.pending.clear()
    this.ref = undefined
    this.remote = undefined
  }

  private publish(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

function presentationCall(ref: SessionRef, entry: ConversationToolEntry): RemoteToolPresentationCall {
  const result = entry.result
  return {
    sessionId: ref.sessionId,
    callId: entry.callId,
    updatedSeq: entry.updatedSeq,
    name: entry.name,
    arguments: parseToolArguments(entry.arguments),
    ...(result === undefined ? {} : {
      result: {
        content: structuredClone(result.content) as ToolOutcome['content'],
        isError: result.isError,
        ...(result.meta === undefined ? {} : { meta: structuredClone(result.meta) }),
      },
    }),
  }
}

function sameRef(a: SessionRef | undefined, b: SessionRef): boolean {
  return a?.host === b.host && a.sessionId === b.sessionId
}
