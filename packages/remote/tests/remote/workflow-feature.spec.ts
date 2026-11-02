/** Real Workflow stream ownership and renderer height, including empty/error withdrawal. @module */
import { Context } from '@deepseek-ai/cordis'
import { RemoteStream, type RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply as uiProvider } from '@ephemeral-ai/mayfly-ui/provider'
import { compileMayflyUiNode, visibleWidth } from '@ephemeral-ai/mayfly/core'
import * as frontend from '@ephemeral-ai/mayfly/frontend'
import type { MayflyUiEvent, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostKey, type HostClient } from '../../src/client/types.ts'
import type { MayflyWorkflowFrame, MayflyWorkflowRun, MayflyWorkflowSnapshot } from '../../src/frontend/host-contract.ts'
import { RemoteWorkflowSource } from '../../src/frontend/workflow.ts'
import type { RemoteFeatureContext, RemoteFeatureSelection } from '../../src/remote/features.ts'
import { mountWorkflowFeature } from '../../src/remote/features/workflow.ts'
import { remoteWorkflowNode } from '../../src/remote/panels/workflow.ts'
import { fakeMayflyComponents, plain, plainColors } from './render-fixture.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of cleanups.splice(0).reverse()) await dispose()
  vi.restoreAllMocks()
  vi.useRealTimers()
})
const flush = async (): Promise<void> => { await new Promise<void>(resolve => setImmediate(resolve)) }
const t = (key: string, values?: Readonly<Record<string, string | number>>): string => key.replace(/\{(\w+)\}/gu, (_match, name: string) => String(values?.[name] ?? `{${name}}`))
const sessionId = SessionId('workflow-parent')
const snapshot = (runs: readonly MayflyWorkflowRun[] = []): MayflyWorkflowSnapshot => ({ sessionId, runs })
const run = (extra: Partial<MayflyWorkflowRun> = {}): MayflyWorkflowRun => ({ id: 'run', name: 'Review', phasesSeen: [], agents: [], startedAt: 1_000, ...extra })
const frame = (runs: readonly MayflyWorkflowRun[] = [], type: MayflyWorkflowFrame['type'] = 'baseline'): MayflyWorkflowFrame => ({ type, value: snapshot(runs) })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

/** Only the native Host wire boundary is doubled; RemoteStream and RemoteSnapshotStream are real. */
function wire() {
  const channels = new Set<{ emit: (value: MayflyWorkflowFrame) => void, fail: (error: unknown) => void }>()
  const signals: AbortSignal[] = []
  const follow = vi.fn((_request: unknown, signal: AbortSignal) => {
    signals.push(signal)
    return {
      async *[Symbol.asyncIterator]() {
        const queue: MayflyWorkflowFrame[] = []
        let failure: { error: unknown } | undefined
        let wake = (): void => {}
        const channel = {
          emit: (value: MayflyWorkflowFrame): void => { queue.push(value); wake() },
          fail: (error: unknown): void => { failure = { error }; wake() },
        }
        const aborted = (): void => { wake() }
        channels.add(channel)
        signal.addEventListener('abort', aborted)
        try {
          while (!signal.aborted) {
            if (queue.length === 0 && failure === undefined) await new Promise<void>(resolve => { wake = resolve })
            if (signal.aborted) return
            if (failure !== undefined) throw failure.error
            while (queue.length > 0) yield queue.shift()!
          }
        } finally {
          channels.delete(channel)
          signal.removeEventListener('abort', aborted)
        }
      },
    }
  })
  return {
    follow, signals, channels,
    emit: (value: MayflyWorkflowFrame): void => { for (const channel of channels) channel.emit(value) },
    fail: (error: unknown): void => { for (const channel of channels) channel.fail(error) },
  }
}

async function fixture({ selected = true, capable = true } = {}) {
  const ctx = new Context()
  const provider = await ctx.plugin({ name: 'workflow-test-ui', apply: uiProvider })
  const front = await ctx.plugin(frontend)
  const topology = new Set<() => void>()
  const states = new Set<() => void>()
  const state = { generation: 1 }
  const native = wire()
  const capabilities = vi.fn(async (): Promise<{ ok: true, value: { features: string[] } }> => ({ ok: true, value: { features: capable ? ['followWorkflow'] : [] } }))
  const streams = vi.fn(<T>(options: RemoteStreamOptions<T>) => new RemoteStream<T>({ generation: { getSnapshot: () => state.generation, subscribe: () => () => {} } } as never, options))
  const client = {
    key: HostKey('workflow-host'),
    state: {
      getSnapshot: () => state,
      subscribe: (listener: () => void) => { states.add(listener); return () => { states.delete(listener) } },
    },
    remote: { $stream: streams, mayflyHost: { capabilities, followWorkflow: native.follow } },
  } as unknown as HostClient
  const selection = { ref: { host: client.key, sessionId }, client, binding: {} } as RemoteFeatureSelection
  let current: RemoteFeatureSelection | undefined = selected ? selection : undefined
  const options = {
    ctx, components: fakeMayflyComponents(), colors: plainColors(),
    hosts: {
      list: () => [client], current: () => current,
      subscribe: (listener: () => void) => { topology.add(listener); return () => { topology.delete(listener) } },
    }, notice: { set: vi.fn() },
  } as unknown as RemoteFeatureContext
  const registration = vi.spyOn(ctx.mayflyPanes, 'register')
  const dispose = mountWorkflowFeature(options)
  cleanups.push(async () => { dispose(); await flush(); await front.dispose(); await provider.dispose(); await ctx.fiber.dispose() })
  const node = (): MayflyUiNode | null => ctx.mayflyPanes.list().find(pane => pane.id === 'mayfly.pane.workflow')?.node ?? null
  const render = (value: MayflyUiNode | null, width = 80): string[] => {
    if (value === null) return []
    const result = compileMayflyUiNode(value, { components: options.components, colors: options.colors, getViewport: () => ({ columns: width, rows: 24 }), screenMode: 'alternate', emit: () => {} })
    if (!result.ok) throw new Error(result.message)
    return plain(result.value.component.render(width))
  }
  const dispatch = async (event: MayflyUiEvent): Promise<void> => {
    const entry = ctx.mayflyPanes.list().find(pane => pane.id === 'mayfly.pane.workflow')!
    const prepared = await entry.events.prepare(event, { surfaceId: entry.id, source: entry.source, revision: entry.revision, operationId: 'workflow-test', signal: new AbortController().signal, report: () => {} })
    prepared.publish()
  }
  const refresh = (): Promise<void> => dispatch({ kind: 'activate', controlId: 'workflow-actions', actionId: 'workflow-refresh', pagePath: [] })
  await flush()
  return {
    ctx, native, capabilities, streams, state, options, dispose, node, render, dispatch, refresh, registration,
    rows: (width = 80) => render(node(), width),
    select: (value: boolean) => { current = value ? selection : undefined; for (const listener of topology) listener() },
    reconnect: () => { state.generation += 1; for (const listener of states) listener() },
  }
}

describe('Remote Workflow shared presentation and physical stream ownership', () => {
  it('reserves zero renderer rows before selection, before baseline, and for an empty native baseline', async () => {
    const f = await fixture({ selected: false })
    expect(f.node()).toBeNull(); expect(f.rows()).toEqual([])
    f.select(true); await flush()
    expect(f.node()).toBeNull(); expect(f.rows()).toEqual([])
    expect(f.native.follow).toHaveBeenCalledWith({ sessionId }, expect.any(AbortSignal))
    f.native.emit(frame()); await flush()
    expect(f.node()).toBeNull(); expect(f.rows()).toEqual([])
    f.native.emit(frame([run()], 'replacement')); await flush()
    expect(f.rows().join('\n')).toContain('Workflow Review')
    f.native.emit(frame([], 'replacement')); await flush()
    expect(f.node()).toBeNull(); expect(f.rows()).toEqual([])
  })

  it.each([1, 8, 20, 40, 80, 120])('uses the canonical workflow node without overflow at width %s', async width => {
    vi.spyOn(Date, 'now').mockReturnValue(10_000)
    const f = await fixture()
    const runs = [run({ phases: [{ title: 'Inspect' }, { title: 'Check' }], phasesSeen: ['Inspect'], currentPhase: 'Inspect', agents: [{ seq: 1, label: 'Inspect code 你好 '.repeat(5), phase: 'Inspect', childId: SessionId('child') }] })]
    f.native.emit(frame(runs)); await flush()
    expect(f.rows(width)).toEqual(f.render(remoteWorkflowNode(snapshot(runs), Date.now(), t), width))
    expect(f.rows(width).every(row => visibleWidth(row) <= width)).toBe(true)
    expect(f.rows(width).length).toBeGreaterThan(0)
  })

  it('keeps a visible capability error, refreshes it, and withdraws the empty pane after recovery', async () => {
    const f = await fixture({ capable: false })
    expect(f.rows().join('\n')).toContain('followWorkflow is unavailable on this Host')
    expect(f.native.follow).not.toHaveBeenCalled()
    f.capabilities.mockResolvedValue({ ok: true, value: { features: ['followWorkflow'] } })
    await f.refresh(); await flush()
    expect(f.rows()).toEqual([])
    f.native.emit(frame()); await flush()
    expect(f.rows()).toEqual([])
  })

  it.each([new Error('capability transport failed'), 'capability wire failed'])('shows a capability failure and clears it on deselection: %s', async failure => {
    const f = await fixture({ selected: false })
    f.capabilities.mockRejectedValueOnce(failure)
    f.select(true); await flush()
    expect(f.rows().join('\n')).toContain(failure instanceof Error ? failure.message : failure)
    f.select(false); await flush()
    expect(f.rows()).toEqual([])
  })

  it('shows native stream failure alongside the last accepted workflow and removes both on refresh', async () => {
    const f = await fixture()
    f.native.emit(frame([run()])); await flush()
    f.native.fail(new Error('native workflow stream failed')); await flush()
    expect(f.rows().join('\n')).toContain('Workflow Review')
    expect(f.rows().join('\n')).toContain('native workflow stream failed')
    await f.refresh(); await flush()
    expect(f.rows()).toEqual([])
    f.native.emit(frame()); await flush()
    expect(f.rows()).toEqual([])
  })

  it('reports a native stream-construction failure and refreshes the same selection safely', async () => {
    const f = await fixture({ selected: false })
    f.streams.mockImplementationOnce(() => { throw 'stream construction failed' })
    f.select(true); await flush()
    expect(f.rows().join('\n')).toContain('stream construction failed')
    await f.refresh(); await flush()
    expect(f.rows()).toEqual([])
    expect(f.native.channels.size).toBe(1)
  })

  it('keeps an unmarked external stream error visible and withdraws it on refresh', async () => {
    const f = await fixture({ selected: false })
    f.streams.mockImplementationOnce(() => ({
      async *[Symbol.asyncIterator]() { yield* []; throw 'unmarked native source failure' },
      dispose: async () => {},
    }) as never)
    f.select(true); await flush()
    expect(f.rows().join('\n')).toContain('unmarked native source failure')
    await f.refresh(); await flush()
    expect(f.rows()).toEqual([])
  })

  it('aborts the previous exact Host generation and clears its visible run before a new baseline', async () => {
    const f = await fixture()
    f.native.emit(frame([run()])); await flush()
    const signal = f.native.signals[0]!
    f.reconnect(); await flush()
    expect(signal.aborted).toBe(true)
    expect(f.rows()).toEqual([])
    f.native.emit(frame([run({ name: 'Replacement' })])); await flush()
    expect(f.rows().join('\n')).toContain('Workflow Replacement')
    expect(f.rows().join('\n')).not.toContain('Workflow Review')
  })

  it('rejects a late capability result after selection replacement without opening a stream', async () => {
    const f = await fixture({ selected: false })
    const pending = deferred<Awaited<ReturnType<typeof f.capabilities>>>()
    f.capabilities.mockImplementationOnce(() => pending.promise)
    f.select(true); f.select(false)
    pending.resolve({ ok: true, value: { features: ['followWorkflow'] } }); await flush()
    expect(f.native.follow).not.toHaveBeenCalled(); expect(f.rows()).toEqual([])
  })

  it('rejects late refresh capability results even when the selection generation is unchanged', async () => {
    const f = await fixture({ capable: false })
    const pending = deferred<Awaited<ReturnType<typeof f.capabilities>>>()
    f.capabilities.mockImplementationOnce(() => pending.promise)
    await f.refresh(); await f.refresh()
    pending.reject(new Error('retired refresh failed')); await flush()
    expect(f.rows().join('\n')).toContain('followWorkflow is unavailable')
    expect(f.rows().join('\n')).not.toContain('retired refresh failed')
  })

  it('updates running elapsed time and releases timers, streams, and all UI on unload', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] }); vi.setSystemTime(2_000)
    const f = await fixture()
    f.native.emit(frame([run()])); await flush()
    expect(f.rows().join('\n')).toContain('1s')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(f.rows().join('\n')).toContain('3s')
    const signal = f.native.signals[0]!
    f.dispose(); f.dispose(); await flush()
    expect(signal.aborted).toBe(true)
    expect(f.native.channels.size).toBe(0)
    expect(f.ctx.mayflyPanes.list()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores an unrelated action and a native dismissal', async () => {
    const f = await fixture({ capable: false })
    const calls = f.capabilities.mock.calls.length
    await f.dispatch({ kind: 'activate', controlId: 'workflow-actions', actionId: 'unrelated', pagePath: [] })
    await f.dispatch({ kind: 'dismiss', pagePath: [] })
    expect(f.capabilities).toHaveBeenCalledTimes(calls)
  })

  it('ignores source and action callbacks already queued when their owner unloads', async () => {
    let publish!: () => void
    const subscribe = RemoteWorkflowSource.prototype.subscribe
    vi.spyOn(RemoteWorkflowSource.prototype, 'subscribe').mockImplementationOnce(function (this: RemoteWorkflowSource<unknown, unknown>, listener) {
      publish = listener
      return subscribe.call(this, listener)
    })
    const f = await fixture({ capable: false })
    const action = f.registration.mock.calls[0]![0].onEvent!.action!
    f.dispose()
    publish()
    await (action as (event: MayflyUiEvent) => unknown)({ kind: 'activate', controlId: 'workflow-actions', actionId: 'workflow-refresh', pagePath: [] })
    expect(f.capabilities).toHaveBeenCalledOnce()
    expect(f.ctx.mayflyPanes.list()).toEqual([])
  })

  it.each([new Error('workflow release failed'), 'workflow release failed'])('reports a cleanup failure without retaining a pane: %s', async failure => {
    const original = RemoteWorkflowSource.prototype.dispose
    vi.spyOn(RemoteWorkflowSource.prototype, 'dispose').mockImplementationOnce(async function (this: RemoteWorkflowSource<unknown, unknown>) { await original.call(this); throw failure })
    const f = await fixture()
    f.dispose(); await flush()
    expect(f.options.notice.set).toHaveBeenCalledWith('workflow release failed')
    expect(f.ctx.mayflyPanes.list()).toEqual([])
  })
})

describe('Host Workflow DTO presentation', () => {
  it('accepts Client phase metadata and passes the canonical renderer the phase titles it presents', async () => {
    const f = await fixture()
    const data = run({ currentPhase: 'Check', phasesSeen: ['Inspect', 'Check'], phases: [
      { title: 'Inspect' },
      { title: 'Check', detail: 'Validate the code', provider: 'native-provider', model: 'native-model' },
    ] })
    const titles = { ...data, phases: data.phases!.map(phase => ({ title: phase.title })) }
    expect(remoteWorkflowNode(snapshot([data]), 5_000, t)).toEqual(remoteWorkflowNode(snapshot([titles]), 5_000, t))
    expect(f.render(remoteWorkflowNode(snapshot([data]), 5_000, t)).join('\n')).toContain('phase 2/2')
  })

  it('treats missing and empty snapshots as absent and preserves member outcomes without mutating DTOs', async () => {
    const f = await fixture()
    expect(remoteWorkflowNode(undefined, 5_000, t)).toBeNull()
    expect(remoteWorkflowNode(snapshot(), 5_000, t)).toBeNull()
    const dto = run({ phasesSeen: ['Inspect'], agents: [{ seq: 1, label: 'Done member', childId: SessionId('done'), outcome: 'completed' }, { seq: 2, label: 'Running member', childId: SessionId('active') }] })
    const before = JSON.stringify(dto)
    const rows = f.render(remoteWorkflowNode(snapshot([dto]), 5_000, t))
    expect(rows.join('\n')).toContain('Done member')
    expect(rows.join('\n')).toContain('Running member')
    expect(JSON.stringify(dto)).toBe(before)
  })

  it('uses explicit stop reasons ahead of lifecycle interruption and presents interrupted runs as cancelled', async () => {
    const f = await fixture()
    const dto = snapshot([run({ id: 'done', name: 'Complete', stopReason: 'completed', interrupted: true, agentsStarted: 2, endedAt: 3_000 }), run({ id: 'interrupted', name: 'Interrupted', interrupted: true }), run({ id: 'failed', name: 'Failed', stopReason: 'error' })])
    const rows = f.render(remoteWorkflowNode(dto, 5_000, t)).join('\n')
    expect(rows).toContain('completed · 2 agents · 2s')
    expect(rows).toContain('cancelled · 0 agents · 0s')
    expect(rows).toContain('error · 0 agents · 0s')
  })
})
