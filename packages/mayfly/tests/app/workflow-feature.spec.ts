/** Real Workflow stream ownership and renderer height, including empty/error withdrawal. @module */
import { Context } from '@deepseek-ai/cordis'
import { RemoteStream, type RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply as uiProvider } from '@ephemeral-ai/mayfly-ui/provider'
import { compileMayflyUiNode } from '../../src/core/ui-compiler.ts'
import { visibleWidth } from '@earendil-works/pi-tui'
import * as frontend from '../../src/frontend/index.ts'
import type { MayflyUiActionReply, MayflyUiEvent, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostKey, type HostClient } from '../../src/client/types.ts'
import type { MayflyWorkflowFrame, MayflyWorkflowRun, MayflyWorkflowSnapshot } from '../../src/hosts/host-contract.ts'
import { RemoteJobSource } from '../../src/hosts/jobs.ts'
import { RemoteWorkflowSource } from '../../src/hosts/workflow.ts'
import type { RemoteFeatureContext, RemoteFeatureSelection } from '../../src/app/features.ts'
import { mountWorkflowFeature } from '../../src/app/features/workflow.ts'
import { shownWorkflowRuns, workflowPanel, workflowSummary, WORKFLOW_VIEW_LIST_ID, WORKFLOW_VIEW_STOP_ID } from '../../src/app/panels/workflow.ts'
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

async function fixture({ selected = true, capable = true, access, roster = [] }: { selected?: boolean, capable?: boolean, access?: RemoteFeatureSelection['access'], roster?: readonly unknown[] } = {}) {
  const ctx = new Context()
  const provider = await ctx.plugin({ name: 'workflow-test-ui', apply: uiProvider })
  const front = await ctx.plugin(frontend)
  const topology = new Set<() => void>()
  const states = new Set<() => void>()
  const state = { generation: 1 }
  const native = wire()
  const rosters = new Set<(frame: { readonly jobs: readonly unknown[] }) => void>()
  const jobList = vi.fn((_request: unknown, signal: AbortSignal) => ({
    async *[Symbol.asyncIterator]() {
      const queue: { readonly jobs: readonly unknown[] }[] = [{ jobs: roster }]
      let wake = (): void => {}
      const channel = (frame: { readonly jobs: readonly unknown[] }): void => { queue.push(frame); wake() }
      const aborted = (): void => { wake() }
      rosters.add(channel)
      signal.addEventListener('abort', aborted)
      try {
        while (!signal.aborted) {
          if (queue.length === 0) await new Promise<void>(resolve => { wake = resolve })
          while (queue.length > 0) yield queue.shift()!
        }
      } finally {
        rosters.delete(channel)
        signal.removeEventListener('abort', aborted)
      }
    },
  }))
  const jobKill = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ ok: true, value: { kind: 'success' } }))
  const views = { isEntered: false, active: undefined as string | undefined, listeners: new Set<() => void>(), subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } } }
  const open = vi.fn(async (..._args: unknown[]): Promise<MayflyUiActionReply> => ({ kind: 'completed' }))
  const capabilities = vi.fn(async (): Promise<{ ok: true, value: { features: string[] } }> => ({ ok: true, value: { features: capable ? ['followWorkflow'] : [] } }))
  const streams = vi.fn(<T>(options: RemoteStreamOptions<T>) => new RemoteStream<T>({ generation: { getSnapshot: () => state.generation, subscribe: () => () => {} } } as never, options))
  const client = {
    key: HostKey('workflow-host'),
    state: {
      getSnapshot: () => state,
      subscribe: (listener: () => void) => { states.add(listener); return () => { states.delete(listener) } },
    },
    remote: { $stream: streams, mayflyHost: { capabilities, followWorkflow: native.follow }, job: { list: jobList, kill: jobKill } },
  } as unknown as HostClient
  const selection = { ref: { host: client.key, sessionId }, client, binding: {}, access } as RemoteFeatureSelection
  let current: RemoteFeatureSelection | undefined = selected ? selection : undefined
  const options = {
    ctx, components: fakeMayflyComponents(), colors: plainColors(), screen: { views },
    hosts: {
      list: () => [client], current: () => current,
      subscribe: (listener: () => void) => { topology.add(listener); return () => { topology.delete(listener) } },
    }, notice: { set: vi.fn() },
  } as unknown as RemoteFeatureContext
  const registration = vi.spyOn(ctx.mayflyPanes, 'register')
  const dispose = mountWorkflowFeature(options, { open })
  cleanups.push(async () => { dispose(); await flush(); await front.dispose(); await provider.dispose(); await ctx.fiber.dispose() })
  const node = (): MayflyUiNode | null => ctx.mayflyPanes.list().find(pane => pane.id === 'mayfly.view.workflow')?.node ?? null
  const render = (value: MayflyUiNode | null, width = 80): string[] => {
    if (value === null) return []
    const result = compileMayflyUiNode(value, { components: options.components, colors: options.colors, getViewport: () => ({ columns: width, rows: 24 }), screenMode: 'alternate', emit: () => {} })
    if (!result.ok) throw new Error(result.message)
    return plain(result.value.component.render(width))
  }
  const act = async (event: MayflyUiEvent, signal = new AbortController().signal): Promise<MayflyUiActionReply> =>
    await (registration.mock.calls[0]![0].onEvent!.action as (event: MayflyUiEvent, context: { readonly signal: AbortSignal }) => Promise<MayflyUiActionReply>)(event, { signal })
  const dispatch = async (event: MayflyUiEvent): Promise<void> => {
    const entry = ctx.mayflyPanes.list().find(pane => pane.id === 'mayfly.view.workflow')!
    const prepared = await entry.events.prepare(event, { surfaceId: entry.id, source: entry.source, revision: entry.revision, operationId: 'workflow-test', signal: new AbortController().signal, report: () => {} })
    prepared.publish()
  }
  const refresh = (): Promise<void> => dispatch({ kind: 'activate', controlId: 'workflow-actions', actionId: 'workflow-refresh', pagePath: [] })
  await flush()
  return {
    ctx, native, capabilities, streams, state, options, dispose, node, render, dispatch, refresh, registration, act, open, jobList, jobKill, rosters, views,
    summary: () => ctx.mayflyPanes.list().find(pane => pane.id === 'mayfly.view.workflow')?.summary ?? null,
    enter: async (value = true) => { views.isEntered = value; views.active = value ? 'mayfly.view.workflow' : undefined; for (const listener of views.listeners) listener(); await flush() },
    rows: (width = 80) => render(node(), width),
    select: (value: boolean) => { current = value ? selection : undefined; for (const listener of topology) listener() },
    setAccess: (access: NonNullable<RemoteFeatureSelection['access']>) => { current = { ...current!, access }; for (const listener of topology) listener() },
    reconnect: () => { state.generation += 1; for (const listener of states) listener() },
  }
}

describe('Remote Workflow shared presentation and physical stream ownership', () => {
  it.each(['readonly', 'resumable'] as const)('leaves %s child history passive without reading Agent-only Workflow state', async access => {
    const f = await fixture({ access })
    expect(f.capabilities).not.toHaveBeenCalled()
    expect(f.native.follow).not.toHaveBeenCalled()
    expect(f.rows()).toEqual([])
    await f.refresh(); f.reconnect(); await flush()
    expect(f.capabilities).not.toHaveBeenCalled()
    expect(f.native.follow).not.toHaveBeenCalled()
    expect(f.rows()).toEqual([])
  })

  it.each(['readonly', 'resumable'] as const)('retires a live Workflow when access becomes %s and resumes observing only explicit interactive access', async access => {
    const f = await fixture({ access: 'interactive' })
    f.native.emit(frame([run()])); await flush()
    expect(f.rows().join('\n')).toContain('Review')
    const signal = f.native.signals[0]!
    const retired = [...f.native.channels][0]!
    f.setAccess(access); await flush()
    expect(signal.aborted).toBe(true)
    expect(f.native.channels.size).toBe(0)
    retired.emit(frame([run({ name: 'Stale child' })], 'replacement'))
    retired.fail(new Error('retired Agent unavailable')); await flush()
    expect(f.rows()).toEqual([])
    expect(f.capabilities).toHaveBeenCalledOnce()
    expect(f.native.follow).toHaveBeenCalledOnce()
    f.setAccess('interactive'); await flush()
    expect(f.capabilities).toHaveBeenCalledTimes(2)
    expect(f.native.follow).toHaveBeenCalledTimes(2)
    f.native.emit(frame([run({ name: 'Active child' })])); await flush()
    expect(f.rows().join('\n')).toContain('Active child')
  })

  it('retires pending capability discovery on a cold access change and preserves a subsequent live failure', async () => {
    const f = await fixture({ selected: false })
    const pending = deferred<Awaited<ReturnType<typeof f.capabilities>>>()
    f.capabilities.mockImplementationOnce(() => pending.promise)
    f.select(true)
    f.setAccess('readonly')
    pending.resolve({ ok: true, value: { features: ['followWorkflow'] } }); await flush()
    expect(f.native.follow).not.toHaveBeenCalled()
    expect(f.rows()).toEqual([])
    f.setAccess('interactive'); await flush()
    f.native.fail(new Error('interactive child Agent unavailable')); await flush()
    expect(f.rows().join('\n')).toContain('interactive child Agent unavailable')
    f.setAccess('resumable'); await flush()
    expect(f.rows()).toEqual([])
  })

  it('reserves zero renderer rows before selection, before baseline, and for an empty native baseline', async () => {
    const f = await fixture({ selected: false })
    expect(f.node()).toBeNull(); expect(f.rows()).toEqual([])
    f.select(true); await flush()
    expect(f.node()).toBeNull(); expect(f.rows()).toEqual([])
    expect(f.native.follow).toHaveBeenCalledWith({ sessionId }, expect.any(AbortSignal))
    f.native.emit(frame()); await flush()
    expect(f.node()).toBeNull(); expect(f.rows()).toEqual([])
    f.native.emit(frame([run()], 'replacement')); await flush()
    expect(f.rows().join('\n')).toContain('Review')
    f.native.emit(frame([], 'replacement')); await flush()
    expect(f.node()).toBeNull(); expect(f.rows()).toEqual([])
  })

  it.each([1, 8, 20, 40, 80, 120])('draws the panel without overflow at width %s', async width => {
    vi.spyOn(Date, 'now').mockReturnValue(10_000)
    const f = await fixture()
    const runs = [run({ phases: [{ title: 'Inspect' }, { title: 'Check' }], phasesSeen: ['Inspect'], currentPhase: 'Inspect', agents: [{ seq: 1, label: 'Inspect code 你好 '.repeat(5), phase: 'Inspect', childId: SessionId('child') }] })]
    f.native.emit(frame(runs)); await flush()
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
    expect(f.rows().join('\n')).toContain('Review')
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
    expect(f.rows().join('\n')).toContain('Replacement')
    expect(f.rows().join('\n')).not.toContain('Review')
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
    await expect((action as unknown as (event: MayflyUiEvent, context: { readonly signal: AbortSignal }) => Promise<unknown>)({ kind: 'activate', controlId: 'workflow-actions', actionId: 'workflow-refresh', pagePath: [] }, { signal: new AbortController().signal })).resolves.toEqual({ kind: 'cancelled' })
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

const member = (seq: number, outcome?: 'completed' | 'failed' | 'cancelled') => ({ seq, label: `member ${String(seq)}`, phase: 'Inspect', childId: SessionId(`child-${String(seq)}`), ...outcome === undefined ? {} : { outcome } })
const stopEvent = (id?: string): MayflyUiEvent => ({ kind: 'activate', pagePath: [], controlId: 'workflow-view-actions', actionId: WORKFLOW_VIEW_STOP_ID, ...id === undefined ? {} : { inputs: { actionId: WORKFLOW_VIEW_STOP_ID, draftRevision: 0, forms: [], selections: [{ pagePath: [], controlId: WORKFLOW_VIEW_LIST_ID, selectedIds: [id] }] } } } as unknown as MayflyUiEvent)
const job = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, kind: 'workflow', label: name, status: 'running', startedAt: 0, ...extra })

describe('the Workflow view', () => {
  it('registers as a view after jobs and before goal, and counts settled over started', async () => {
    const f = await fixture()
    expect(f.registration.mock.calls[0]![0]).toMatchObject({ id: 'mayfly.view.workflow', placement: 'views', priority: 13 })
    expect(f.summary()).toBeNull()
    f.native.emit(frame([run({ agents: [member(1, 'completed'), member(2)] })])); await flush()
    expect(JSON.stringify(f.summary())).toContain('workflow ')
    expect(JSON.stringify(f.summary())).toContain('1/2')
    expect(JSON.stringify(f.summary())).toContain('●')
  })

  it('holds a settled run for five seconds by its own end time, so a resumed session shows old runs nowhere', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] }); vi.setSystemTime(20_000)
    const f = await fixture()
    f.native.emit(frame([run({ stopReason: 'completed', endedAt: 19_000, startedAt: 1_000, agentsStarted: 1, agents: [member(1, 'completed')] })])); await flush()
    expect(JSON.stringify(f.summary())).toContain('✓')
    expect(f.rows().join('\n')).toContain('Review · completed · 1 agent · 18s')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(f.summary()).not.toBeNull()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(f.summary()).toBeNull()
    expect(f.rows()).toEqual([])
    f.native.emit(frame([run({ stopReason: 'error', endedAt: 1_000 }), run({ id: 'gone', interrupted: true })], 'replacement')); await flush()
    expect(f.summary()).toBeNull()
  })

  it('does not publish when the lane notifies, because publishing is what notifies it', async () => {
    const f = await fixture()
    f.native.emit(frame([run()])); await flush()
    const revision = f.ctx.mayflyPanes.list().find(pane => pane.id === 'mayfly.view.workflow')!.revision
    for (const listener of f.views.listeners) listener()
    expect(f.ctx.mayflyPanes.list().find(pane => pane.id === 'mayfly.view.workflow')!.revision).toBe(revision)
  })

  it('says the workflow is unavailable in the status row when it cannot be followed', async () => {
    const f = await fixture({ capable: false })
    expect(JSON.stringify(f.summary())).toContain('workflow unavailable')
  })

  it('follows the job roster only while the view is open with a run working, and leaves it on unload', async () => {
    const f = await fixture()
    f.native.emit(frame([run({ agents: [member(1)] })])); await flush()
    expect(f.jobList).not.toHaveBeenCalled()
    f.views.isEntered = true; f.views.active = 'mayfly.view.jobs'
    for (const listener of f.views.listeners) listener()
    await flush()
    expect(f.jobList).not.toHaveBeenCalled()
    await f.enter()
    expect(f.jobList).toHaveBeenCalledOnce()
    await f.enter(false)
    expect(f.rosters.size).toBe(0)
    await f.enter()
    expect(f.jobList).toHaveBeenCalledTimes(2)
    f.native.emit(frame([run({ stopReason: 'completed', endedAt: Date.now(), agents: [member(1, 'completed')] })], 'replacement')); await flush()
    expect(f.rosters.size).toBe(0)
    f.native.emit(frame([run({ agents: [member(1)] })], 'replacement')); await flush()
    expect(f.rosters.size).toBe(1)
    f.dispose(); await flush()
    expect(f.rosters.size).toBe(0)
  })

  it('reports a roster it cannot start while the owner lives, and nothing after unload', async () => {
    const f = await fixture()
    f.native.emit(frame([run({ agents: [member(1)] })])); await flush()
    const attach = vi.spyOn(RemoteJobSource.prototype, 'attach').mockRejectedValueOnce(new Error('no roster'))
    await f.enter()
    expect(f.options.notice.set).toHaveBeenCalledWith('no roster', 'error')
    const late = deferred<void>()
    attach.mockReturnValueOnce(late.promise)
    await f.enter(false)
    f.dispose()
    late.reject(new Error('late roster')); await flush()
    expect(f.options.notice.set).not.toHaveBeenCalledWith('late roster', 'error')
  })

  it('stops a background run through its job, and names why a foreground or settled run cannot be', async () => {
    const f = await fixture({ roster: [job('job-1', 'Review'), job('other', 'Review', { kind: 'bash' }), job('done', 'Review', { status: 'completed' })] })
    f.native.emit(frame([run({ agents: [member(1)] }), run({ id: 'fg', name: 'Inline', agents: [member(2)] }), run({ id: 'over', name: 'Over', stopReason: 'completed', endedAt: Date.now(), agents: [member(3, 'completed')] })])); await flush()
    await f.enter()
    const items = (JSON.parse(JSON.stringify(f.node())) as { children: { node?: { kind: string, items?: { id: string, unavailableActions?: unknown }[] }, kind?: string, items?: { id: string, unavailableActions?: unknown }[] }[] })
    const list = items.children.map(child => child.node ?? child).find(child => child.kind === 'list')!
    const reason = (id: string) => list.items!.find(item => item.id === id)!.unavailableActions
    expect(reason('child-1')).toEqual({})
    expect(reason('child-2')).toEqual({ [WORKFLOW_VIEW_STOP_ID]: 'A foreground workflow stops with Esc' })
    expect(reason('child-3')).toEqual({ [WORKFLOW_VIEW_STOP_ID]: 'The workflow has ended' })
    await expect(f.act(stopEvent('child-1'))).resolves.toEqual({ kind: 'completed', feedback: { severity: 'success', message: 'Stopping Review' } })
    expect(f.jobKill).toHaveBeenCalledWith({ sessionId, jobId: 'job-1' })
    await expect(f.act(stopEvent('child-2'))).resolves.toEqual({ kind: 'failed', message: 'A foreground workflow stops with Esc' })
    await expect(f.act(stopEvent())).resolves.toMatchObject({ kind: 'failed' })
    expect(f.jobKill).toHaveBeenCalledOnce()
  })

  it('leaves two live jobs of one name alone, and refuses when the roster is not followed', async () => {
    const f = await fixture({ roster: [job('a', 'Review'), job('b', 'Review')] })
    f.native.emit(frame([run({ agents: [member(1)] })])); await flush()
    await expect(f.act(stopEvent('child-1'))).resolves.toMatchObject({ kind: 'failed' })
    await f.enter()
    await expect(f.act(stopEvent('child-1'))).resolves.toMatchObject({ kind: 'failed' })
    expect(f.jobKill).not.toHaveBeenCalled()
  })

  it('reports a refused kill, and answers cancelled when the caller has gone', async () => {
    const f = await fixture({ roster: [job('a', 'Review')] })
    f.native.emit(frame([run({ agents: [member(1)] })])); await flush()
    await f.enter()
    f.jobKill.mockResolvedValueOnce({ ok: false, error: { code: 'denied', message: 'refused' } })
    await expect(f.act(stopEvent('child-1'))).resolves.toEqual({ kind: 'failed', message: 'refused' })
    const caller = new AbortController()
    f.jobKill.mockImplementationOnce(async () => { caller.abort(); return { ok: false, error: { code: 'denied', message: 'late' } } })
    await expect(f.act(stopEvent('child-1'), caller.signal)).resolves.toEqual({ kind: 'cancelled' })
    const killed = new AbortController()
    f.jobKill.mockImplementationOnce(async () => { killed.abort(); return { ok: true, value: {} } })
    await expect(f.act(stopEvent('child-1'), killed.signal)).resolves.toEqual({ kind: 'cancelled' })
    const aborted = new AbortController(); aborted.abort()
    await expect(f.act(stopEvent('child-1'), aborted.signal)).resolves.toEqual({ kind: 'cancelled' })
  })

  it('opens the member under the cursor through the shared opener, and ignores what it does not own', async () => {
    const f = await fixture()
    const accept = (controlId: string, selectedIds: string[]): MayflyUiEvent => ({ kind: 'selection-accept', pagePath: [], controlId, selectedIds } as MayflyUiEvent)
    await expect(f.act(accept(WORKFLOW_VIEW_LIST_ID, ['child-1']))).resolves.toEqual({ kind: 'completed' })
    expect(f.open).toHaveBeenCalledWith('child-1', expect.any(AbortSignal))
    await expect(f.act(accept(WORKFLOW_VIEW_LIST_ID, []))).resolves.toEqual({ kind: 'completed' })
    await expect(f.act(accept('other', ['child-1']))).resolves.toEqual({ kind: 'completed' })
    expect(f.open).toHaveBeenCalledOnce()
  })
})

describe('the Workflow panel over Host DTOs', () => {
  const none = (): undefined => undefined

  it('reads phase metadata, with the position of a phase it does not list taken from the phases seen', async () => {
    const f = await fixture()
    const phases = [{ title: 'Inspect' }, { title: 'Check', detail: 'Validate the code', provider: 'native-provider', model: 'native-model' }]
    expect(f.render(workflowPanel([run({ currentPhase: 'Check', phasesSeen: ['Inspect', 'Check'], phases })], none, 5_000, t)).join('\n')).toContain('Review · Check · phase 2/2 · 4s')
    expect(f.render(workflowPanel([run({ currentPhase: 'Extra', phasesSeen: ['Inspect', 'Extra'], phases })], none, 5_000, t)).join('\n')).toContain('Extra · phase 1/2')
    expect(f.render(workflowPanel([run({ currentPhase: 'Extra', phasesSeen: [], phases })], none, 5_000, t)).join('\n')).toContain('Extra · phase 1/2')
    expect(f.render(workflowPanel([run({ currentPhase: 'Loose', phases: [] })], none, 5_000, t)).join('\n')).toContain('Review · Loose · 4s')
    expect(f.render(workflowPanel([run()], none, 5_000, t)).join('\n')).toContain('Review · 4s')
  })

  it('treats missing and empty snapshots as absent and leaves the DTOs alone', () => {
    expect(shownWorkflowRuns(undefined, 5_000)).toEqual([])
    expect(shownWorkflowRuns(snapshot(), 5_000)).toEqual([])
    expect(workflowPanel([], none, 5_000, t)).toBeNull()
    expect(workflowSummary([], t)).toBeNull()
    const dto = run({ agents: [member(1, 'completed'), member(2)] })
    const before = JSON.stringify(dto)
    workflowPanel([dto], none, 5_000, t)
    expect(JSON.stringify(dto)).toBe(before)
  })

  it('lists working members first and then the latest to finish, with one mark per outcome', async () => {
    const f = await fixture()
    const rows = f.render(workflowPanel([run({ agents: [member(1, 'completed'), member(2), member(3, 'failed'), member(4, 'cancelled')] })], none, 5_000, t)).filter(row => row.includes('member'))
    expect(rows.map(row => row.trim().replace(/^→ /u, '').slice(0, 10))).toEqual(['● member 2', '⊘ member 4', '✕ member 3', '✓ member 1'])
    expect(rows[0]).toContain('Inspect')
    const unphased = { seq: 5, label: 'loose', childId: SessionId('loose') }
    expect(f.render(workflowPanel([run({ agents: [unphased] })], none, 5_000, t)).join('\n')).toContain('loose')
  })

  it('reads a member a settled run left without an outcome as cancelled', async () => {
    const f = await fixture()
    const settled = run({ stopReason: 'cancelled', endedAt: 4_000, agents: [member(1)] })
    expect(f.render(workflowPanel([settled], none, 5_000, t)).join('\n')).toContain('⊘ member 1')
    expect(JSON.stringify(workflowSummary([settled], t))).toContain('1/1')
  })

  it('says how a run ended, using the started count, and the worst outcome marks the item', async () => {
    const f = await fixture()
    const ended = (name: string, stopReason: MayflyWorkflowRun['stopReason'], extra: Partial<MayflyWorkflowRun> = {}) => run({ id: name, name, stopReason, endedAt: 3_000, ...extra })
    const rows = f.render(workflowPanel([ended('Done', 'completed', { agentsStarted: 2 }), ended('Halted', 'cancelled'), ended('Broke', 'error')], none, 5_000, t)).join('\n')
    expect(rows).toContain('Done · completed · 2 agents · 2s')
    expect(rows).toContain('Halted · cancelled · 0 agents · 2s')
    expect(rows).toContain('Broke · failed · 0 agents · 2s')
    expect(f.render(workflowPanel([run({ interrupted: true })], none, 5_000, t)).join('\n')).toContain('cancelled · 0 agents · 0s')
    const mark = (runs: readonly MayflyWorkflowRun[]) => JSON.stringify(workflowSummary(runs, t))
    expect(mark([ended('a', 'completed'), ended('b', 'error'), ended('c', 'cancelled')])).toContain('✕')
    expect(mark([ended('a', 'completed'), ended('c', 'cancelled')])).toContain('⊘')
    expect(mark([ended('a', 'completed')])).toContain('✓')
    expect(mark([ended('a', 'error'), run()])).toContain('●')
  })

  it('shows live runs first, and at most three', () => {
    const live = (id: string) => run({ id })
    const held = run({ id: 'held', stopReason: 'completed', endedAt: 4_000 })
    expect(shownWorkflowRuns(snapshot([held, live('a')]), 5_000).map(each => each.id)).toEqual(['a', 'held'])
    expect(shownWorkflowRuns(snapshot([live('a'), live('b'), live('c'), live('d')]), 5_000).map(each => each.id)).toEqual(['a', 'b', 'c'])
  })
})
