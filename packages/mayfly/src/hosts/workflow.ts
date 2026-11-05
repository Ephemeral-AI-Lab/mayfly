/**
 * Host-owned Workflow baseline and replacement-frame consumer.
 * @module @ephemeral-ai/mayfly/frontend/workflow
 */
import {
  RemoteSnapshotStream, RemoteStreamCarrierError, type RemoteStream,
} from '@deepseek-ai/dsh-api-gateway/client'
import type { HostClient, SessionRef } from '../client/types.ts'

/** Generated-Host stream adapter for one selected Workflow. */
interface RemoteWorkflowStreamOptions<Baseline, Frame> {
  /** Diagnostic stream name. */
  readonly name: string
  /** Call the generated mayflyHost followWorkflow method for one physical generation. */
  readonly open: (signal: AbortSignal) => AsyncIterable<Baseline | Frame>
  /** Distinguish the generation's required opening baseline from replacement frames. */
  readonly isBaseline: (frame: Baseline | Frame) => frame is Baseline
}

/** Immutable Host Workflow frame state; deltas replace presentation data rather than being folded locally. */
interface RemoteWorkflowSnapshot<Baseline, Frame> {
  readonly ref: SessionRef | undefined
  readonly generation: number
  readonly baseline: Baseline | undefined
  readonly frame: Baseline | Frame | undefined
  readonly streaming: boolean
  readonly error?: unknown
}

interface ActiveWorkflow<Baseline, Frame> {
  readonly physical: RemoteStream<Baseline | Frame>
  readonly snapshots: RemoteSnapshotStream<Baseline, Frame>
}

/** Owns one generated Workflow stream and its baseline replacement lifecycle. */
export class RemoteWorkflowSource<Baseline, Frame> {
  private readonly listeners = new Set<() => void>()
  private active: ActiveWorkflow<Baseline, Frame> | undefined
  private generation = 0
  private tail: Promise<void> = Promise.resolve()
  private current: RemoteWorkflowSnapshot<Baseline, Frame> = emptyWorkflow(0)
  private disposed = false

  /** Return the latest complete Host baseline or replacement frame. */
  snapshot(): RemoteWorkflowSnapshot<Baseline, Frame> {
    return this.current
  }

  /** Subscribe to Host baseline, replacement, and failure publications. */
  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Replace the selected Host Workflow stream after closing its predecessor. */
  attach(
    client: HostClient | null,
    ref: SessionRef | undefined,
    options: RemoteWorkflowStreamOptions<Baseline, Frame> | undefined,
  ): Promise<void> {
    if (this.disposed) return this.tail
    const complete = client !== null && ref !== undefined && options !== undefined
    const empty = client === null && ref === undefined && options === undefined
    if (!complete && !empty) {
      throw new Error('Workflow attach requires either a Client, SessionRef, and stream options, or none of them')
    }
    if (client !== null && client.key !== ref?.host) {
      throw new Error('Workflow Host Client and SessionRef must identify the same Host')
    }
    const generation = ++this.generation
    const previous = this.active
    this.active = undefined
    this.current = emptyWorkflow(generation, ref)
    this.publish()
    const operation = this.tail.then(async () => {
      await previous?.snapshots.dispose()
      if (this.disposed || generation !== this.generation || client === null || ref === undefined || options === undefined) return
      const physical = client.remote.$stream<Baseline | Frame>({
        name: options.name,
        open: options.open,
        ended: accepted => accepted
          ? new RemoteStreamCarrierError(`${options.name} ended before release`)
          : new Error(`${options.name} ended before its opening baseline`),
      })
      const active: ActiveWorkflow<Baseline, Frame> = {
        physical,
        snapshots: new RemoteSnapshotStream(physical, {
          name: options.name,
          isSnapshot: options.isBaseline,
          replace: (baseline) => {
            if (!this.owns(active, generation)) return
            this.current = { ref, generation, baseline, frame: baseline, streaming: true }
            this.publish()
          },
          update: (frame) => {
            if (!this.owns(active, generation)) return
            this.current = { ...this.current, frame, streaming: true }
            this.publish()
          },
          failed: (error) => {
            if (!this.owns(active, generation)) return
            this.current = { ...this.current, streaming: false, error }
            this.publish()
          },
        }),
      }
      this.active = active
      this.current = { ref, generation, baseline: undefined, frame: undefined, streaming: true }
      active.snapshots.start()
      this.publish()
    })
    this.tail = operation.then(() => undefined, () => undefined)
    return operation
  }

  /** Request a fresh Host baseline without discarding the current published frame. */
  restart(): void {
    this.active?.snapshots.restart()
  }

  /** Stop the stream and wait for every generation callback to finish. */
  async dispose(): Promise<void> {
    if (this.disposed) return await this.tail
    this.disposed = true
    this.generation += 1
    const previous = this.active
    this.active = undefined
    const operation = this.tail.then(async () => { await previous?.snapshots.dispose() })
    this.tail = operation.then(() => undefined, () => undefined)
    try {
      await operation
    } finally {
      this.listeners.clear()
    }
  }

  private owns(active: ActiveWorkflow<Baseline, Frame>, generation: number): boolean {
    return !this.disposed && this.active === active && this.generation === generation
  }

  private publish(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

function emptyWorkflow<Baseline, Frame>(generation: number, ref?: SessionRef): RemoteWorkflowSnapshot<Baseline, Frame> {
  return { ref, generation, baseline: undefined, frame: undefined, streaming: false }
}

