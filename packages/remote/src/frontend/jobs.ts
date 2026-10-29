/**
 * Selected-Session Job roster, observation, and cancellation through official Client Remote APIs.
 * @module @ephemeral-ai/mayfly/frontend/jobs
 */
import { RemoteStreamCarrierError, type RemoteStream } from '@deepseek-ai/dsh-api-gateway/client'
import type {
  JobFollowFrame, JobKillValue, JobListFrame, JobView, ObservedJob,
} from '@deepseek-ai/dsh-api-job-controller/client'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { HostClient, SessionRef } from '../client/types.ts'

/** Official Job identity used by follow and kill requests. */
export type RemoteJobId = JobView['id']
/** Official render-tail bound used by the Client Job model. */
export const REMOTE_JOB_RENDER_TAIL_LIMIT = 128 * 1024

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

/** Immutable job.follow output, cursor, and settlement state. */
export interface RemoteJobObservationSnapshot extends ObservedJob {
  readonly ref: SessionRef | undefined
  readonly generation: number
  readonly job: JobView | undefined
  readonly cursor: number | undefined
  readonly failure?: unknown
}

interface ActiveObservation {
  readonly stream: RemoteStream<JobFollowFrame>
  task: Promise<void>
  cursor: number | undefined
}

/** Owns one official job.follow stream, including offset resume and loss accounting. */
export class RemoteJobObservationSource {
  private readonly listeners = new Set<() => void>()
  private active: ActiveObservation | undefined
  private generation = 0
  private tail: Promise<void> = Promise.resolve()
  private current: RemoteJobObservationSnapshot | undefined
  private disposed = false

  /** Return the current observation, or undefined before the first attach. */
  snapshot(): RemoteJobObservationSnapshot | undefined {
    return this.current
  }

  /** Subscribe to opening, output, terminal, and failure publications. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Replace the observed Job after closing the prior stream. */
  attach(client: HostClient | null, ref?: SessionRef, id?: RemoteJobId): Promise<void> {
    if (client !== null && (ref === undefined || id === undefined || client.key !== ref.host)) {
      throw new Error('Job observation requires an exact Host Client, SessionRef, and Job id')
    }
    const generation = ++this.generation
    const previous = this.active
    this.active = undefined
    this.current = ref === undefined || id === undefined ? undefined : emptyObservation(ref, id, generation)
    this.publish()
    const operation = this.tail.then(async () => {
      await closeObservation(previous)
      if (this.disposed || generation !== this.generation || client === null || ref === undefined || id === undefined) return
      const name = `mayfly job ${String(id)}`
      const active: ActiveObservation = {
        cursor: undefined,
        task: Promise.resolve(),
        stream: client.remote.$stream<JobFollowFrame>({
          name,
          open: signal => client.remote.job.follow({
            sessionId: ref.sessionId,
            jobId: id,
            ...active.cursor === undefined ? {} : { from: active.cursor },
          }, signal),
          ended: accepted => accepted
            ? new RemoteStreamCarrierError(`${name} ended before settlement`)
            : new Error(`${name} ended before its opening anchor`),
        }),
      }
      active.task = this.consume(active, ref, id, generation)
      this.active = active
    })
    this.tail = operation.then(() => undefined, () => undefined)
    return operation
  }

  /** Stop observation and wait for the iterator and callbacks to settle. */
  async dispose(): Promise<void> {
    if (this.disposed) return await this.tail
    this.disposed = true
    this.generation += 1
    const previous = this.active
    this.active = undefined
    const operation = this.tail.then(() => closeObservation(previous))
    this.tail = operation.then(() => undefined, () => undefined)
    await operation
    this.listeners.clear()
  }

  private async consume(active: ActiveObservation, ref: SessionRef, id: RemoteJobId, generation: number): Promise<void> {
    try {
      for await (const item of active.stream) {
        if (!this.owns(active, generation)) return
        const frame = item.value
        if (frame.type === 'opened') {
          const previous = this.current
          const freshPastHead = (previous === undefined || previous.text === '') && frame.from > 0
          active.cursor = frame.from
          this.current = {
            ref,
            generation,
            jobId: id,
            job: frame.job,
            cursor: frame.from,
            text: previous?.text ?? '',
            gapBefore: (previous?.gapBefore ?? false) || frame.from < frame.job.output.earliest || freshPastHead,
            streaming: true,
          }
          this.publish()
          item.accept()
          continue
        }
        if (frame.type === 'output') {
          const previous = this.current
          if (previous === undefined) continue
          active.cursor = frame.next
          this.current = appendOutput(previous, active, frame)
          this.publish()
          continue
        }
        if (this.current !== undefined) {
          this.current = { ...this.current, job: frame.job, streaming: false }
          this.publish()
        }
        break
      }
    } catch (error) {
      if (!this.owns(active, generation)) return
      const previous = this.current ?? emptyObservation(ref, id, generation)
      this.current = { ...previous, streaming: false, error: String(error), failure: error }
      this.publish()
    } finally {
      if (this.active === active) this.active = undefined
      await active.stream.dispose()
      if (!this.disposed && generation === this.generation && this.current !== undefined) {
        this.current = { ...this.current, streaming: false }
        this.publish()
      }
    }
  }

  private owns(active: ActiveObservation, generation: number): boolean {
    return !this.disposed && this.active === active && this.generation === generation
  }

  private publish(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

function appendOutput(
  previous: RemoteJobObservationSnapshot,
  active: ActiveObservation,
  frame: Extract<JobFollowFrame, { readonly type: 'output' }>,
): RemoteJobObservationSnapshot {
  let text = previous.text + frame.chunks.map(chunk => chunk.text).join('')
  let gapBefore = previous.gapBefore || frame.lossy === true || frame.chunks.some(chunk => chunk.gapBefore === true)
  if (text.length > REMOTE_JOB_RENDER_TAIL_LIMIT) {
    let cut = text.length - REMOTE_JOB_RENDER_TAIL_LIMIT
    const unit = text.charCodeAt(cut)
    if (unit >= 0xDC00 && unit <= 0xDFFF) cut += 1
    text = text.slice(cut)
    gapBefore = true
  }
  return { ...previous, text, gapBefore, cursor: active.cursor }
}

async function closeJobs(active: ActiveJobs | undefined): Promise<void> {
  if (active === undefined) return
  await active.stream.dispose()
  await active.task
}

async function closeObservation(active: ActiveObservation | undefined): Promise<void> {
  if (active === undefined) return
  await active.stream.dispose()
  await active.task
}

function emptyJobs(generation: number, ref?: SessionRef): RemoteJobsSnapshot {
  return { ref, jobs: [], ready: false, streaming: false, generation }
}

function emptyObservation(ref: SessionRef, id: RemoteJobId, generation: number): RemoteJobObservationSnapshot {
  return { ref, generation, jobId: id, job: undefined, cursor: undefined, text: '', gapBefore: false, streaming: true }
}
