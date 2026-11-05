/** Exact displayed-parent ownership of passive whole child projection reads. @module */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-api-session-controller/client'
import type { HostClient, SessionRef } from '../client/types.ts'
import type { RemoteSessionFactsSnapshot } from '../hosts/session-facts.ts'
import { remoteTranscriptChildIds, remoteTranscriptContext } from './context.ts'

interface Selection {
  readonly facts: RemoteSessionFactsSnapshot
  readonly client: HostClient | undefined
}

/** The displayed facts retain their selection's stable ref identity. */
interface RemoteTranscriptContextSourceOptions {
  readonly read: () => Selection
  readonly changed: () => void
}

interface ChildRead {
  key: string
  requested: string | undefined
  attempts: number
  controller: AbortController | undefined
  retry: ReturnType<typeof setTimeout> | undefined
}

interface Scope {
  readonly client: HostClient
  readonly ref: SessionRef
  readonly generation: number
  readonly children: Map<SessionId, Readonly<Partial<SessionProjectionMap>>>
  readonly reads: Map<SessionId, ChildRead>
  readonly off: (() => void)[]
}

/** Read native snapshots without retaining child Sessions, Agents, journals, or domain events. */
export class RemoteTranscriptContextSource {
  private scope: Scope | undefined
  private disposed = false

  constructor(private readonly options: RemoteTranscriptContextSourceOptions) {}

  /** Resolve the displayed parent's context and acquire only its authoritative direct children. */
  snapshot(): ReturnType<typeof remoteTranscriptContext> {
    if (this.disposed) return undefined
    const { facts, client } = this.options.read()
    const state = client?.state.getSnapshot()
    let scope = this.scope
    if (scope !== undefined && (scope.client !== client || scope.ref !== facts.ref || state?.status !== 'connected' || scope.generation !== state.generation)) {
      this.retire(scope)
      scope = undefined
    }
    if (scope === undefined && facts.ref !== undefined && client?.key === facts.ref.host && state?.status === 'connected') {
      scope = { client, ref: facts.ref, generation: state.generation, children: new Map(), reads: new Map(), off: [] }
      this.scope = scope
      const owned = scope
      for (const source of [client.state, client.sessions.list]) {
        const off = source.subscribe(() => {
          if (this.scope !== owned) return
          this.snapshot()
          if (!this.disposed) this.options.changed()
        })
        if (this.scope !== owned) { off(); break }
        owned.off.push(off)
      }
    }
    // A subscription may synchronously change the selection or dispose its owner.
    if (scope !== undefined) {
      if (this.owns(scope)) {
        this.refresh(scope, facts)
        if (this.owns(scope)) return remoteTranscriptContext(facts, { ref: scope.ref, snapshot: scope.client.sessions.list.getSnapshot(), children: scope.children })
      }
      if (this.scope === scope) this.retire(scope)
      return this.snapshot()
    }
    return remoteTranscriptContext(facts)
  }

  /** Release observers, bounded retries, and reads; late settlements cannot publish. */
  dispose(): void {
    this.disposed = true
    if (this.scope !== undefined) this.retire(this.scope)
  }

  private refresh(scope: Scope, facts: RemoteSessionFactsSnapshot): void {
    const snapshot = scope.client.sessions.list.getSnapshot()
    const ids = new Set(remoteTranscriptChildIds(facts, { ref: scope.ref, snapshot }))
    for (const [id, read] of scope.reads) {
      if (ids.has(id)) continue
      this.stop(read)
      scope.reads.delete(id)
      scope.children.delete(id)
    }
    for (const id of ids) {
      const summary = snapshot.byId[id]
      // Projection map identity changes must never cause a passive read loop.
      const key = JSON.stringify([summary?.running, summary?.updatedAt])
      let read = scope.reads.get(id)
      if (read === undefined) {
        read = { key, requested: undefined, attempts: 0, controller: undefined, retry: undefined }
        scope.reads.set(id, read)
        scope.children.set(id, {})
      } else if (read.key !== key) {
        read.key = key
        read.attempts = 0
        clearTimeout(read.retry)
        read.retry = undefined
        scope.children.set(id, {})
      }
      if (read.controller === undefined && read.retry === undefined && (read.requested !== key || read.attempts === 0)) this.start(scope, id, read)
    }
  }

  private start(scope: Scope, id: SessionId, read: ChildRead): void {
    if (!this.ownsRead(scope, id, read)) return
    const controller = new AbortController()
    const key = read.key
    read.controller = controller
    read.requested = key
    read.attempts += 1
    void this.load(scope, id, read, controller, key)
  }

  private async load(scope: Scope, id: SessionId, read: ChildRead, controller: AbortController, key: string): Promise<void> {
    let retry = false
    try {
      const result = await scope.client.remote.session.projections({ sessionId: id }, controller.signal)
      if (!this.ownsRead(scope, id, read) || read.key !== key) return
      if (result.ok) {
        // Every response replaces the entire child snapshot, including a native absence.
        scope.children.set(id, result.value === null ? {} : result.value.values)
        retry = result.value === null
        this.options.changed()
      } else retry = true
    } catch {
      retry = true
    } finally {
      if (this.ownsRead(scope, id, read)) {
        read.controller = undefined
        if (read.key !== key) this.start(scope, id, read)
        else if (retry && read.attempts < 2) {
          read.retry = setTimeout(() => {
            read.retry = undefined
            if (this.ownsRead(scope, id, read)) this.start(scope, id, read)
          }, 250)
        }
      } else if (this.scope === scope && !this.owns(scope)) this.retire(scope)
    }
  }

  private ownsRead(scope: Scope, id: SessionId, read: ChildRead): boolean {
    return this.owns(scope) && scope.reads.get(id) === read
  }

  private owns(scope: Scope): boolean {
    if (this.disposed || this.scope !== scope) return false
    const { facts, client } = this.options.read()
    const state = scope.client.state.getSnapshot()
    return client === scope.client && facts.ref === scope.ref && state.status === 'connected' && state.generation === scope.generation
  }

  private stop(read: ChildRead): void {
    clearTimeout(read.retry)
    read.controller?.abort()
  }

  private retire(scope: Scope): void {
    this.scope = undefined
    for (const off of scope.off) off()
    for (const read of scope.reads.values()) this.stop(read)
    scope.reads.clear()
    scope.children.clear()
  }
}
