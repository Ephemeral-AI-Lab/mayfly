/**
 * Selected-Session Job roster and cancellation through official Client Remote APIs.
 * @module @ephemeral-ai/mayfly/frontend/jobs
 */
import { RemoteStreamCarrierError, type RemoteStream } from '@deepseek-ai/dsh-api-gateway/client'
import type {
  JobKillValue, JobListFrame, JobView,
} from '@deepseek-ai/dsh-api-job-controller/client'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { HostClient, SessionRef } from '../client/types.ts'

/** Official Job identity used by follow and kill requests. */
export type RemoteJobId = JobView['id']

/** Immutable selected-Session Job roster state. */
export interface RemoteJobsSnapshot {
  readonly ref: SessionRef | undefined
  readonly jobs: readonly JobView[]
  readonly ready: boolean
  readonly streaming: boolean
  readonly generation: number
  readonly error?: unknown
}

/** Local preflight refusal; no kill RPC is issued and official Host failures are never rewritten. */
export class RemoteJobKillRejectedError extends Error {
  override readonly name = 'RemoteJobKillRejectedError'

  constructor(
    readonly ref: SessionRef,
    readonly jobId: RemoteJobId,
    readonly reason: 'roster-not-ready' | 'not-found',
  ) {
    super(`Job "${String(jobId)}" cannot be killed from this Session roster: ${reason}`)
  }
}

interface ActiveJobs {
  readonly stream: RemoteStream<JobListFrame>
  task: Promise<void>
}

/** Owns one exact Host/Session Job roster stream and its deterministic cleanup. */
export class RemoteJobSource {
  private readonly listeners = new Set<() => void>()
  private active: ActiveJobs | undefined
  private client: HostClient | undefined
  private generation = 0
  private tail: Promise<void> = Promise.resolve()
  private current: RemoteJobsSnapshot = emptyJobs(0)
  private disposed = false

  /** Return the current whole-roster snapshot. */
  snapshot(): RemoteJobsSnapshot {
    return this.current
  }

  /** Subscribe to roster replacements and terminal stream failures. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Recheck the current exact roster before issuing one official job.kill call. */
  async kill(ref: SessionRef, id: RemoteJobId): Promise<RemoteResult<JobKillValue>> {
    const client = this.client
    const current = this.current
    if (client === undefined || client.key !== ref.host || current.ref?.sessionId !== ref.sessionId || !current.ready || current.error !== undefined) {
      throw new RemoteJobKillRejectedError(ref, id, 'roster-not-ready')
    }
    if (!current.jobs.some(job => job.id === id)) throw new RemoteJobKillRejectedError(ref, id, 'not-found')
    return client.remote.job.kill({ sessionId: ref.sessionId, jobId: id })
  }

  /** Replace the watched Host/Session after closing the prior official job.list stream. */
  attach(client: HostClient | null, ref?: SessionRef): Promise<void> {
    if (client !== null && (ref === undefined || client.key !== ref.host)) {
      throw new Error('Job source Host Client and SessionRef must identify the same Host')
    }
    const generation = ++this.generation
    const previous = this.active
    this.active = undefined
    this.client = client ?? undefined
    this.current = emptyJobs(generation, ref)
    this.publish()
    const operation = this.tail.then(async () => {
      await closeJobs(previous)
      if (this.disposed || generation !== this.generation || client === null || ref === undefined) return
      const name = `mayfly jobs ${String(ref.sessionId)}`
      const stream = client.remote.$stream<JobListFrame>({
        name,
        open: signal => client.remote.job.list({ sessionId: ref.sessionId }, signal),
        ended: accepted => accepted
          ? new RemoteStreamCarrierError(`${name} ended before release`)
          : new Error(`${name} ended before its first frame`),
      })
      const active: ActiveJobs = { stream, task: Promise.resolve() }
      active.task = this.consume(active, stream, ref, generation)
      this.active = active
      this.current = { ref, jobs: [], ready: false, streaming: true, generation }
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
    this.client = undefined
    const previous = this.active
    this.active = undefined
    const operation = this.tail.then(() => closeJobs(previous))
    this.tail = operation.then(() => undefined, () => undefined)
    await operation
    this.listeners.clear()
  }

  private async consume(
    active: ActiveJobs,
    stream: RemoteStream<JobListFrame>,
    ref: SessionRef,
    generation: number,
  ): Promise<void> {
    try {
      for await (const item of stream) {
        if (this.disposed || generation !== this.generation || this.active !== active) return
        this.current = { ref, jobs: item.value.jobs, ready: true, streaming: true, generation }
        this.publish()
        item.accept()
      }
    } catch (error) {
      if (this.disposed || generation !== this.generation || this.active !== active) return
      this.current = { ref, jobs: [], ready: false, streaming: false, generation, error }
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

async function closeJobs(active: ActiveJobs | undefined): Promise<void> {
  if (active === undefined) return
  await active.stream.dispose()
  await active.task
}

function emptyJobs(generation: number, ref?: SessionRef): RemoteJobsSnapshot {
  return { ref, jobs: [], ready: false, streaming: false, generation }
}
