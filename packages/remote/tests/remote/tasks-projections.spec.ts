/** Native Todo/Schedule projections, reminder catalogs and lifecycle-safe presentation. @module */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { visibleWidth } from '@ephemeral-ai/mayfly/core'
import type { MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { mountTodoFeature } from '../../src/remote/features/todo.ts'
import { mountScheduleFeature } from '../../src/remote/features/schedule.ts'
import { remoteTodoPanel, remoteTodoSummary } from '../../src/remote/panels/todo.ts'
import { remoteScheduleNode, formatRemoteReminderFrequency, formatRemoteReminderRelative, type RemoteScheduleRecord } from '../../src/remote/panels/schedule.ts'
import type { RemoteBrowserOptions } from '../../src/remote/panels/browser.ts'
import { taskFixture, tick, translate, activated, good, bad } from './task-feature-fixture.ts'

const opened = vi.hoisted(() => vi.fn())
vi.mock('../../src/remote/panels/browser.ts', () => ({ openRemoteBrowser: opened }))
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const stop of cleanups.splice(0).reverse()) await stop(); vi.restoreAllMocks(); vi.useRealTimers(); opened.mockReset() })
const pending = [{ content: 'Native task', status: 'pending' }]
const done = [{ content: 'Native task', status: 'completed' }]

async function fixture(kind: 'todo' | 'schedule', selected = true) {
  const f = await taskFixture(selected)
  const panels: Array<{ options: RemoteBrowserOptions, refresh: ReturnType<typeof vi.fn<() => void>>, close: ReturnType<typeof vi.fn<() => void>> }> = []
  opened.mockImplementation((_base, options: RemoteBrowserOptions) => { let closed = false; const panel = { options, refresh: vi.fn(), close: vi.fn(() => { if (closed) return; closed = true; options.signal?.removeEventListener('abort', panel.close); options.onClosed?.() }), get closed() { return closed } }; options.signal?.addEventListener('abort', panel.close, { once: true }); panels.push(panel); return panel })
  const registered = vi.spyOn(f.options.commands, 'register')
  const dispose = kind === 'todo' ? mountTodoFeature(f.options) : mountScheduleFeature(f.options)
  cleanups.push(async () => { dispose(); await f.dispose() })
  await tick()
  return { ...f, panels, stop: dispose, node: (): MayflyUiNode | null => f.pane('mayfly.view.todo')?.node ?? null, summary: () => f.pane('mayfly.view.todo')?.summary ?? null, invoke: (signal: AbortSignal) => registered.mock.calls[0]![0].execute('', signal), status: () => f.ctx.mayflyStatus.list().find(entry => entry.id === 'mayfly.schedule')?.node ?? null }
}
const panelText = (f: Awaited<ReturnType<typeof fixture>>) => JSON.stringify(f.panels.at(-1)?.options.view())
const reminder = (extra: Record<string, unknown> = {}): RemoteScheduleRecord => ({ id: 'reminder', title: 'Native reminder', prompt: 'Native reminder prompt', kind: 'at', scheduledAt: new Date(2_000).toISOString(), ...extra }) as RemoteScheduleRecord

describe('native Todo projection owner', () => {
  it('keeps no baseline rows and only lingers completion after observing unfinished work', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.setSystemTime(1_000)
    const f = await fixture('todo', false)
    expect(f.node()).toBeNull(); expect(f.summary()).toBeNull()
    f.select(true); f.state.todos.set(done)
    expect(f.summary()).toBeNull()
    f.state.todos.set(pending)
    expect(f.render(f.node()).join('\n')).toContain('Native task')
    f.state.todos.set(done)
    expect(f.node()).toBeNull(); expect(JSON.stringify(f.summary())).toContain('✓')
    f.state.todos.set(done); f.state.todos.set([])
    expect(JSON.stringify(f.summary())).toContain('✓')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(f.summary()).toBeNull()
    f.state.todos.set(pending); f.state.todos.set(done); f.state.todos.set(pending)
    expect(JSON.stringify(f.summary())).toContain('●')
    f.state.todos.set(done); f.select(false)
    expect(f.summary()).toBeNull()
    f.state.todos.set(null); f.select(true)
    expect(f.node()).toBeNull()
  })

  it('uses the latest durable turn outcome and retires queued projection/timer work on unload', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const timers = vi.spyOn(globalThis, 'setTimeout')
    const f = await fixture('todo')
    f.state.todos.set(pending)
    f.state.mayflyConversation.set({ turns: [] })
    f.state.mayflyConversation.set({ turns: [{ outcome: 'error' }] })
    expect(f.render(f.node()).join('\n')).not.toContain('interrupted')
    f.state.mayflyConversation.set({ turns: [{ endedAt: 1, outcome: 'completed' }, { endedAt: 2, outcome: 'error' }] })
    expect(f.render(f.node()).join('\n')).toContain('interrupted')
    f.state.mayflyConversation.set({ turns: [{ endedAt: 1, outcome: 'completed' }] })
    const queued = [...f.state.todos.listeners]
    f.state.todos.set(done)
    const callback = timers.mock.calls.findLast(call => call[1] === 5_000)![0] as () => void
    f.stop(); f.stop(); callback(); for (const update of queued) update()
    expect(f.ctx.mayflyPanes.list()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('renders every native checklist state within width and retains completed row facts', async () => {
    const f = await fixture('todo')
    const state = { todos: [{ content: 'Pending 你好 '.repeat(10), status: 'pending' as const }, { content: 'Working', status: 'in_progress' as const }, { content: 'Done', status: 'completed' as const }], interrupted: true }
    const node = remoteTodoPanel(state, translate)
    for (const width of [1, 8, 20, 40, 80, 120]) expect(f.render(node, width).every(row => visibleWidth(row) <= width)).toBe(true)
    expect(f.render(node).join('\n')).toContain('Done')
    expect(remoteTodoSummary(state, translate)).not.toBeNull()
    expect(remoteTodoSummary({ ...state, done: { total: 3 } }, translate)).not.toBeNull()
    expect(remoteTodoPanel({ todos: [], interrupted: false }, translate)).toBeNull()
    expect(remoteTodoSummary({ todos: [], interrupted: false }, translate)).toBeNull()
  })
})

describe('native Schedule reads and observations', () => {
  it('cancels invocation panels, timers and pending reads while preserving background reminder observations', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    for (const failed of [false, true]) {
      const f = await fixture('schedule')
      const cancelled = new AbortController(); cancelled.abort()
      await f.invoke(cancelled.signal)
      expect(f.panels).toHaveLength(0)
      const gate = Promise.withResolvers<unknown>()
      f.schedule.list.mockReturnValueOnce(gate.promise)
      const caller = new AbortController()
      await f.run('schedule', '', caller.signal)
      const panel = f.panels.at(-1)!
      expect(vi.getTimerCount()).toBe(1)
      caller.abort()
      expect(panel.close).toHaveBeenCalledOnce()
      expect(panel.options.isCurrent()).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
      if (failed) gate.reject(new Error('cancelled reminders'))
      else gate.resolve(good([reminder()]))
      await tick()
      expect(f.status()).toBeNull()
      expect(await panel.options.action!(activated('refresh'), { signal: new AbortController().signal } as never)).toEqual({ kind: 'cancelled' })
      f.schedule.list.mockResolvedValue(good([reminder()]))
      f.event('schedule/changed'); await tick()
      expect(JSON.stringify(f.status())).toContain('Reminders 1')
      f.stop()
      await f.invoke(new AbortController().signal)
      expect(f.panels).toHaveLength(1)
    }
  })

  it('retires action refresh results and never starts a timer or read after synchronous renderer close', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const f = await fixture('schedule')
    const original = opened.getMockImplementation()!
    opened.mockImplementationOnce((...args) => { const panel = original(...args); panel.close(); return panel })
    const count = f.schedule.list.mock.calls.length
    await f.run('schedule')
    expect(f.schedule.list).toHaveBeenCalledTimes(count)
    expect(vi.getTimerCount()).toBe(0)
    await f.run('schedule')
    const panel = f.panels.at(-1)!
    const cancelled = new AbortController(); cancelled.abort()
    expect(await panel.options.action!(activated('refresh'), { signal: cancelled.signal } as never)).toEqual({ kind: 'cancelled' })
    const caller = new AbortController()
    const gate = Promise.withResolvers<unknown>()
    f.schedule.list.mockReturnValueOnce(gate.promise)
    const pending = panel.options.action!(activated('refresh'), { signal: caller.signal } as never)
    caller.abort(); gate.resolve(good([reminder()]))
    expect(await pending).toEqual({ kind: 'cancelled' })
    expect(f.status()).toBeNull()
  })

  it('opens selected and Host catalogs, ticks only an open panel and clears exact subscriptions', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] }); vi.setSystemTime(1_000)
    const f = await fixture('schedule', false)
    await f.run('schedule'); expect(f.options.notice.set).toHaveBeenCalledWith('Schedule unavailable')
    expect(f.status()).toBeNull()
    f.schedule.list.mockResolvedValue(good([reminder()]))
    f.schedule.catalog.mockResolvedValue(good([reminder({ sessionId: 'session', status: 'inactive', timeZone: 'Asia/Shanghai' })]))
    f.select(true); await tick()
    expect(JSON.stringify(f.status())).toContain('Reminders 1')
    await f.run('schedule'); await tick()
    expect(panelText(f)).toContain('Reminders')
    expect(f.panels.at(-1)!.options.isCurrent()).toBe(true)
    const refreshes = f.panels.at(-1)!.refresh.mock.calls.length
    await vi.advanceTimersByTimeAsync(1_000)
    expect(f.panels.at(-1)!.refresh.mock.calls.length).toBeGreaterThan(refreshes)
    await f.panels.at(-1)!.options.action!(activated('unrelated'), { signal: new AbortController().signal } as never)
    await f.panels.at(-1)!.options.action!({ kind: 'dismiss', pagePath: [] }, { signal: new AbortController().signal } as never)
    await f.panels.at(-1)!.options.action!(activated('refresh'), { signal: new AbortController().signal } as never); await tick()
    await f.run('schedule', 'all'); await tick()
    expect(panelText(f)).toContain('Host reminders'); expect(panelText(f)).toContain('Session: session')
    f.panels.at(-1)!.close()
    expect(vi.getTimerCount()).toBe(0)
    await expect(f.run('schedule', 'invalid')).rejects.toThrow('Usage: /schedule [all]')
    const callbacks = [...f.topology]
    f.detach(); expect(f.events.get('schedule/changed')?.size).toBe(0)
    f.stop(); f.stop(); for (const callback of callbacks) callback()
    expect(f.ctx.mayflyStatus.list()).toEqual([])
  })

  it('shows list/catalog errors independently and refreshes on current Host facts only', async () => {
    const f = await fixture('schedule')
    f.schedule.list.mockResolvedValueOnce(bad('list denied'))
    f.schedule.catalog.mockResolvedValueOnce(bad('catalog denied'))
    f.event('schedule/changed'); await tick()
    expect(JSON.stringify(f.status())).toContain('Reminders unavailable')
    await f.run('schedule'); await tick()
    f.schedule.list.mockResolvedValueOnce(bad('list denied')); f.schedule.catalog.mockResolvedValueOnce(bad('catalog denied'))
    f.event('schedule/changed'); await tick()
    expect(panelText(f)).toContain('list denied')
    await f.run('schedule', 'all'); await tick()
    f.schedule.catalog.mockResolvedValueOnce(bad('catalog denied')); f.event('schedule/changed'); await tick()
    expect(panelText(f)).toContain('catalog denied')
    for (const error of [new Error('transport down'), 'transport down']) {
      f.schedule.list.mockRejectedValueOnce(error); f.event('schedule/changed'); await tick()
      expect(panelText(f)).toContain('transport down')
    }
    const stale = f.panels.at(-1)!
    f.select(false); f.event('schedule/changed'); await stale.options.action!(activated('refresh'), { signal: new AbortController().signal } as never); await tick()
    expect(f.status()).toBeNull()
    f.select(true); await tick(); f.reconnect(); await tick()
    expect(f.status()).toBeNull()
  })

  it('drops replaced and failed reads after refresh/reconnection/unload', async () => {
    const f = await fixture('schedule')
    for (const failure of [false, true]) {
      const late = Promise.withResolvers<unknown>()
      f.schedule.list.mockReturnValueOnce(late.promise)
      f.event('schedule/changed')
      f.event('schedule/changed'); await tick()
      if (failure) late.reject(new Error('retired refresh failed'))
      else late.resolve(good([reminder()]))
      await tick()
      expect(f.status()).toBeNull()
    }
    const late = Promise.withResolvers<unknown>(); f.schedule.catalog.mockReturnValueOnce(late.promise)
    f.event('schedule/changed'); f.reconnect(); late.resolve(good([])); await tick()
    expect(f.status()).toBeNull()
    const failed = Promise.withResolvers<unknown>(); f.schedule.list.mockReturnValueOnce(failed.promise)
    f.event('schedule/changed'); f.stop(); failed.reject('unloaded'); await tick()
    expect(f.ctx.mayflyStatus.list()).toEqual([])
  })

  it('formats native recurrence and relative deadlines with deterministic sorting and narrow row widths', async () => {
    const f = await fixture('schedule')
    for (const [kind, expected] of [['daily', 'Daily'], ['weekly', 'Weekly'], ['cron', 'Cron'], ['once', 'Once']]) expect(formatRemoteReminderFrequency(reminder({ kind }), translate)).toBe(expected)
    for (const interval of [86_400, 172_800, 3_600, 60, 2, 0.5]) expect(formatRemoteReminderFrequency(reminder({ kind: 'every', everySeconds: interval }), translate)).toContain('Every')
    expect(formatRemoteReminderRelative(new Date(1_000).toISOString(), 1_000, translate)).toBe('Due now')
    expect(formatRemoteReminderRelative(new Date(1_100).toISOString(), 1_000, translate)).toBe('in 1 second')
    expect(formatRemoteReminderRelative(new Date(0).toISOString(), 3_000, translate)).toBe('3 seconds overdue')
    const records = [reminder({ id: 'past-active', scheduledAt: new Date(0).toISOString(), status: 'active' }), reminder(), reminder({ id: 'same', scheduledAt: new Date(2_000).toISOString(), timeZone: 'UTC', status: 'active' }), reminder({ id: 'past', scheduledAt: new Date(0).toISOString(), sessionId: 'session', status: 'inactive' }), reminder({ id: 'future', scheduledAt: new Date(3_000).toISOString(), status: 'unknown', timeZone: 1 })]
    const nodes = [remoteScheduleNode(records, 1_000, translate, 'en', { catalog: true }), remoteScheduleNode(undefined, 1_000, translate, undefined, { error: 'Host unavailable' }), remoteScheduleNode([], 1_000, translate, 'en')]
    for (const node of nodes) for (const width of [1, 8, 20, 40, 80, 120]) expect(f.render(node, width).every(row => visibleWidth(row) <= width)).toBe(true)
  })
})
