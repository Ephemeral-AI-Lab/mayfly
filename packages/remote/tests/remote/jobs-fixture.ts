/** Controlled native Job fixtures shared by source and feature tests. @module */
import type { JobView } from '@deepseek-ai/dsh-api-job-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { HostKey, type SessionRef } from '../../src/client/types.ts'

export const job = (extra: Partial<JobView> = {}): JobView => ({ id: 'job' as JobView['id'], owner: SessionId('session'), kind: 'shell', label: 'Actual build', startedAt: 1_000, status: 'running', output: { earliest: 0, total: 0 }, ...extra })
export const ref: SessionRef = { host: HostKey('one'), sessionId: SessionId('session') }
export const flush = async () => { await new Promise<void>(resolve => setImmediate(resolve)) }

/** A controlled native iterator can deliberately finish, fail, or deliver a late frame. */
export function channel<T>() {
  const queue: T[] = []
  let ended = false
  let failed: { value: unknown } | undefined
  let wake = () => {}
  return {
    push(value: T) { queue.push(value); wake() },
    end() { ended = true; wake() },
    fail(value: unknown) { failed = { value }; wake() },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (queue.length) { yield queue.shift()!; continue }
        if (failed) throw failed.value
        if (ended) return
        await new Promise<void>(resolve => { wake = resolve })
      }
    },
  }
}

