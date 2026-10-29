/**
 * Selected-Session Job roster and cancellation through an official Client Remote adapter.
 * @module @ephemeral-ai/mayfly/frontend/jobs
 */
import { RemoteStreamCarrierError, type RemoteStream } from '@deepseek-ai/dsh-api-gateway/client'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { HostClient, SessionRef } from '../client/types.ts'

/** One whole Job-roster replacement supplied by the official job.list stream. */
export interface RemoteJobRows<Job> {
  readonly jobs: readonly Job[]
}

/** Generated job.list adapter for one selected Session. */
export interface RemoteJobStreamOptions<Job> {
  readonly name: string
  readonly open: (signal: AbortSignal) => AsyncIterable<RemoteJobRows<Job>>
}

/** Structured job.kill command supplied by the generated official namespace. */
export type RemoteJobKill<Id, Value> = (ref: SessionRef, id: Id) => Promise<RemoteResult<Value>>

/** Immutable selected-Session Job roster state. */
export interface RemoteJobsSnapshot<Job> {
  readonly ref: SessionRef | undefined
  readonly jobs: readonly Job[]
  readonly streaming: boolean
  readonly generation: number
  readonly error?: unknown
}

interface ActiveJobs<Job> {
  readonly stream: RemoteStream<RemoteJobRows<Job>>
  task: Promise<void>
}

/** Owns one exact Host/Session Job roster stream and its deterministic cleanup. */
export class RemoteJobSource<Job, Id, KillValue> {
  private readonly listeners = new Set<() => void>()
  private active: ActiveJobs<Job> | undefined
  private generation = 0
  private tail: Promise<void> = Promise.resolve()
  private current: RemoteJobsSnapshot<Job> = emptyJobs(0)
  private disposed = false

  /** @param kill - generated job.kill passthrough; it is never retried here. */
  constructor(private readonly killCommand: RemoteJobKill<Id, KillValue>) {}

  /** Return the current whole-roster snapshot. */
  snapshot(): RemoteJobsSnapshot<Job> {
    return this.current
  }

  /** Subscribe to roster replacements and terminal stream failures. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Kill one Job through the generated namespace's structured result contract. */
  kill(ref: SessionRef, id: Id): Promise<RemoteResult<KillValue>> {
    return this.killCommand(ref, id)
  }

  /** Replace the watched Host/Session after closing the prior official job.list stream. */
  attach(
    client: HostClient | null,
    ref: SessionRef | undefined,
    options: RemoteJobStreamOptions<Job> | undefined,
  ): Promise<void> {
    const complete = client !== null && ref !== undefined && options !== undefined
    const empty = client === null && ref === undefined && options === undefined
    if (!complete && !empty) throw new Error('Job attach requires either a Client, SessionRef, and stream options, or none of them')
    if (client !== null && client.key !== ref?.host) {
      throw new Error('Job source Host Client and SessionRef must identify the same Host')
    }
    const generation = ++this.generation
    const previous = this.active
    this.active = undefined
    this.current = emptyJobs(generation, ref)
    this.publish()
    const operation = this.tail.then(async () => {
      await closeJobs(previous)
      if (this.disposed || generation !== this.generation || client === null || ref === undefined || options === undefined) return
      const stream = client.remote.$stream<RemoteJobRows<Job>>({
        name: options.name,
        open: options.open,
        ended: accepted => accepted
          ? new RemoteStreamCarrierError(`${options.name} ended before release`)
          : new Error(`${options.name} ended before its first frame`),
      })
      const active: ActiveJobs<Job> = { stream, task: Promise.resolve() }
      active.task = this.consume(active, stream, ref, generation)
      this.active = active
      this.current = { ref, jobs: [], streaming: true, generation }
      this.publish()
    })
    this.tail = operation.then(() => undefined, () => undefined)
    return operation
  }

  /** Stop the roster and wait for its async continuation to become quiescent. */
  async dispose(): Promise<void> {
    if (this.disposed) return await this.tail
    this.disposed = true
    this.generation += 1
    const previous = this.active
    this.active = undefined
    const operation = this.tail.then(() => closeJobs(previous))
    this.tail = operation.then(() => undefined, () => undefined)
    await operation
    this.listeners.clear()
  }

  private async consume(
    active: ActiveJobs<Job>,
    stream: RemoteStream<RemoteJobRows<Job>>,
    ref: SessionRef,
    generation: number,
  ): Promise<void> {
    try {
      for await (const item of stream) {
        if (this.disposed || generation !== this.generation || this.active !== active) return
        this.current = { ref, jobs: item.value.jobs, streaming: true, generation }
        this.publish()
        item.accept()
      }
    } catch (error) {
      if (this.disposed || generation !== this.generation || this.active !== active) return
      this.current = { ref, jobs: [], streaming: false, generation, error }
      this.publish()
    } finally {
      if (this.active === active) this.active = undefined
      await stream.dispose()
      if (!this.disposed && generation === this.generation) {
        this.current = { ...this.current, streaming: false }
        this.publish()
      }
    }
  }

  private publish(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

async function closeJobs<Job>(active: ActiveJobs<Job> | undefined): Promise<void> {
  if (active === undefined) return
  await active.stream.dispose()
  await active.task
}

function emptyJobs<Job>(generation: number, ref?: SessionRef): RemoteJobsSnapshot<Job> {
  return { ref, jobs: [], streaming: false, generation }
}
