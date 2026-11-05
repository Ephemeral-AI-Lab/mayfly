/** Native snapshot-stream protocol and exact Workflow owner retirement. @module */
import { RemoteStream, type RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostKey, type HostClient, type SessionRef } from '../../src/client/types.ts'
import { createMayflyWorkflowStreamOptions, RemoteWorkflowSource } from '../../src/hosts/workflow.ts'

type Baseline = { readonly type: 'baseline', readonly value: string }
type Frame = { readonly type: 'replacement', readonly value: string }
type WireValue = Baseline | Frame
interface Channel {
  readonly signal: AbortSignal
  emit(value: WireValue): void
  end(): void
  fail(error: unknown): void
  closing?: Promise<void>
  closed: boolean
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const flush = async (): Promise<void> => { await new Promise<void>(resolve => setImmediate(resolve)) }
const baseline = (value = 'opening'): Baseline => ({ type: 'baseline', value })
const replacement = (value = 'replacement'): Frame => ({ type: 'replacement', value })

/** Only the native wire and an optional delivery scheduling boundary are controlled. */
function fixture() {
  const source = new RemoteWorkflowSource<Baseline, Frame>()
  cleanups.push(() => source.dispose())
  const channels: Channel[] = []
  const delivery: { beforeValue?: () => void, beforeError?: () => void } = {}
  const open = vi.fn((signal: AbortSignal) => ({
    async *[Symbol.asyncIterator]() {
      const queue: WireValue[] = []
      let failure: { readonly error: unknown } | undefined
      let ended = false
      let wake = (): void => {}
      const channel: Channel = {
        signal, closed: false,
        emit: value => { queue.push(value); wake() },
        end: () => { ended = true; wake() },
        fail: error => { failure = { error }; wake() },
      }
      channels.push(channel)
      const aborted = (): void => { wake() }
      signal.addEventListener('abort', aborted)
      try {
        while (!signal.aborted) {
          if (queue.length === 0 && failure === undefined && !ended) await new Promise<void>(resolve => { wake = resolve })
          if (signal.aborted) return
          if (failure !== undefined) throw failure.error
          if (ended) return
          while (queue.length > 0) yield queue.shift()!
        }
      } finally {
        signal.removeEventListener('abort', aborted)
        await channel.closing
        channel.closed = true
      }
    },
  }))
  const stream = vi.fn((options: RemoteStreamOptions<WireValue>) => {
    const physical = new RemoteStream<WireValue>({ generation: { getSnapshot: () => 1 } } as never, options)
    const consume = physical[Symbol.asyncIterator].bind(physical)
    physical[Symbol.asyncIterator] = () => {
      const native = consume()
      return {
        async next() {
          let item: Awaited<ReturnType<typeof native.next>>
          try { item = await native.next() } catch (error) {
            delivery.beforeError?.()
            throw error
          }
          if (!item.done) delivery.beforeValue?.()
          return item
        },
        return: value => native.return!(value),
        throw: error => native.throw!(error),
        [Symbol.asyncIterator]() { return this },
      }
    }
    return physical
  })
  const client = { key: HostKey('workflow-owner'), remote: { $stream: stream } } as unknown as HostClient
  const ref: SessionRef = { host: client.key, sessionId: SessionId('workflow-session') }
  const options = { name: 'owned workflow', open, isBaseline: (value: WireValue): value is Baseline => value.type === 'baseline' }
  const attach = () => source.attach(client, ref, options)
  return { source, channels, delivery, open, stream, client, ref, options, attach }
}

describe('RemoteWorkflowSource official snapshot lifecycle', () => {
  it('requires complete exact-Host attachment tuples without changing its snapshot on refusal', async () => {
    const f = fixture()
    const initial = f.source.snapshot()
    expect(initial).toEqual({ ref: undefined, generation: 0, baseline: undefined, frame: undefined, streaming: false })
    expect(() => f.source.attach(f.client, undefined, f.options)).toThrow('either a Client')
    expect(() => f.source.attach(null, f.ref, undefined)).toThrow('either a Client')
    expect(() => f.source.attach(null, undefined, f.options)).toThrow('either a Client')
    expect(() => f.source.attach(f.client, { ...f.ref, host: HostKey('foreign') }, f.options)).toThrow('same Host')
    expect(f.source.snapshot()).toBe(initial)
    expect(f.stream).not.toHaveBeenCalled()
    await f.source.attach(null, undefined, undefined)
    f.source.restart()
    expect(f.source.snapshot()).toEqual({ ...initial, generation: 1 })
  })

  it('publishes native whole replacements, unsubscribes, and replaces the baseline after a physical restart', async () => {
    const f = fixture()
    const states: ReturnType<typeof f.source.snapshot>[] = []
    const remove = f.source.subscribe(() => { states.push(f.source.snapshot()) })
    await f.attach()
    const first = f.channels[0]!
    expect(f.source.snapshot()).toMatchObject({ ref: f.ref, streaming: true, generation: 1 })
    first.emit(baseline()); await flush()
    const opening = f.source.snapshot()
    expect(opening.baseline).toEqual(baseline())
    first.emit(replacement('whole second')); await flush()
    expect(f.source.snapshot()).toEqual({ ref: f.ref, generation: 1, baseline: baseline(), frame: replacement('whole second'), streaming: true })
    expect(opening.frame).toEqual(baseline())

    const retained = f.source.snapshot()
    f.source.restart()
    expect(f.source.snapshot()).toBe(retained)
    await flush()
    expect(first.signal.aborted).toBe(true)
    expect(first.closed).toBe(true)
    const second = f.channels[1]!
    second.emit(baseline('fresh baseline')); await flush()
    expect(f.source.snapshot()).toEqual({ ref: f.ref, generation: 1, baseline: baseline('fresh baseline'), frame: baseline('fresh baseline'), streaming: true })
    const count = states.length
    remove(); remove()
    second.emit(replacement('after unsubscribe')); await flush()
    expect(states).toHaveLength(count)
    expect(f.source.snapshot().frame).toEqual(replacement('after unsubscribe'))
    await f.source.attach(null, undefined, undefined)
    expect(second.signal.aborted).toBe(true)
    expect(second.closed).toBe(true)
    expect(f.source.snapshot()).toEqual({ ref: undefined, generation: 2, baseline: undefined, frame: undefined, streaming: false })
  })

  it('rejects updates before the opening native baseline and retains its last whole frame on terminal failure', async () => {
    const f = fixture()
    await f.attach()
    f.channels[0]!.emit(replacement('premature')); await flush()
    expect(f.source.snapshot()).toMatchObject({ baseline: undefined, frame: undefined, streaming: false, error: expect.objectContaining({ message: expect.stringContaining('update before its opening snapshot') }) })
    await f.attach()
    f.channels[1]!.emit(baseline('valid')); await flush()
    f.channels[1]!.emit(replacement('last accepted')); await flush()
    f.channels[1]!.fail(new Error('native rejected')); await flush()
    expect(f.source.snapshot()).toMatchObject({ baseline: baseline('valid'), frame: replacement('last accepted'), streaming: false, error: expect.objectContaining({ message: 'native rejected' }) })
  })

  it('classifies an end before baseline as terminal and retries an accepted physical generation', async () => {
    const f = fixture()
    await f.attach()
    f.channels[0]!.end(); await flush()
    expect(f.source.snapshot()).toMatchObject({ streaming: false, error: expect.objectContaining({ message: 'owned workflow ended before its opening baseline' }) })
    await f.attach()
    f.channels[1]!.emit(baseline()); await flush()
    f.channels[1]!.end(); await flush()
    expect(f.channels).toHaveLength(3)
    expect(f.source.snapshot()).toMatchObject({ frame: baseline(), streaming: true })
    expect(f.source.snapshot().error).toBeUndefined()
    f.channels[2]!.emit(baseline('reconnected')); await flush()
    expect(f.source.snapshot().frame).toEqual(baseline('reconnected'))
  })

  it.each(['baseline', 'replacement', 'failure'] as const)('fences a queued %s callback after its exact owner is retired', async kind => {
    const f = fixture()
    await f.attach()
    if (kind !== 'baseline') { f.channels[0]!.emit(baseline()); await flush() }
    let retired!: Promise<void>
    const retire = (): void => {
      delete f.delivery.beforeValue
      delete f.delivery.beforeError
      retired = f.source.attach(null, undefined, undefined)
    }
    if (kind === 'failure') {
      // The Host error has crossed the carrier, then selection changes before
      // the native Snapshot consumer receives its already rejected next().
      f.delivery.beforeError = () => { queueMicrotask(retire) }
      f.channels[0]!.fail(new Error('obsolete failure'))
    } else {
      f.delivery.beforeValue = retire
      f.channels[0]!.emit(kind === 'baseline' ? baseline('obsolete baseline') : replacement('obsolete replacement'))
    }
    await flush(); await retired
    expect(f.source.snapshot()).toEqual({ ref: undefined, generation: 2, baseline: undefined, frame: undefined, streaming: false })
    expect(f.channels[0]!.closed).toBe(true)
  })

  it('serializes replacement cleanup and skips generations superseded before they can acquire a stream', async () => {
    const f = fixture()
    const superseded = f.attach()
    const selected = f.attach()
    await Promise.all([superseded, selected])
    expect(f.stream).toHaveBeenCalledOnce()
    expect(f.source.snapshot().generation).toBe(2)
    const closing = Promise.withResolvers<void>()
    f.channels[0]!.closing = closing.promise
    const replacing = f.attach()
    const last = f.attach()
    await flush()
    expect(f.channels[0]!.signal.aborted).toBe(true)
    expect(f.channels[0]!.closed).toBe(false)
    expect(f.stream).toHaveBeenCalledOnce()
    closing.resolve()
    await Promise.all([replacing, last])
    expect(f.channels[0]!.closed).toBe(true)
    expect(f.stream).toHaveBeenCalledTimes(2)
    expect(f.source.snapshot().generation).toBe(4)
  })

  it('retires queued acquisitions on disposal and waits for repeated disposal to drain the current owner', async () => {
    const f = fixture()
    await f.attach()
    const closing = Promise.withResolvers<void>()
    f.channels[0]!.closing = closing.promise
    const replacing = f.attach()
    let drained = false
    const disposing = f.source.dispose().then(() => { drained = true })
    const repeated = f.source.dispose()
    await flush()
    expect(drained).toBe(false)
    expect(f.channels[0]!.signal.aborted).toBe(true)
    closing.resolve()
    await Promise.all([replacing, disposing, repeated])
    expect(drained).toBe(true)
    expect(f.stream).toHaveBeenCalledOnce()
    f.source.restart()
  })

  it('keeps a disposed source inert under queued attachment and subscription callbacks', async () => {
    const f = fixture()
    const listener = vi.fn()
    f.source.subscribe(listener)
    await f.attach()
    await f.source.dispose()
    const retired = f.source.snapshot()
    const count = listener.mock.calls.length
    const late = vi.fn()
    const remove = f.source.subscribe(late)
    await f.attach()
    remove()
    expect(f.source.snapshot()).toBe(retired)
    expect(listener).toHaveBeenCalledTimes(count)
    expect(late).not.toHaveBeenCalled()
    expect(f.stream).toHaveBeenCalledOnce()
  })

  it('surfaces a failed native consumer drain and keeps repeated disposal quiescent', async () => {
    const f = fixture()
    const failure = new Error('observer failed during native error publication')
    let drained!: Promise<unknown>
    f.source.subscribe(() => {
      if (f.source.snapshot().error === undefined) return
      drained = f.source.dispose().catch(error => error)
      throw failure
    })
    await f.attach()
    f.channels[0]!.fail(new Error('native stream failed'))
    await flush()
    await expect(drained).resolves.toBe(failure)
    await expect(f.source.dispose()).resolves.toBeUndefined()
    expect(f.channels[0]!.closed).toBe(true)
  })
})

describe('generated Mayfly Workflow stream options', () => {
  it('uses the exact Host namespace, SessionId, signal, and native baseline discriminator', () => {
    const followWorkflow = vi.fn(() => ({ async *[Symbol.asyncIterator]() {} }))
    const client = { key: HostKey('generated-workflow'), remote: { mayflyHost: { followWorkflow } } } as unknown as HostClient
    const ref = { host: client.key, sessionId: SessionId('generated-session') }
    const options = createMayflyWorkflowStreamOptions(client, ref)
    const signal = new AbortController().signal
    const iterable = options.open(signal)
    expect(iterable).toBe(followWorkflow.mock.results[0]!.value)
    expect(followWorkflow).toHaveBeenCalledWith({ sessionId: ref.sessionId }, signal)
    expect(options.name).toBe('mayfly workflow generated-session')
    expect(options.isBaseline({ type: 'baseline', value: { sessionId: ref.sessionId, runs: [] } })).toBe(true)
    expect(options.isBaseline({ type: 'replacement', value: { sessionId: ref.sessionId, runs: [] } })).toBe(false)
    expect(() => createMayflyWorkflowStreamOptions(client, { ...ref, host: HostKey('foreign') })).toThrow('same Host')
  })
})
