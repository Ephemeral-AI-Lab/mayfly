/**
 * Shared seams for the operations composition: narrow mount options, one
 * retained side views, and backwards event pagination over the official
 * session journal.
 * @module @ephemeral-ai/mayfly/app/operations/support
 */

import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type {
  SessionAddress, SessionPageRequest, SessionWireEvent,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type { HostClient, HostKey, SessionRef } from '../../client/types.ts'
import type { RemoteBtwService } from '../../hosts/btw.ts'
import type { HostViewLease } from '../../hosts/host-registry.ts'
import type { SpawnedChildren } from '../../transcript/tool-calls.ts'
import { remoteValue } from '../features/official.ts'
import type { RemoteFeatureContext, RemoteFeatureSelection } from '../features.ts'

/** Native child authority and display metadata for one independently presented conversation. */
export interface RemotePresentedViewFacts {
  readonly kind: 'btw' | 'subagent'
  readonly access: 'interactive' | 'resumable' | 'readonly'
  readonly label?: string
  readonly cwd?: string
  readonly historyFloorSeq?: number
  readonly address?: SubagentAddress
}

/** Narrow integrator seam the operations composition is mounted with. */
export interface RemoteOperationsOptions {
  /** Local base directory for relative `/save` and `/export` paths. */
  readonly localCwd: string
  /** The primary Session whose descendants `/agents` browses. */
  readonly primary?: () => RemoteFeatureSelection | undefined
  /** Display the primary while preserving retained side-conversation descriptors. */
  readonly showPrimary?: () => void
  /** BTW orchestration over the integrator's HostActions/HostRegistry pair. */
  readonly btw: RemoteBtwService
  /** Show one independent side view for a forked or cold child binding. */
  readonly present?: (ref: SessionRef, binding: SessionBinding, facts: RemotePresentedViewFacts) => void
  /** Close the side view; it never touches the Host Session behind it. */
  readonly closePresent?: (ref?: SessionRef) => void
  /** Copy text through the integrator's clipboard path. */
  readonly copy?: (text: string) => Promise<'native' | 'osc52' | void>
  /** The states of the displayed parent's children, the same ones the stream reads. */
  readonly children?: () => SpawnedChildren | undefined
  /** Listen to those states changing. */
  readonly subscribeChildren?: (listener: () => void) => () => void
  /** Borrow the primary conversation owner's exact Host metadata without another cache. */
  readonly modelCatalog?: (host: HostKey) => ModelCatalog | undefined
}

/** One operations module mount over the shared feature context, options, and presented view. */
export interface RemoteOperationsContext {
  readonly base: RemoteFeatureContext
  readonly options: RemoteOperationsOptions
  /** One lease owner for retained children and the externally owned BTW view. */
  readonly presentSlot: RemotePresentSlot
}

/** Register one operations locale namespace with English keys and Chinese messages. */
export function registerRemoteOperationsLocale(
  base: RemoteFeatureContext,
  namespace: string,
  zh: Readonly<Record<string, string>>,
): void {
  base.ctx.effect(() => base.ctx.mayflyLocale.register(namespace, {
    en: Object.freeze(Object.fromEntries(Object.keys(zh).map(key => [key, key]))),
    zh,
  }))
}

interface PendingPresentedView {
  readonly ref: SessionRef
  readonly lease: HostViewLease
  released: boolean
}

const viewKey = (ref: SessionRef): string => JSON.stringify([ref.host, ref.sessionId])

/** One side-view lease owner: retained children plus one externally owned BTW view. */
export class RemotePresentSlot {
  private readonly owned = new Map<string, HostViewLease>()
  private pending: PendingPresentedView | undefined
  private btw: SessionRef | undefined
  private disposed = false

  constructor(private readonly options: Pick<RemoteOperationsOptions, 'present' | 'closePresent'>) {}

  /** Retain one child independently; a later child does not release previous completed reads. */
  async adopt(ref: SessionRef, lease: HostViewLease, facts: () => RemotePresentedViewFacts, options: { readonly signal?: AbortSignal, readonly isCurrent?: () => boolean } = {}): Promise<void> {
    this.releasePending()
    const candidate = { ref, lease, released: false }
    this.pending = candidate
    const cancel = (): void => { this.releasePending(candidate) }
    const cancelled = (): boolean => options.signal?.aborted === true
    if (this.disposed || cancelled()) { cancel(); return }
    options.signal?.addEventListener('abort', cancel, { once: true })
    let binding: SessionBinding
    try {
      binding = await lease.ready
    } catch (error) {
      cancel()
      throw error
    } finally {
      options.signal?.removeEventListener('abort', cancel)
    }
    if (this.pending !== candidate || cancelled() || options.isCurrent?.() === false) {
      cancel()
      return
    }
    this.pending = undefined
    const key = viewKey(ref)
    this.owned.get(key)?.release()
    this.owned.set(key, lease)
    const metadata = facts()
    const previousBtw = this.registerBtw(ref, metadata)
    this.options.present?.(ref, binding, metadata)
    if (previousBtw !== undefined) this.close(previousBtw)
  }

  /** Present a binding owned elsewhere, for example the live BTW service lease. */
  present(ref: SessionRef, binding: SessionBinding, facts: RemotePresentedViewFacts): void {
    if (this.disposed) return
    this.releasePending()
    const key = viewKey(ref)
    this.owned.get(key)?.release()
    this.owned.delete(key)
    const previousBtw = this.registerBtw(ref, facts)
    this.options.present?.(ref, binding, facts)
    if (previousBtw !== undefined) this.close(previousBtw)
  }

  /** Listed conversations keep only descriptors; native bindings belong to displayed/F7 residents. */
  retainOnly(refs: readonly SessionRef[]): void {
    const retained = new Set(refs.map(viewKey))
    if (this.pending !== undefined && !retained.has(viewKey(this.pending.ref))) this.releasePending()
    for (const [key, lease] of this.owned) {
      if (retained.has(key)) continue
      this.owned.delete(key)
      lease.release()
    }
  }

  /** Close one exact view, or all views at composition unload; Host work keeps running. */
  close(ref?: SessionRef): void {
    if (ref === undefined) {
      this.releasePending()
      for (const lease of this.owned.values()) lease.release()
      this.owned.clear()
      this.btw = undefined
    } else {
      const key = viewKey(ref)
      if (this.pending !== undefined && viewKey(this.pending.ref) === key) this.releasePending()
      this.owned.get(key)?.release()
      this.owned.delete(key)
      if (this.btw !== undefined && viewKey(this.btw) === key) this.btw = undefined
    }
    this.options.closePresent?.(ref)
  }

  /** Close only the external BTW presentation, preserving every retained child. */
  closeBtw(): void {
    if (this.btw !== undefined) this.close(this.btw)
  }

  /** Release every owned lease without asking the integrator to close its views. */
  dispose(): void {
    this.disposed = true
    this.releasePending()
    for (const lease of this.owned.values()) lease.release()
    this.owned.clear()
    this.btw = undefined
  }

  private releasePending(candidate = this.pending): void {
    if (candidate === undefined) return
    if (this.pending === candidate) this.pending = undefined
    if (candidate.released) return
    candidate.released = true
    candidate.lease.release()
  }

  private registerBtw(ref: SessionRef, facts: RemotePresentedViewFacts): SessionRef | undefined {
    if (facts.kind !== 'btw') return undefined
    const previous = this.btw
    this.btw = ref
    return previous !== undefined && viewKey(previous) !== viewKey(ref) ? previous : undefined
  }
}

/** Bounds of one backwards journal walk. */
interface RemoteEventsQuery {
  readonly address: SessionAddress
  /** Page size passed as `maxMessages`; the official default applies when omitted. */
  readonly maxMessages?: number
  /** Hard page ceiling so a misbehaving journal cannot loop forever. */
  readonly maxPages?: number
  /** Stop once this many events are collected, before requesting another page. */
  readonly minEvents?: number
  readonly signal?: AbortSignal
}

/**
 * Read durable events backwards through `session.events` pages until history
 * exhaustion, the page ceiling, or cancellation, returning them in seq order.
 */
export async function collectRemoteSessionEvents(
  client: HostClient,
  query: RemoteEventsQuery,
): Promise<readonly SessionWireEvent[]> {
  const maxPages = query.maxPages ?? 1_000
  const events: SessionWireEvent[] = []
  let beforeSeq: number | undefined
  for (let page = 0; page < maxPages; page += 1) {
    query.signal?.throwIfAborted()
    const request: SessionPageRequest = {
      address: query.address,
      ...(query.maxMessages === undefined ? {} : { maxMessages: query.maxMessages }),
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
    }
    const result = await remoteValue(client.remote.session.events(request, query.signal))
    query.signal?.throwIfAborted()
    const records = result.records.flatMap(record => (record.type === 'event' ? [record.event] : []))
    events.push(...records)
    if (!result.hasMore || records.length === 0) break
    if (query.minEvents !== undefined && events.length >= query.minEvents) break
    const floor = Math.min(...records.map(event => event.seq))
    if (beforeSeq !== undefined && floor >= beforeSeq) break
    beforeSeq = floor
  }
  return events.toSorted((left, right) => left.seq - right.seq)
}

/** Structural record test shared by every defensive projection and wire reader. */
export function isRemoteRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read one string property, or undefined for an absent or non-string value. */
export function remoteReadString(value: unknown, key: string): string | undefined {
  const nested = isRemoteRecord(value) ? value[key] : undefined
  return typeof nested === 'string' ? nested : undefined
}

/** Read one finite number property, or undefined for an absent or non-numeric value. */
export function remoteReadNumber(value: unknown, key: string): number | undefined {
  const nested = isRemoteRecord(value) ? value[key] : undefined
  return typeof nested === 'number' && Number.isFinite(nested) ? nested : undefined
}
