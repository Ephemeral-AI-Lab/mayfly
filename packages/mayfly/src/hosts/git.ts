/**
 * Generation-fenced polling for a Host-owned Git read.
 * @module @ephemeral-ai/mayfly/frontend/git
 */
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { HostClient, SessionRef } from '../client/types.ts'
import type { MayflyGitStatus } from './host-contract.ts'
import { mayflyHostRemote } from './host-mount.ts'

/** One Host Git read; integration supplies the generated mayflyHost method. */
export type RemoteGitRead<Value> = (ref: SessionRef, signal: AbortSignal) => Promise<RemoteResult<Value>>

/** Latest Git read state for one exact Session. */
export interface RemoteGitSnapshot<Value> {
  readonly ref: SessionRef | undefined
  readonly generation: number
  readonly pending: boolean
  readonly result: RemoteResult<Value> | undefined
  readonly error?: unknown
}

interface GitRun {
  readonly generation: number
  readonly promise: Promise<void>
}

/** Poll only the generated Host Git endpoint, never the Frontend's local working directory. */
export class RemoteGitPoller<Value> {
  private readonly listeners = new Set<() => void>()
  private readonly runs = new Set<Promise<void>>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private controller: AbortController | undefined
  private run: GitRun | undefined
  private generation = 0
  private ref: SessionRef | undefined
  private current: RemoteGitSnapshot<Value> = { ref: undefined, generation: 0, pending: false, result: undefined }
  private disposed = false

  /**
   * @param read - generated Host Git read.
   * @param intervalMs - required delay between completed polls.
   */
  constructor(
    private readonly read: RemoteGitRead<Value>,
    private readonly intervalMs: number,
  ) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('Git poll interval must be positive and finite')
  }

  /** Return the latest completed result and current pending state. */
  snapshot(): RemoteGitSnapshot<Value> {
    return this.current
  }

  /** Subscribe to poll start and settlement publications. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Select one Session, aborting the prior selection's poll and late publication. */
  attach(ref: SessionRef | null): void {
    if (this.disposed) return
    const generation = ++this.generation
    this.ref = ref ?? undefined
    this.timer !== undefined && clearTimeout(this.timer)
    this.timer = undefined
    this.controller?.abort(new Error('Git poll selection changed'))
    this.controller = undefined
    this.run = undefined
    this.current = { ref: this.ref, generation, pending: false, result: undefined }
    this.publish()
    if (ref !== null) void this.refresh()
  }

  /** Start one read, sharing only an in-flight read from the same selection generation. */
  refresh(): Promise<void> {
    const ref = this.ref
    const generation = this.generation
    if (this.disposed || ref === undefined) return Promise.resolve()
    if (this.run?.generation === generation) return this.run.promise
    this.timer !== undefined && clearTimeout(this.timer)
    this.timer = undefined
    const controller = new AbortController()
    this.controller = controller
    this.current = { ref, generation, pending: true, result: this.current.result }
    this.publish()
    const promise = Promise.resolve().then(() => this.read(ref, controller.signal)).then(
      (result) => {
        if (!this.owns(ref, generation)) return
        this.current = { ref, generation, pending: false, result }
        this.publish()
      },
      (error: unknown) => {
        if (!this.owns(ref, generation)) return
        this.current = { ref, generation, pending: false, result: undefined, error }
        this.publish()
      },
    ).finally(() => {
      this.runs.delete(promise)
      if (!this.owns(ref, generation)) return
      this.run = undefined
      this.controller = undefined
      this.timer = setTimeout(() => {
        this.timer = undefined
        if (this.owns(ref, generation)) void this.refresh()
      }, this.intervalMs)
    })
    const run = { generation, promise }
    this.run = run
    this.runs.add(promise)
    return promise
  }

  /** Abort the active read, clear the timer, and await all stale continuations. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.generation += 1
    this.ref = undefined
    this.timer !== undefined && clearTimeout(this.timer)
    this.timer = undefined
    this.controller?.abort(new Error('Git poller disposed'))
    this.controller = undefined
    this.run = undefined
    await Promise.allSettled([...this.runs])
    this.listeners.clear()
  }

  private owns(ref: SessionRef, generation: number): boolean {
    return !this.disposed && this.generation === generation && this.ref === ref
  }

  private publish(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

/** Create the official Host Git read consumed by RemoteGitPoller. */
export function createMayflyGitRead(client: HostClient): RemoteGitRead<MayflyGitStatus | null> {
  return (ref, signal) => {
    if (client.key !== ref.host) throw new Error('Git Host Client and SessionRef must identify the same Host')
    return mayflyHostRemote(client).gitStatus({ sessionId: ref.sessionId }, signal)
  }
}
