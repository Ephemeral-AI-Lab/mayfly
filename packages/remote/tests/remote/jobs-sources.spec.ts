/** Native Job roster/follow cursors, exact scope, loss and reader cleanup. @module */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteStream, type RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'
import type { JobFollowFrame, JobView, JobListFrame } from '@deepseek-ai/dsh-api-job-controller/client'
import { HostKey, type HostClient, type SessionRef } from '../../src/client/types.ts'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteJobSource } from '../../src/frontend/jobs.ts'
import { generatedRemoteJobFollowAdapter, RemoteJobFollowReader } from '../../src/remote/features/jobs-follow.ts'

import { channel, flush, job, ref } from './jobs-fixture.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const off of cleanup.splice(0).reverse()) await off(); vi.restoreAllMocks() })

function rosterFixture() {
  const streams: Array<ReturnType<typeof channel<{ value: JobListFrame, accept: () => void }>> & { dispose: ReturnType<typeof vi.fn<() => Promise<void>>> }> = []
  const descriptions: RemoteStreamOptions<JobListFrame>[] = []
  const kill = vi.fn(async () => ({ ok: true as const, value: { outcome: 'stopping' as const } }))
  const list = vi.fn(() => ({ [Symbol.asyncIterator]: async function* () { yield { type: 'rows', jobs: [] } } }))
  const client = { key: ref.host, remote: { job: { kill, list }, $stream: vi.fn((options: RemoteStreamOptions<JobListFrame>) => {
    descriptions.push(options)
    const queue = channel<{ value: JobListFrame, accept: () => void }>()
    const stream = { ...queue, dispose: vi.fn(async () => { queue.end() }) }
    streams.push(stream)
    return stream
  }) } } as unknown as HostClient
  const source = new RemoteJobSource()
  cleanup.push(() => source.dispose())
  return { source, client, streams, descriptions, kill, list }
}

describe('native selected-session Job roster', () => {
  it('accepts whole snapshots, preserves native kill outcomes and rejects every wrong/unready scope', async () => {
    const f = rosterFixture()
    const changed = vi.fn(); const off = f.source.subscribe(changed)
    expect(f.source.snapshot()).toMatchObject({ ready: false, streaming: false, jobs: [] })
    await expect(f.source.kill(ref, job().id)).rejects.toMatchObject({ reason: 'roster-not-ready' })
    expect(() => f.source.attach(f.client)).toThrow('same Host')
    expect(() => f.source.attach(f.client, { ...ref, host: HostKey('other') })).toThrow('same Host')
    await f.source.attach(f.client, ref)
    await expect(f.source.kill(ref, job().id)).rejects.toMatchObject({ reason: 'roster-not-ready' })
    const accept = vi.fn()
    f.streams[0]!.push({ value: { type: 'rows', jobs: [job()] }, accept }); await flush()
    expect(accept).toHaveBeenCalledOnce()
    expect(f.source.snapshot()).toMatchObject({ jobs: [job()], ready: true, streaming: true, ref })
    await expect(f.source.kill({ ...ref, host: HostKey('other') }, job().id)).rejects.toMatchObject({ reason: 'roster-not-ready' })
    await expect(f.source.kill({ ...ref, sessionId: SessionId('other') }, job().id)).rejects.toMatchObject({ reason: 'roster-not-ready' })
    await expect(f.source.kill(ref, 'absent' as JobView['id'])).rejects.toMatchObject({ reason: 'not-found' })
    expect(await f.source.kill(ref, job().id)).toEqual({ ok: true, value: { outcome: 'stopping' } })
    expect(f.kill).toHaveBeenCalledWith({ sessionId: ref.sessionId, jobId: job().id })
    f.kill.mockResolvedValueOnce({ ok: false, error: { code: 'denied', message: 'Host denied' } } as never)
    expect(await f.source.kill(ref, job().id)).toMatchObject({ ok: false, error: { message: 'Host denied' } })
    f.streams[0]!.push({ value: { type: 'rows', jobs: [] }, accept }); await flush()
    expect(f.source.snapshot().jobs).toEqual([])
    off(); const calls = changed.mock.calls.length
    await f.source.attach(null)
    expect(changed).toHaveBeenCalledTimes(calls)
    expect(f.streams[0]!.dispose).toHaveBeenCalled()
  })

  it('exposes errors, fences late frames/failures after replacement and quiesces repeated unload', async () => {
    const f = rosterFixture()
    await f.source.attach(f.client, ref)
    f.streams[0]!.fail('wire failed'); await flush()
    expect(f.source.snapshot()).toMatchObject({ streaming: false, ready: false, error: 'wire failed' })
    await expect(f.source.kill(ref, job().id)).rejects.toMatchObject({ reason: 'roster-not-ready' })
    await f.source.attach(f.client, ref)
    const stale = f.streams[1]!
    const replacement = f.source.attach(null)
    const accepted = vi.fn()
    stale.push({ value: { type: 'rows', jobs: [job()] }, accept: accepted }); await replacement; await flush()
    expect(accepted).not.toHaveBeenCalled()
    expect(f.source.snapshot().jobs).toEqual([])
    await f.source.attach(f.client, ref)
    const failing = f.streams[2]!
    const removed = f.source.attach(null)
    failing.fail('late failure'); await removed; await flush()
    expect(f.source.snapshot().error).toBeUndefined()
    const first = f.source.attach(f.client, ref)
    const second = f.source.attach(null)
    await Promise.all([first, second])
    const last = f.source.attach(f.client, ref)
    await f.source.dispose(); await last; await f.source.dispose()
    expect(f.source.snapshot().jobs).toEqual([])
  })

  it('propagates stream construction failure without poisoning subsequent attach', async () => {
    const f = rosterFixture()
    vi.mocked(f.client.remote.$stream).mockImplementationOnce(() => { throw new Error('cannot open roster') })
    await expect(f.source.attach(f.client, ref)).rejects.toThrow('cannot open roster')
    await f.source.attach(f.client, ref)
    expect(f.source.snapshot().streaming).toBe(true)
    for (const accepted of [false, true]) expect(f.descriptions[0]!.ended!(accepted)).toBeInstanceOf(Error)
    f.descriptions[0]!.open(new AbortController().signal)
    expect(f.list).toHaveBeenCalledWith({ sessionId: ref.sessionId }, expect.any(AbortSignal))
  })

  it('surfaces a roster-disposal failure and leaves its cleanup tail settled for repeated unload', async () => {
    const f = rosterFixture()
    await f.source.attach(f.client, ref)
    const active = f.streams[0]!
    active.dispose.mockImplementationOnce(async () => { active.end(); throw new Error('cannot close roster') })
    await expect(f.source.dispose()).rejects.toThrow('cannot close roster')
    await f.source.dispose()
  })

  it('consumes the real official RemoteStream and aborts its native iterator on detach', async () => {
    const f = rosterFixture()
    const native = channel<JobListFrame>()
    vi.mocked(f.client.remote.job.list).mockImplementationOnce((_request, signal) => {
      signal!.addEventListener('abort', () => native.end(), { once: true })
      return native as never
    })
    vi.mocked(f.client.remote.$stream).mockImplementationOnce(options => new RemoteStream({ generation: { getSnapshot: () => 1, subscribe: () => () => {} } } as never, options))
    await f.source.attach(f.client, ref)
    native.push({ type: 'rows', jobs: [job()] }); await flush()
    expect(f.source.snapshot().jobs).toEqual([job()])
    await f.source.attach(null)
    expect(f.source.snapshot().ready).toBe(false)
  })
})

function readerFixture(status: JobView['status'] = 'running') {
  const queues: Array<ReturnType<typeof channel<JobFollowFrame>> & { dispose?: unknown }> = []
  const changed = vi.fn()
  const open = vi.fn((_client: HostClient, _ref: SessionRef, _id: JobView['id'], _from: number | undefined, _signal: AbortSignal) => {
    const queue = channel<JobFollowFrame>(); queues.push(queue); return queue
  })
  const client = { key: ref.host, remote: { job: { follow: vi.fn() } } } as unknown as HostClient
  const reader = new RemoteJobFollowReader(client, ref, job({ status }), changed, { open })
  cleanup.push(async () => { for (const queue of queues) queue.end(); await reader.dispose() })
  return { reader, changed, client, open, queues }
}

describe('native Job output reader', () => {
  it('passes exact native follow addresses and resumes from the accepted absolute cursor', async () => {
    const f = readerFixture()
    expect(f.reader.matches(f.client, ref)).toBe(true)
    expect(f.reader.matches({ ...f.client }, ref)).toBe(false)
    expect(f.reader.matches(f.client, { ...ref, host: HostKey('other') })).toBe(false)
    expect(f.reader.matches(f.client, { ...ref, sessionId: SessionId('other') })).toBe(false)
    for (const from of [undefined, 10]) generatedRemoteJobFollowAdapter.open(f.client, ref, job().id, from, new AbortController().signal)
    expect(f.client.remote.job.follow).toHaveBeenNthCalledWith(1, { sessionId: ref.sessionId, jobId: job().id }, expect.any(AbortSignal))
    expect(f.client.remote.job.follow).toHaveBeenNthCalledWith(2, { sessionId: ref.sessionId, jobId: job().id, from: 10 }, expect.any(AbortSignal))
    f.reader.start()
    const queue = f.queues[0]!
    queue.push({ type: 'opened', job: job(), from: 0 })
    queue.push({ type: 'output', next: 5, chunks: [{ at: 0, text: 'hello' }] }); await flush()
    expect(f.reader.snapshot()).toMatchObject({ text: 'hello', cursor: 5, dropped: false, streaming: true })
    f.reader.start()
    expect(f.open.mock.calls[1]![3]).toBe(5)
    queue.push({ type: 'output', next: 99, chunks: [{ at: 5, text: 'late' }] }); queue.end(); await flush()
    const next = f.queues[1]!
    next.push({ type: 'opened', job: job(), from: 5 })
    next.push({ type: 'output', next: 10, chunks: [{ at: 0, text: 'duplicate' }, { at: 5, text: 'world' }] })
    next.push({ type: 'status', job: job({ status: 'completed' }) }); next.end(); await flush()
    expect(f.reader.snapshot()).toMatchObject({ text: 'helloworld', cursor: 10, streaming: false, error: undefined, job: { status: 'completed' } })
    await f.reader.dispose(); await f.reader.dispose(); f.reader.start()
    expect(f.open).toHaveBeenCalledTimes(2)
  })

  it('marks retention gaps, lossy chunks, opening floors and bounded UTF-16-safe tails', async () => {
    for (const head of [0, 5]) {
      const f = readerFixture()
      f.reader.start(); const queue = f.queues[0]!
      queue.push({ type: 'opened', job: job({ output: { earliest: 2, total: 5 } }), from: head }); await flush()
      expect(f.reader.snapshot().dropped).toBe(true)
    }
    for (const frame of [
      { type: 'output', next: 1, chunks: [{ at: 0, text: 'gap', gapBefore: true }] },
      { type: 'output', next: 1, chunks: [{ at: 0, text: 'loss' }], lossy: true },
      ...['x'.repeat(131_073), 'x😀' + 'x'.repeat(131_071), '😀' + 'x'.repeat(131_072)].map(text => ({ type: 'output', next: text.length, chunks: [{ at: 0, text }] })),
    ] as JobFollowFrame[]) {
      const f = readerFixture(); f.reader.start()
      f.queues[0]!.push(frame); await flush()
      const state = f.reader.snapshot()
      expect(state.dropped).toBe(true); expect(state.text.length).toBeLessThanOrEqual(131_072)
      expect(state.text.charCodeAt(0) >= 0xDC00 && state.text.charCodeAt(0) <= 0xDFFF).toBe(false)
    }
  })

  it.each(['running', 'stopping'] as const)('reports premature %s termination and textual transport failures', async status => {
    const f = readerFixture(status); f.reader.start(); f.queues[0]!.end(); await flush()
    expect(f.reader.snapshot().error).toContain('ended before a terminal status')
    for (const failure of [new Error('lost output'), 'lost output']) {
      f.reader.start(); f.queues.at(-1)!.fail(failure); await flush()
      expect(f.reader.snapshot()).toMatchObject({ streaming: false, error: 'lost output' })
    }
  })

  it('disposes optional native streams, ignores stale failures, and fences late frames after unload', async () => {
    const f = readerFixture(); f.reader.start()
    const first = f.queues[0]!
    f.reader.start(); first.fail(new Error('retired error')); await flush()
    expect(f.reader.snapshot().error).toBeUndefined()
    const active = f.queues[1]!
    const dispose = vi.fn(async () => {}); active.dispose = dispose
    const ending = f.reader.dispose()
    active.push({ type: 'status', job: job({ status: 'failed' }) }); active.end(); await ending
    expect(dispose).toHaveBeenCalledOnce()
    expect(f.reader.snapshot().job.status).toBe('running')
    const other = readerFixture(); other.reader.start(); other.queues[0]!.dispose = 1; other.queues[0]!.end(); await flush()
    const failed = readerFixture(); failed.reader.start(); const stopping = failed.reader.dispose(); failed.queues[0]!.fail('after unload'); await stopping
    expect(failed.reader.snapshot().error).toBeUndefined()
  })
})
