/** Real Job status/browser/detail/output ownership over native whole snapshots. @module */
import { Context } from '@deepseek-ai/cordis'
import type { JobFollowFrame, JobListFrame, JobView } from '@deepseek-ai/dsh-api-job-controller/client'
import { apply as uiProvider } from '@ephemeral-ai/mayfly-ui/provider'
import * as frontend from '@ephemeral-ai/mayfly/frontend'
import type { MayflyUiActionEvent, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { compileMayflyUiNode, visibleWidth } from '@ephemeral-ai/mayfly/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostClient } from '../../src/client/types.ts'
import { RemoteJobSource } from '../../src/frontend/jobs.ts'
import { RemoteFeatureCommandRegistry } from '../../src/remote/features/commands.ts'
import type { RemoteFeatureContext, RemoteFeatureSelection } from '../../src/remote/features.ts'
import { mountJobsFeature } from '../../src/remote/features/jobs.ts'
import type { RemoteBrowserOptions } from '../../src/remote/panels/browser.ts'
import { remoteJobDetailsNode, remoteJobOutputNode, remoteJobsPanel, remoteJobsSummary, formatRemoteJobDuration } from '../../src/remote/panels/jobs.ts'
import { projection } from './approval-feature-fixture.ts'
import { channel, flush, job, ref } from './jobs-fixture.ts'
import { fakeMayflyComponents, plain, plainColors } from './render-fixture.ts'

const open = vi.hoisted(() => vi.fn())
vi.mock('../../src/remote/panels/browser.ts', () => ({ openRemoteBrowser: open }))
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const off of cleanup.splice(0).reverse()) await off(); vi.restoreAllMocks(); vi.useRealTimers(); open.mockReset() })
const t = (key: string, values?: Readonly<Record<string, string | number>>) => key.replace(/\{(\w+)\}/gu, (_match, name: string) => String(values?.[name] ?? `{${name}}`))
const action = (actionId: string): Extract<MayflyUiActionEvent, { readonly kind: 'activate' }> => ({ kind: 'activate', actionId, controlId: 'jobs-actions', pagePath: [] })
const stop = (): MayflyUiActionEvent => ({ ...action('jobs-stop'), inputs: { actionId: 'jobs-stop', draftRevision: 0, source: [], forms: [], selections: [{ controlId: 'jobs-list', pagePath: [], selectedIds: ['job'] }] } })
const select = (id = 'job'): MayflyUiActionEvent => ({ kind: 'selection-accept', controlId: 'jobs-list', selectedIds: [id], pagePath: [] })

async function fixture(selected = true) {
  const ctx = new Context()
  const ui = await ctx.plugin({ name: 'jobs-test-ui', apply: uiProvider })
  const front = await ctx.plugin(frontend)
  ctx.mayflyLocale.setPreference('en')
  const panels: Array<{ options: RemoteBrowserOptions, refresh: ReturnType<typeof vi.fn<() => void>>, close: ReturnType<typeof vi.fn<() => void>> }> = []
  open.mockImplementation((_base, options: RemoteBrowserOptions) => {
    let closed = false
    const handle = { options, refresh: vi.fn(), close: vi.fn(() => { if (closed) return; closed = true; options.onClosed?.() }), get closed() { return closed } }
    panels.push(handle); return handle
  })
  const history = projection<readonly JobView[] | undefined>(undefined)
  const listeners = new Set<() => void>()
  const states = new Set<() => void>()
  const generation = { generation: 1 }
  const streams: Array<ReturnType<typeof channel<{ value: JobListFrame, accept: () => void }>>> = []
  const follow: Array<ReturnType<typeof channel<JobFollowFrame>>> = []
  let check: readonly JobView[] | undefined = [job()]
  const list = vi.fn((_request: unknown, _signal: AbortSignal) => ({
    dispose: vi.fn(async () => {}),
    async *[Symbol.asyncIterator]() { if (check !== undefined) yield { type: 'rows', jobs: check } },
  }))
  const kill = vi.fn(async () => ({ ok: true as const, value: { outcome: 'stopping' } }))
  const client = { key: ref.host, state: { getSnapshot: () => generation, subscribe: (fn: () => void) => { states.add(fn); return () => { states.delete(fn) } } }, remote: {
    job: { list, kill, follow: vi.fn(() => { const stream = channel<JobFollowFrame>(); follow.push(stream); return { ...stream, dispose: async () => { stream.end() } } }) },
    $stream: vi.fn(() => { const stream = channel<{ value: JobListFrame, accept: () => void }>(); streams.push(stream); return { ...stream, dispose: async () => { stream.end() } } }),
  } } as unknown as HostClient
  const original = { client, ref, binding: { session: { projections: { faceOf: (key: string) => { expect(key).toBe('mayflyJobs'); return history } } } } } as unknown as RemoteFeatureSelection
  let current: RemoteFeatureSelection | undefined = selected ? original : undefined
  const commands = new RemoteFeatureCommandRegistry()
  const options = { ctx, components: fakeMayflyComponents(), colors: plainColors(), commands, hosts: { list: () => [client], current: () => current, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } } }, notice: { set: vi.fn() } } as unknown as RemoteFeatureContext
  const registration = vi.spyOn(ctx.mayflyPanes, 'register')
  const dispose = mountJobsFeature(options)
  const notify = () => { for (const fn of listeners) fn() }
  cleanup.push(async () => { dispose(); for (const stream of [...streams, ...follow]) stream.end(); await flush(); await front.dispose(); await ui.dispose(); await ctx.fiber.dispose() })
  const entry = () => ctx.mayflyPanes.list().find(row => row.id === 'mayfly.view.jobs')!
  const node = () => entry()?.node ?? null
  const render = (value: MayflyUiNode | null, width = 80): string[] => {
    if (value === null) return []
    const result = compileMayflyUiNode(value, { components: options.components, colors: options.colors, getViewport: () => ({ columns: width, rows: 24 }), screenMode: 'alternate', emit: () => {} })
    if (!result.ok) throw new Error(result.message)
    return plain(result.value.component.render(width))
  }
  const dispatch = async (event: MayflyUiActionEvent) => await (registration.mock.calls[0]![0].onEvent!.action as (event: MayflyUiActionEvent) => Promise<unknown>)(event)
  const emit = async (jobs: readonly JobView[]) => { streams.at(-1)!.push({ value: { type: 'rows', jobs }, accept: vi.fn() }); await flush() }
  const run = async (input = '') => { await commands.execute('jobs', input, new AbortController().signal) }
  await flush()
  return { ctx, options, client, history, panels, streams, follow, list, kill, dispatch, dispose, node, render, run, emit, registration, entry,
    selected: (value: boolean) => { current = value ? original : undefined; notify() },
    clearSelection: () => { current = undefined },
    check: (rows: readonly JobView[] | undefined) => { check = rows },
    reconnect: () => { generation.generation += 1; for (const fn of states) fn() },
  }
}

const panelText = (f: Awaited<ReturnType<typeof fixture>>) => JSON.stringify(f.panels.at(-1)?.options.view())

describe('Job whole-snapshot feature ownership', () => {
  it('merges readonly durable settled rows with authoritative resident rows, clears replaced history and preserves the reference summary', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] }); vi.setSystemTime(2_000)
    const f = await fixture(false)
    expect(f.node()).toBeNull()
    await f.run(); expect(f.panels).toEqual([])
    f.selected(true); await flush()
    f.history.set([job({ id: 'past' as JobView['id'], status: 'completed' }), job({ label: 'durable', status: 'completed' })])
    await f.emit([job({ label: 'resident' })])
    expect(f.render(f.node()).join('\n')).toContain('resident')
    expect(f.render(f.node()).join('\n')).not.toContain('durable')
    expect(f.render(f.node()).join('\n')).toContain('Actual build')
    await f.emit([job({ status: 'completed' })])
    expect(JSON.stringify(f.entry().summary)).toContain('✓')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(f.entry().summary).toBeNull()
    await f.emit([job()]); await f.emit([job({ status: 'failed' })])
    expect(JSON.stringify(f.entry().summary)).toContain('✕')
    await f.emit([job()]); f.history.set([]); await f.emit([])
    expect(f.entry().summary).toBeNull()
    expect(f.node()).toBeNull()
    await expect(f.run('wrong')).rejects.toThrow('Usage: /jobs')
  })

  it('opens reference browser/details/output and restarts only the matching reader on reconnect', async () => {
    const f = await fixture(); await f.emit([job()]); await f.run()
    const browser = f.panels.at(-1)!
    expect(browser.options.isCurrent!()).toBe(true)
    expect(panelText(f)).toContain('Actual build')
    await browser.options.action!(select(), {} as never)
    const detail = f.panels.at(-1)!
    expect(detail.options.isCurrent!()).toBe(true)
    expect(panelText(f)).toContain('Read output')
    await detail.options.action!(action('jobs-read'), {} as never)
    const reader = f.panels.at(-1)!
    expect(reader.options.isCurrent!()).toBe(true)
    f.follow[0]!.push({ type: 'opened', job: job(), from: 0 })
    f.follow[0]!.push({ type: 'output', next: 4, chunks: [{ at: 0, text: 'real' }] }); await flush()
    expect(panelText(f)).toContain('real')
    f.reconnect(); await flush()
    expect(f.client.remote.job.follow).toHaveBeenLastCalledWith({ sessionId: ref.sessionId, jobId: job().id, from: 4 }, expect.any(AbortSignal))
    f.follow[0]!.end(); f.follow[1]!.push({ type: 'status', job: job({ status: 'completed' }) }); f.follow[1]!.end(); await flush()
    expect(panelText(f)).toContain('completed')
    reader.close()
    await f.emit([job()]); await f.dispatch(select())
    expect(f.panels.at(-1)!.options.id).toBe('remote.jobs.output')
    f.selected(false); await flush()
    expect(f.panels.at(-1)!.options.isCurrent!()).toBe(false)
    expect(f.node()).toBeNull()
  })

  it('rechecks the current native roster before an explicit stop, preserving failures and stopped status', async () => {
    const f = await fixture(); await f.emit([job()])
    expect(await f.dispatch(action('unrelated'))).toEqual({ kind: 'completed' })
    expect(await f.dispatch(select('absent'))).toMatchObject({ kind: 'failed', message: 'Select a job first' })
    const stopping = stop()
    expect(await f.dispatch(stopping)).toMatchObject({ kind: 'completed', feedback: { message: 'Stopping Actual build' } })
    expect(f.kill).toHaveBeenCalledWith({ sessionId: ref.sessionId, jobId: job().id })
    await f.emit([job({ status: 'completed', detail: 'hidden after human stop' })])
    expect(f.render(f.node()).join('\n')).toContain('stopped')
    f.check([job({ status: 'stopping' })]); expect(await f.dispatch(stopping)).toMatchObject({ message: 'Already stopping' })
    f.check([job({ status: 'completed' })]); expect(await f.dispatch(stopping)).toMatchObject({ message: 'Already finished' })
    f.check([]); expect(await f.dispatch(stopping)).toMatchObject({ message: 'The job is no longer available' })
    f.check(undefined); expect(await f.dispatch(stopping)).toMatchObject({ message: 'The job is no longer available' })
    f.check([job()]); f.kill.mockResolvedValueOnce({ ok: false, error: { message: 'Host denied' } } as never)
    expect(await f.dispatch(stopping)).toMatchObject({ message: 'Host denied' })
    f.kill.mockResolvedValueOnce({ ok: true, value: { outcome: 'already-finished' } })
    expect(await f.dispatch(stopping)).toMatchObject({ message: 'Already finished' })
    for (const error of [new Error('roster failed'), 'roster failed']) {
      f.list.mockImplementationOnce(() => ({ dispose: vi.fn(async () => {}), async *[Symbol.asyncIterator]() { yield* []; throw error } }))
      expect(await f.dispatch(stopping)).toMatchObject({ message: 'roster failed' })
    }
    await f.run(); await f.panels.at(-1)!.options.action!(select(), {} as never)
    expect(await f.panels.at(-1)!.options.action!(action('jobs-stop'), {} as never)).toMatchObject({ kind: 'completed' })
    const staleBrowser = f.panels.find(panel => panel.options.id === 'remote.jobs')!
    f.clearSelection()
    await staleBrowser.options.action!(select(), {} as never)
    expect(await f.dispatch(select())).toEqual({ kind: 'completed' })
    expect(await f.dispatch(stopping)).toMatchObject({ message: 'The agent changed; open it again' })
  })

  it('fences native recheck and projection continuations from the retired selection', async () => {
    const f = await fixture(); await f.emit([job()])
    const callbacks = [...f.history.listeners]
    const queued = channel<{ type: 'rows', jobs: readonly JobView[] }>()
    f.list.mockReturnValueOnce({ ...queued, dispose: vi.fn(async () => { queued.end() }) } as never)
    const pending = f.dispatch(stop())
    f.selected(false); queued.push({ type: 'rows', jobs: [job()] }); queued.end()
    expect(await pending).toMatchObject({ message: 'The agent changed; open it again' })
    for (const callback of callbacks) callback()
    expect(f.node()).toBeNull(); expect(f.kill).not.toHaveBeenCalled()
  })

  it('retires a late native kill and attach failure before either can affect the replacement Session', async () => {
    const f = await fixture(); await f.emit([job()])
    const kill = Promise.withResolvers<Awaited<ReturnType<typeof f.kill>>>()
    f.kill.mockReturnValueOnce(kill.promise)
    const pending = f.dispatch(stop())
    await flush(); f.reconnect(); await flush()
    kill.resolve({ ok: true, value: { outcome: 'stopping' } })
    expect(await pending).toMatchObject({ message: 'The agent changed; open it again' })
    const start = Promise.withResolvers<void>()
    const original = RemoteJobSource.prototype.attach
    vi.spyOn(RemoteJobSource.prototype, 'attach').mockImplementationOnce(async function (this: RemoteJobSource, ...args) { await original.apply(this, args); await start.promise })
    f.reconnect(); await flush(); f.selected(false)
    start.reject(new Error('retired attach failure')); await flush()
    expect(f.options.notice.set).not.toHaveBeenCalled()
  })

  it('refreshes empty/error browsers and reports stream startup/cleanup failures with exact owner retirement', async () => {
    const f = await fixture(); await f.run()
    expect(panelText(f)).toContain('no background jobs')
    const browser = f.panels.at(-1)!
    await browser.options.action!(action('jobs-refresh'), {} as never); await flush()
    f.streams.at(-1)!.fail(new Error('live unavailable')); await flush()
    expect(panelText(f)).toContain('live unavailable')
    expect(JSON.stringify(f.entry().summary)).toContain('jobs unavailable')
    await browser.options.action!(action('jobs-refresh'), {} as never); await flush()
    f.streams.at(-1)!.fail('plain roster failure'); await flush()
    expect(panelText(f)).toContain('plain roster failure')
    f.streams.at(-1)!.end()
    vi.mocked(f.client.remote.$stream).mockImplementationOnce(() => { throw 'cannot attach' })
    f.reconnect(); await flush()
    expect(f.options.notice.set).toHaveBeenCalledWith('cannot attach')
    vi.mocked(f.client.remote.$stream).mockImplementationOnce(() => { throw new Error('cannot attach error') })
    f.reconnect(); await flush()
    expect(f.options.notice.set).toHaveBeenCalledWith('cannot attach error')
    f.selected(false)
    await f.dispatch(action('jobs-refresh'))
    f.selected(true); await flush()
    await f.emit([job()]); await f.run(); await f.panels.at(-1)!.options.action!(select(), {} as never)
    await f.emit([])
    expect(panelText(f)).toContain('Actual build')
    const publish = vi.fn()
    const subscribe = RemoteJobSource.prototype.subscribe
    vi.spyOn(RemoteJobSource.prototype, 'subscribe').mockImplementationOnce(function (this: RemoteJobSource, listener) { publish.mockImplementation(listener); return subscribe.call(this, listener) })
    const other = await fixture()
    const original = RemoteJobSource.prototype.dispose
    vi.spyOn(RemoteJobSource.prototype, 'dispose').mockImplementationOnce(async function (this: RemoteJobSource) { await original.call(this); throw 'cannot release' })
    other.dispose(); other.dispose(); publish(); await flush()
    expect(other.options.notice.set).toHaveBeenCalledWith('cannot release')
    expect(other.node()).toBeNull()
    const failed = await fixture()
    vi.spyOn(RemoteJobSource.prototype, 'dispose').mockImplementationOnce(async function (this: RemoteJobSource) { await original.call(this); throw new Error('cannot release') })
    failed.dispose(); await flush()
    expect(failed.options.notice.set).toHaveBeenCalledWith('cannot release')
  })
})

describe('Job shared renderer facts', () => {
  it('sorts live/settled rows and preserves every reference state at narrow widths', async () => {
    const f = await fixture(false)
    const rows = [job(), job({ id: 'older' as JobView['id'], startedAt: 0, status: 'stopping', progress: '' }), job({ id: 'done' as JobView['id'], status: 'completed', finishedAt: 5_000, detail: 'done' }), job({ id: 'killed' as JobView['id'], status: 'killed' }), job({ id: 'failed' as JobView['id'], status: 'failed', detail: '' }), job({ id: 'ended' as JobView['id'], status: 'completed' })]
    const state = { jobs: rows, now: 6_000 }
    const nodes = [remoteJobsPanel(state, t), ...rows.map(row => remoteJobDetailsNode(row, t)), ...rows.flatMap(row => [
      remoteJobOutputNode(row, { text: '', dropped: false, streaming: true }, t),
      remoteJobOutputNode(row, { text: 'actual 你好\n'.repeat(10), dropped: true, streaming: false, error: 'native unavailable' }, t),
    ])]
    for (const node of nodes) for (const width of [1, 8, 20, 40, 80, 120]) expect(f.render(node, width).every(line => visibleWidth(line) <= width)).toBe(true)
    expect(formatRemoteJobDuration(0, -1)).toBe('0s')
    expect(formatRemoteJobDuration(0, 60_000)).toBe('1m')
    expect(formatRemoteJobDuration(0, 3_600_000)).toBe('1h')
    expect(formatRemoteJobDuration(0, 3_660_000)).toBe('1h 1m')
    expect(remoteJobsPanel({ jobs: [], now: 0, error: 'failed' }, t)).not.toBeNull()
    expect(remoteJobsSummary({ jobs: [], now: 0, done: { total: 1, failed: false } }, t)).not.toBeNull()
    expect(remoteJobsSummary({ jobs: [], now: 0, done: { total: 1, failed: true } }, t)).not.toBeNull()
    expect(remoteJobsSummary({ jobs: [], now: 0, error: 'failed' }, t)).not.toBeNull()
    expect(remoteJobsSummary({ jobs: [], now: 0 }, t)).toBeNull()
  })
})
