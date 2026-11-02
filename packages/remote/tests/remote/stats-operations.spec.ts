/** Reference statistics tabs, Host snapshots, refresh scopes and late-result fences. @module */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MayflyStatsDigest, MayflyStatsHistory, MayflyStatsSession } from '@ephemeral-ai/mayfly-host/types'
import type { MayflyUiActionEvent, MayflyUiEventContext } from '@ephemeral-ai/mayfly-ui'
import { mountRemoteStatsOperations, remoteStatsDigest } from '../../src/remote/operations/stats.ts'
import { RemotePresentSlot, type RemoteOperationsContext } from '../../src/remote/operations/support.ts'
import type { RemoteBrowserOptions } from '../../src/remote/panels/browser.ts'
import { taskFixture, tick, activated, good, bad } from './task-feature-fixture.ts'
import { projection } from './approval-feature-fixture.ts'

const seams = vi.hoisted(() => ({ browser: vi.fn(), prices: vi.fn(), account: vi.fn(), copy: vi.fn() }))
vi.mock('../../src/remote/panels/browser.ts', () => ({ openRemoteBrowser: seams.browser }))
vi.mock('../../src/remote/operations/stats-account.ts', () => ({ remoteStatsAccount: seams.account }))
vi.mock('@ephemeral-ai/mayfly/configuration-panels', async original => ({ ...await original<object>(), loadModelsDevIndex: seams.prices }))
vi.mock('../../src/remote/local/clipboard.ts', () => ({ copyLocalText: seams.copy }))
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const stop of cleanups.splice(0).reverse()) await stop(); vi.useRealTimers(); vi.restoreAllMocks(); for (const mock of Object.values(seams)) mock.mockReset() })
const buckets = { input: 10, output: 5, cacheRead: 1, cacheWrite: 2 }
const digest: MayflyStatsDigest = { id: 'session', cwd: '/host/home/work', firstAt: Date.now() - 1000, lastAt: Date.now(), days: [{ key: new Date().toISOString().slice(0, 10), turns: 2, models: [{ provider: 'p', model: 'm', peak: buckets, offPeak: buckets }] }] }
const initial: MayflyStatsSession = { createdAt: 1000, cwd: digest.cwd, digest, status: 'idle', harnessVersion: '0.2.2-alpha.2' }
const frame = (digests: readonly MayflyStatsDigest[] = [digest]): MayflyStatsHistory => ({ running: false, done: 1, total: 1, skipped: 0, failed: 0, digests })
const eventContext = (): MayflyUiEventContext => ({ surfaceId: 'stats', source: [], signal: new AbortController().signal, revision: 1, operationId: 'action', report: vi.fn() })

async function fixture(selected = true, injectedCopy = true) {
  const f = await taskFixture(selected)
  const values: Record<string, ReturnType<typeof projection<unknown>>> = {
    tokenUsage: projection<unknown>({ uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 2 }),
    contextPressure: projection<unknown>({ pressureTokens: 20, contextWindow: 100 }), contextBreakdown: projection<unknown>(undefined),
    modelSelection: projection<unknown>({ next: { provider: 'p', model: 'm' } }), sessionStats: projection<unknown>({ turns: 2, steps: 3, llmMs: 200, toolMs: 100, ttftMs: 10, ttftSteps: 1, decodeMs: 100, decodeTokens: 5 }),
  }
  const listeners = new Set<() => void>()
  const current = f.options.hosts.current()
  if (current !== undefined) Object.assign(current.binding.session, { projections: { faceOf: (key: string) => values[key] }, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } } })
  const read = vi.fn(async (..._args: unknown[]): Promise<unknown> => good(initial))
  const streamDispose = vi.fn()
  const history = vi.fn((..._args: unknown[]) => Object.assign((async function* () { yield frame() })(), { dispose: streamDispose }))
  Object.assign(f.client.remote, { $host: { home: '/host/home' }, mayflyHost: { statsSession: read, statsHistory: history } })
  seams.account.mockImplementation(async (_client: unknown, route: string) => ({ route, name: route, kind: 'other', at: Date.now() }))
  seams.prices.mockResolvedValue(undefined)
  seams.copy.mockResolvedValue('native')
  const copy = vi.fn(async (..._args: unknown[]) => 'native' as 'native' | 'osc52')
  const options = { localCwd: '/local', btw: {}, ...injectedCopy ? { copy } : {} } as unknown as RemoteOperationsContext['options']
  const panels: Array<{ options: RemoteBrowserOptions, refresh: ReturnType<typeof vi.fn<() => void>>, close: ReturnType<typeof vi.fn<() => void>>, closed: boolean }> = []
  seams.browser.mockImplementation((_base, options: RemoteBrowserOptions) => {
    const panel = { options, refresh: vi.fn(), close: vi.fn(() => { if (panel.closed) return; panel.closed = true; options.onClosed?.() }), closed: false }
    panels.push(panel); return panel
  })
  const slot = new RemotePresentSlot(options)
  const stop = mountRemoteStatsOperations({ base: f.options, options, presentSlot: slot })
  cleanups.push(async () => { stop(); slot.dispose(); await f.dispose() })
  const panel = () => panels.at(-1)!
  const open = async () => { await f.run('stats'); await tick(); return panel() }
  const tab = (tabId: string) => panel().options.observe!({ kind: 'tab-change', controlId: 'stats-tabs', tabId, pagePath: [] })
  const act = (actionId: string, context = eventContext()) => panel().options.action!(activated(actionId), context)
  const text = () => JSON.stringify(panel().options.view())
  return { ...f, values, listeners, current, read, history, streamDispose, copy, panels, panel, open, tab, act, text, stop }
}

describe('rc.2 Remote statistics', () => {
  it('decodes detached whole digests without folding logs, renders every reference tab at narrow widths', async () => {
    const decoded = remoteStatsDigest(digest)
    expect(decoded.days.get(digest.days[0]!.key)!.models.get('p\0m')!.peak).toEqual(buckets)
    expect(decoded.days.get(digest.days[0]!.key)!.models.get('p\0m')!.peak).not.toBe(buckets)
    const f = await fixture(); await f.open()
    expect(f.read).toHaveBeenCalledWith({ sessionId: 'session' }, expect.any(AbortSignal))
    expect(f.text()).toContain('~/work'); expect(f.text()).toContain('0.2.2-alpha.2')
    for (const tab of ['session', 'account', 'history', 'models']) {
      f.tab(tab); await tick()
      for (const width of [1, 20, 40, 80, 120]) expect(f.render(f.panel().options.view(), width).every(row => row.length <= width)).toBe(true)
    }
    expect(f.history).toHaveBeenCalledTimes(1); expect(f.streamDispose).toHaveBeenCalledOnce()
    expect(f.history).toHaveBeenCalledWith({ sessionId: 'session', allWorkspaces: true }, expect.any(AbortSignal))
    expect(f.text()).toContain('Tokens per day')
    f.panel().close()
    expect(f.listeners.size).toBe(0)
  })

  it('requires a selected Session and valid command arguments and focuses an already open panel', async () => {
    const f = await fixture(false)
    await expect(f.run('stats', 'extra')).rejects.toThrow('Usage: /stats')
    await expect(f.run('stats')).rejects.toThrow('no session is live yet')
    const selected = await fixture(); await selected.open()
    const focus = vi.spyOn(selected.ctx.mayflyOverlays, 'focus').mockReturnValue(true)
    await selected.run('stats'); expect(selected.panels).toHaveLength(1); focus.mockRestore()
  })

  it('cycles date ranges and workspace scans and copies the currently shown reference summary', async () => {
    const f = await fixture(); await f.open(); f.tab('history'); await tick()
    for (const label of ['Last 7 days', 'Last 30 days', 'All time']) { expect(await f.act('range')).toMatchObject({ kind: 'accepted' }); expect(f.text()).toContain(label) }
    await f.act('workspace'); await tick()
    expect(f.history).toHaveBeenLastCalledWith({ sessionId: 'session', allWorkspaces: false }, expect.any(AbortSignal))
    f.copy.mockResolvedValueOnce('osc52')
    expect(await f.act('copy')).toMatchObject({ kind: 'completed', feedback: { message: 'copied the stats summary via terminal escape sequence (unverified)' } })
    expect(f.copy.mock.calls.at(-1)![0]).toContain('Sessions: 1')
    f.tab('models'); await tick(); await f.act('copy'); expect(f.copy.mock.calls.at(-1)![0]).toContain('p/m')
    f.tab('account'); expect(f.render(f.panel().options.view()).join('\n')).toContain('Provider')
    f.tab('session'); await f.act('copy'); expect(f.copy.mock.calls.at(-1)![0]).toContain('Working directory: ~/work')
  })

  it('uses local clipboard fallback and reports failures or stale copy results without reopening', async () => {
    const f = await fixture(true, false); await f.open()
    expect(await f.act('copy')).toMatchObject({ kind: 'completed' }); expect(seams.copy).toHaveBeenCalled()
    seams.copy.mockRejectedValueOnce(new Error('clipboard unavailable'))
    expect(await f.act('copy')).toMatchObject({ kind: 'failed', message: 'could not copy: clipboard unavailable' })
    const wait = Promise.withResolvers<void>(); seams.copy.mockReturnValueOnce(wait.promise)
    const pending = f.act('copy'); f.reconnect(); wait.resolve(); expect(await pending).toEqual({ kind: 'cancelled' })
    expect(f.panel().closed).toBe(true)
  })

  it('fences copy errors and acknowledged actions after retirement or action cancellation', async () => {
    const f = await fixture(); await f.open()
    const wait = Promise.withResolvers<'native'>(); f.copy.mockReturnValueOnce(wait.promise)
    const pending = f.act('copy'); f.detach(); wait.reject(new Error('late')); expect(await pending).toEqual({ kind: 'cancelled' })
    expect(await f.act('copy')).toEqual({ kind: 'cancelled' })
    const other = await fixture(); await other.open()
    expect(await other.act('refresh', { ...eventContext(), signal: AbortSignal.abort() })).toEqual({ kind: 'cancelled' })
    expect(await other.panel().options.action!({ kind: 'dismiss', pagePath: [] } as MayflyUiActionEvent, eventContext())).toEqual({ kind: 'completed' })
    expect(await other.act('unknown')).toEqual({ kind: 'completed' })
  })

  it('coalesces native projection and status refreshes and handles absent statistics and metadata', async () => {
    const f = await fixture(); await f.open(); vi.useFakeTimers()
    f.values['sessionStats']!.set(undefined); f.values['contextPressure']!.set(undefined)
    f.values['tokenUsage']!.set(undefined); f.values['modelSelection']!.set(undefined)
    for (const listener of f.listeners) listener()
    expect(f.read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(f.read).toHaveBeenCalledTimes(2)
    expect(f.text()).toContain('not set')
    f.read.mockResolvedValueOnce(good({ ...initial, cwd: undefined, digest: undefined }))
    await f.act('refresh'); await vi.advanceTimersByTimeAsync(0)
    expect(f.text()).toContain('(unknown)')
  })

  it('contains failed history reads and stale stream frames and disposes retired workspace streams', async () => {
    const f = await fixture(); await f.open()
    f.history.mockImplementationOnce(() => Object.assign((async function* () { yield await Promise.reject<MayflyStatsHistory>(new Error('storage offline')) })(), { dispose: f.streamDispose }))
    f.tab('history'); await tick(); expect(f.text()).toContain('Could not read the stored sessions: storage offline')
    const wait = Promise.withResolvers<void>()
    f.history.mockImplementationOnce(() => Object.assign((async function* () { await wait.promise; yield frame() })(), { dispose: f.streamDispose }))
    await f.act('workspace'); f.reconnect(); wait.resolve(); await tick()
    expect(f.panel().closed).toBe(true); expect(f.streamDispose).toHaveBeenCalledTimes(2)
  })

  it('retires prior Session reads and panel owners after replacement and ignores late successes and errors', async () => {
    const f = await fixture(); const wait = Promise.withResolvers<unknown>(); f.read.mockReturnValueOnce(wait.promise)
    await f.open(); expect(f.text()).toContain('Session information unavailable')
    const old = f.panel(); await f.open(); expect(old.closed).toBe(true)
    wait.resolve(good({ ...initial, cwd: '/stale' })); await tick(); expect(f.text()).not.toContain('/stale')
    f.read.mockResolvedValueOnce(bad('native failed')); await f.act('refresh'); await tick()
    expect(f.options.notice.set).toHaveBeenCalledWith('native failed')
    const error = Promise.withResolvers<unknown>(); f.read.mockReturnValueOnce(error.promise)
    await f.act('refresh'); f.reconnect(); error.reject(new Error('late failure')); await tick()
    expect(f.options.notice.set).not.toHaveBeenCalledWith('late failure')
    expect(old.options.isCurrent()).toBe(false)
  })

  it('caches successful account reads per live Host generation and retries failed balances', async () => {
    const f = await fixture(); await f.open(); expect(seams.account).toHaveBeenCalledTimes(1)
    f.tab('account'); await tick(); expect(seams.account).toHaveBeenCalledTimes(1)
    f.panel().close(); await f.open(); expect(seams.account).toHaveBeenCalledTimes(1)
    f.reconnect(); await f.open(); expect(seams.account).toHaveBeenCalledTimes(2)
    f.panel().close(); f.ctx.mayflyLocale.setPreference('zh')
    f.reconnect(); seams.account.mockResolvedValueOnce({ route: 'p', name: 'p', kind: 'api-key', balance: { status: 'unavailable', reason: 'network' }, at: Date.now() })
    await f.open(); f.tab('account'); await tick(); expect(seams.account).toHaveBeenCalledTimes(4)
    expect(seams.account.mock.calls.at(-1)![2]).toBe('zh')
  })

  it('contains price/account failures and fences late provider, price and Session results on unload', async () => {
    const f = await fixture(); seams.account.mockRejectedValueOnce(new Error('account offline')); seams.prices.mockRejectedValueOnce(new Error('catalog offline'))
    await f.open(); f.tab('account'); await tick()
    f.panel().close()
    const account = Promise.withResolvers<unknown>(); const prices = Promise.withResolvers<unknown>(); const read = Promise.withResolvers<unknown>()
    seams.account.mockReturnValueOnce(account.promise); seams.prices.mockReturnValueOnce(prices.promise); f.read.mockReturnValueOnce(read.promise)
    await f.open(); f.stop(); f.stop()
    account.resolve({ route: 'p', name: 'stale', kind: 'other', at: 0 }); prices.resolve(undefined); read.resolve(good(initial)); await tick()
    expect(f.panel().closed).toBe(true)
  })

  it('ignores unrelated tab observations and repeats, cancels expired pending copy actions, and releases timers', async () => {
    const f = await fixture(); await f.open(); vi.useFakeTimers()
    f.panel().options.observe!({ kind: 'focus-change', controlId: 'x', pagePath: [] })
    f.tab('unknown'); f.tab('session'); expect(f.history).not.toHaveBeenCalled()
    const controller = new AbortController(); const wait = Promise.withResolvers<'native'>(); f.copy.mockReturnValueOnce(wait.promise)
    const pending = f.act('copy', { ...eventContext(), signal: controller.signal }); controller.abort(); wait.resolve('native')
    expect(await pending).toEqual({ kind: 'cancelled' })
    f.values['sessionStats']!.set({ turns: 1 }); f.stop(); await vi.advanceTimersByTimeAsync(100)
    expect(f.listeners.size).toBe(0)
  })

  it('retains one pending account route and ignores old provider snapshots and retired price work', async () => {
    const f = await fixture(); vi.useFakeTimers()
    Reflect.set(f.client.remote.$host, 'home', undefined)
    const first = Promise.withResolvers<unknown>()
    const price = Promise.withResolvers<unknown>()
    seams.account.mockReturnValueOnce(first.promise); seams.prices.mockReturnValueOnce(price.promise)
    await f.run('stats'); await vi.advanceTimersByTimeAsync(0)
    f.tab('account'); expect(seams.account).toHaveBeenCalledTimes(1)
    // A scheduled read may already be queued when a native subscription is released.
    const queued = [...f.listeners][0]!
    f.values['modelSelection']!.set({ next: { provider: 'q', model: 'n' } })
    await vi.advanceTimersByTimeAsync(100)
    expect(seams.account).toHaveBeenCalledTimes(2)
    first.resolve({ route: 'p', name: 'stale', kind: 'other', at: Date.now() })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.text()).not.toContain('stale')
    f.reconnect(); price.resolve(undefined); await vi.advanceTimersByTimeAsync(0)
    queued(); f.tab('models')
    expect(f.panel().closed).toBe(true)
    await vi.advanceTimersByTimeAsync(100)
  })

  it('fences pending account, failed old history and ready timers at panel closure', async () => {
    const f = await fixture(); vi.useFakeTimers()
    const account = Promise.withResolvers<unknown>(); seams.account.mockReturnValueOnce(account.promise)
    await f.run('stats'); await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(100)
    const wait = Promise.withResolvers<void>()
    f.history.mockImplementationOnce(() => Object.assign((async function* () { await wait.promise; yield await Promise.reject<MayflyStatsHistory>(new Error('old history')) })(), { dispose: f.streamDispose }))
    f.tab('history'); f.panel().close(); account.resolve(undefined); wait.resolve()
    await vi.advanceTimersByTimeAsync(100)
    expect(f.panel().closed).toBe(true)
  })

  it('handles a registry closing the panel synchronously during opening without retaining subscriptions', async () => {
    const f = await fixture()
    seams.browser.mockImplementationOnce((_base, options: RemoteBrowserOptions) => {
      options.onClosed?.()
      return { refresh: vi.fn(), close: vi.fn(), closed: true }
    })
    await f.run('stats')
    expect(f.listeners.size).toBe(0); expect(f.read).not.toHaveBeenCalled()
  })

  it('repaints native indexing progress without rereading the unchanged selected Session', async () => {
    const f = await fixture(); await f.open(); vi.useFakeTimers()
    const wait = Promise.withResolvers<void>()
    f.history.mockImplementationOnce(() => Object.assign((async function* () { yield { ...frame(), running: true }; await wait.promise })(), { dispose: f.streamDispose }))
    f.tab('history'); await vi.advanceTimersByTimeAsync(100)
    expect(f.text()).toContain('indexing 1/1 sessions')
    expect(f.read).toHaveBeenCalledTimes(1)
    wait.resolve(); await vi.advanceTimersByTimeAsync(0)
  })
})
