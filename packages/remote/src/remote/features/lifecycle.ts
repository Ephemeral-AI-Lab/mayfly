/**
 * Exact Host/Session/reconnection generation ownership for focused Remote features.
 * @module @ephemeral-ai/mayfly/remote/features/lifecycle
 */

import type { HostClient } from '../../client/types.ts'
import type { RemoteFeatureContext, RemoteFeatureSelection } from '../features.ts'

/** One feature-local selection generation, invalidated by topology and Host connection replacement. */
export class RemoteFeatureLifecycle {
  private readonly listeners = new Map<HostClient, () => void>()
  private readonly offTopology: () => void
  private generation = 0
  private disposed = false
  private started = false

  constructor(
    private readonly options: RemoteFeatureContext,
    private readonly changed: (generation: number) => void,
  ) {
    this.offTopology = this.options.hosts.subscribe(this.reconcile)
  }

  /** Begin observing the current selection and every attached Host. */
  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    this.reconcile()
  }

  /** Current feature generation, incremented before every invalidation callback. */
  currentGeneration(): number {
    return this.generation
  }

  /** Whether an async continuation still belongs to this feature generation. */
  owns(generation: number): boolean {
    return !this.disposed && this.started && generation === this.generation
  }

  /** Return the exact selection only while its captured generation remains current. */
  selection(generation: number): RemoteFeatureSelection | undefined {
    return this.owns(generation) ? this.options.hosts.current() : undefined
  }

  /** Stop every listener without invoking another feature refresh. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation += 1
    this.offTopology()
    for (const off of this.listeners.values()) off()
    this.listeners.clear()
  }

  private readonly reconcile = (): void => {
    if (this.disposed) return
    const attached = new Set(this.options.hosts.list())
    for (const [client, listener] of this.listeners) {
      if (attached.has(client)) continue
      listener()
      this.listeners.delete(client)
    }
    for (const client of attached) {
      if (this.listeners.has(client)) continue
      let generation = client.state.getSnapshot().generation
      let active = true
      const off = client.state.subscribe(() => {
        if (!active) return
        const next = client.state.getSnapshot().generation
        if (generation === next) return
        generation = next
        this.invalidate()
      })
      this.listeners.set(client, () => { active = false; off() })
    }
    this.invalidate()
  }

  private invalidate(): void {
    const generation = ++this.generation
    this.changed(generation)
  }
}

/** Identity key for logs and operation fences that must include the borrowed Client binding. */
export function remoteSelectionKey(selection: RemoteFeatureSelection | undefined): string {
  if (selection === undefined) return ''
  return `${selection.ref.host}\0${selection.ref.sessionId}\0${String(selection.client.key)}`
}
