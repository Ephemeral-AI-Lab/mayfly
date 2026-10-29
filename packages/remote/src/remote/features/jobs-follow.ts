/**
 * Narrow job.follow adapter and one output reader's cursor-owned presentation state.
 * @module @ephemeral-ai/mayfly/remote/features/jobs-follow
 */

import type { HostClient, SessionRef } from '../../client/types.ts'
import type { JobFollowFrame, JobView } from './official.ts'

/** Exact generated job.follow opener; a Domain follow adapter can replace this seam without changing panels. */
export interface RemoteJobFollowAdapter {
  open(client: HostClient, ref: SessionRef, id: JobView['id'], from: number | undefined, signal: AbortSignal): AsyncIterable<JobFollowFrame>
}

/** Direct generated adapter; it owns no roster or long-lived Job store. */
export const generatedRemoteJobFollowAdapter: RemoteJobFollowAdapter = {
  open: (client, ref, id, from, signal) => client.remote.job.follow({
    sessionId: ref.sessionId,
    jobId: id,
    ...from === undefined ? {} : { from },
  }, signal),
}

/** Current reader state; text is bounded presentation data, not a second Job registry. */
export interface RemoteJobReaderSnapshot {
  readonly job: JobView
  readonly text: string
  readonly dropped: boolean
  readonly streaming: boolean
  readonly cursor: number
  readonly error?: string | undefined
}

const RENDER_TAIL_LIMIT = 128 * 1024

/** Follow one Job with absolute output offsets, loss markers, and terminal status. */
export class RemoteJobFollowReader {
  private controller: AbortController | undefined
  private task: Promise<void> | undefined
  private generation = 0
  private current: RemoteJobReaderSnapshot
  private disposed = false

  constructor(
    private readonly client: HostClient,
    private readonly ref: SessionRef,
    job: JobView,
    private readonly changed: () => void,
    private readonly adapter: RemoteJobFollowAdapter = generatedRemoteJobFollowAdapter,
  ) {
    this.current = { job, text: '', dropped: false, streaming: false, cursor: 0 }
  }

  /** Return the current immutable reader snapshot. */
  snapshot(): RemoteJobReaderSnapshot {
    return this.current
  }

  /** Whether this reader still belongs to the exact Host and Session generation. */
  matches(client: HostClient, ref: SessionRef): boolean {
    return this.client === client && this.ref.host === ref.host && this.ref.sessionId === ref.sessionId
  }

  /** Start a fresh observation or resume a reconnect from the accepted cursor. */
  start(): void {
    if (this.disposed) return
    const generation = ++this.generation
    this.controller?.abort(new Error('Job output generation replaced'))
    const controller = new AbortController()
    this.controller = controller
    this.current = { ...this.current, streaming: true, error: undefined }
    this.changed()
    const task = this.consume(controller, generation)
    this.task = task
    void task.finally(() => {
      if (this.task === task) this.task = undefined
    })
  }

  /** Stop only observation; the Host Job continues running. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.generation += 1
    this.controller?.abort(new Error('Job output reader closed'))
    this.controller = undefined
    await this.task
  }

  private async consume(controller: AbortController, generation: number): Promise<void> {
    const cursor = this.current.cursor
    try {
      const stream = this.adapter.open(this.client, this.ref, this.current.job.id, cursor === 0 ? undefined : cursor, controller.signal)
      try {
        for await (const frame of stream) {
          if (this.disposed || generation !== this.generation || controller.signal.aborted) return
          this.accept(frame)
        }
      } finally {
        if ('dispose' in stream && typeof stream.dispose === 'function') await stream.dispose()
      }
      if (!this.disposed && generation === this.generation) {
        const terminal = this.current.job.status !== 'running' && this.current.job.status !== 'stopping'
        this.current = {
          ...this.current,
          streaming: false,
          ...terminal ? {} : { error: 'Job output stream ended before a terminal status' },
        }
        this.changed()
      }
    } catch (error) {
      if (this.disposed || generation !== this.generation || controller.signal.aborted) return
      this.current = { ...this.current, streaming: false, error: error instanceof Error ? error.message : String(error) }
      this.changed()
    }
  }

  private accept(frame: JobFollowFrame): void {
    switch (frame.type) {
      case 'opened': {
        const freshPastHead = this.current.text === '' && frame.from > 0
        this.current = {
          ...this.current,
          job: frame.job,
          cursor: frame.from,
          dropped: this.current.dropped || frame.from < frame.job.output.earliest || freshPastHead,
          streaming: true,
          error: undefined,
        }
        break
      }
      case 'output': {
        const appended = frame.chunks.filter(chunk => chunk.at >= this.current.cursor).map(chunk => chunk.text).join('')
        let text = this.current.text + appended
        let dropped = this.current.dropped || frame.lossy === true || frame.chunks.some(chunk => chunk.gapBefore === true)
        if (text.length > RENDER_TAIL_LIMIT) {
          let cut = text.length - RENDER_TAIL_LIMIT
          const unit = text.charCodeAt(cut)
          if (unit >= 0xDC00 && unit <= 0xDFFF) cut += 1
          text = text.slice(cut)
          dropped = true
        }
        this.current = { ...this.current, text, dropped, cursor: frame.next }
        break
      }
      case 'status':
        this.current = { ...this.current, job: frame.job, streaming: false, error: undefined }
        break
    }
    this.changed()
  }
}
