/** Real launch-screen facts, keyboard ownership, clocks and native catalog lifetimes. @module */
import { Context } from '@deepseek-ai/cordis'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MayflyScreenService } from '@ephemeral-ai/mayfly/core'
import * as Frontend from '@ephemeral-ai/mayfly/frontend'
import * as Provider from '@ephemeral-ai/mayfly-ui/provider'
import { DEFAULT_SETTINGS, type MayflySettings } from '@ephemeral-ai/mayfly/settings'
import { FLY_IN_TOTAL_MS, type SplashContent } from '@ephemeral-ai/mayfly/banner-content'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostKey, type HostClient, type SessionRef } from '../../src/client/types.ts'
import { RemoteStartupController } from '../../src/remote/startup.ts'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.useRealTimers() })
function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function summary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return { id: SessionId(id), displayTitle: id, running: false, blank: false, updatedAt: Date.now(), retainedBy: { selected: 0, bound: 0, views: 0 }, ...overrides } as SessionSummary
}
function host(key: string, rows: readonly SessionSummary[] = []) {
  const catalog = new Set<() => void>()
  const connections = new Set<() => void>()
  const refresh = vi.fn(async () => {})
  let summaries = rows
  let generation = 1
  const client = {
    key: HostKey(key),
    sessions: {
      refresh,
      list: {
        getSnapshot: () => ({ ids: summaries.map(row => row.id), byId: Object.fromEntries(summaries.map(row => [row.id, row])) }) as SessionListState,
        subscribe: (listener: () => void) => { catalog.add(listener); return () => { catalog.delete(listener) } },
      },
    },
    state: {
      getSnapshot: () => ({ status: 'connected', generation }),
      subscribe: (listener: () => void) => { connections.add(listener); return () => { connections.delete(listener) } },
    },
  } as unknown as HostClient
  return {
    client, refresh, catalog, connections,
    rows(next: readonly SessionSummary[]) { summaries = next; for (const listener of [...catalog]) listener() },
    reconnect() { generation += 1; for (const listener of [...connections]) listener() },
  }
}
async function fixture(options: { readonly settings?: Partial<MayflySettings>, readonly rows?: readonly SessionSummary[], readonly selected?: boolean } = {}) {
  const ctx = new Context()
  await ctx.plugin(Provider)
  await ctx.plugin(Frontend)
  const keys: Record<string, string> = { 'ui.up': 'up', 'ui.down': 'down', 'ui.accept': 'enter', 'ui.cancel': 'esc' }
  ctx.provide('mayflyKeymap', { matches: (data: string, action: string) => data === keys[action] } as never)
  let settings: MayflySettings = { ...DEFAULT_SETTINGS, startup: 'splash', reducedMotion: true, ...options.settings }
  ctx.get('mayflyInteractionState')!.settingsSource = () => settings
  const primary = host('one', options.rows)
  let client: HostClient | undefined = primary.client
  let current: SessionRef | undefined = options.selected ? { host: primary.client.key, sessionId: SessionId('existing') } : undefined
  let autocomplete = false
  const topology = new Set<() => void>()
  const render = vi.fn()
  const resume = vi.fn()
  const startup = new RemoteStartupController(ctx, { requestRender: render } as unknown as MayflyScreenService, {
    client: () => client, current: () => current, directory: () => '/host/workspace', resume,
    subscribe: listener => { topology.add(listener); return () => { topology.delete(listener) } },
    autocomplete: () => autocomplete,
  })
  cleanups.push(() => ctx.fiber.dispose(), () => { startup.dispose() })
  const emit = () => { for (const listener of [...topology]) listener() }
  return {
    ctx, startup, primary, render, resume, topology, keys,
    splash: () => startup.splash() as SplashContent,
    select(ref: SessionRef | undefined) { current = ref; emit() },
    active(next: HostClient | undefined) { client = next; emit() },
    settings(next: Partial<MayflySettings>) { settings = { ...settings, ...next }; ctx.emit('mayfly/settings-source-ready', settings) },
    autocomplete(value: boolean) { autocomplete = value },
  }
}

describe('Remote startup', () => {
  it('defers startup, filters native blank/child entries and orders current workspace before other recent projects', async () => {
    const f = await fixture({ rows: [
      summary('other-new', { cwd: '/host/other', updatedAt: 300 }),
      summary('here-old', { cwd: '/host/workspace', title: 'Project work', updatedAt: 100 }),
      summary('here-new', { cwd: '/host/workspace', title: '  ', running: true, updatedAt: 200 }),
      summary('blank', { blank: true }), summary('child', { parentId: SessionId('parent') }),
      summary('orphan-child', { origin: 'subagent' }), summary('fourth'), summary('fifth'),
    ] })
    expect(f.startup.splash()).toBe('pending')
    expect(f.primary.refresh).not.toHaveBeenCalled()
    f.startup.start()
    f.startup.start()
    await vi.waitFor(() => { expect(f.splash().recent).toHaveLength(4) })
    expect(f.splash().recent?.slice(0, 2).map(row => row.id)).toEqual(['here-new', 'here-old'])
    expect(f.splash().recent?.[0]).toMatchObject({ title: 'Untitled', project: 'workspace', live: true, age: 'running' })
    expect(f.splash().recent?.map(row => row.id)).not.toContain('blank')
    expect(f.primary.refresh).toHaveBeenCalledOnce()
    expect(f.primary.catalog.size).toBe(1)
    f.ctx.mayflyLocale.setPreference('zh')
    expect(f.splash().labels.recent).toBe('最近的会话')
  })

  it('browses through named rebound keys, resumes once, and releases the cursor for typing/autocomplete/empty list', async () => {
    const f = await fixture({ rows: [summary('one'), summary('two')] })
    f.startup.start()
    await vi.waitFor(() => { expect(f.splash().recent).toHaveLength(2) })
    expect(f.startup.handleInput('up', 'draft')).toBe(false)
    f.autocomplete(true)
    expect(f.startup.handleInput('up', '')).toBe(false)
    f.autocomplete(false)
    expect(f.startup.handleInput('x', '')).toBe(false)
    f.keys['ui.up'] = 'rebound'
    expect(f.startup.handleInput('up', '')).toBe(false)
    expect(f.startup.handleInput('rebound', '')).toBe(true)
    expect(f.splash().focus).toBe(0)
    expect(f.startup.handleInput('rebound', '')).toBe(true)
    expect(f.splash().focus).toBe(0)
    f.startup.handleInput('down', '')
    expect(f.splash().focus).toBe(1)
    f.startup.handleInput('down', '')
    expect(f.splash().focus).toBeUndefined()
    f.startup.handleInput('rebound', '')
    expect(f.startup.handleInput('typed', '')).toBe(false)
    expect(f.splash().focus).toBeUndefined()
    f.startup.handleInput('rebound', '')
    f.startup.handleInput('esc', '')
    expect(f.splash().focus).toBeUndefined()
    f.startup.handleInput('rebound', '')
    f.startup.handleInput('enter', '')
    expect(f.resume).toHaveBeenCalledExactlyOnceWith('one')
    f.startup.handleInput('rebound', '')
    f.startup.handleInput('down', '')
    f.primary.rows([summary('one')])
    expect(f.splash().focus).toBeUndefined()
    f.primary.rows([])
    expect(f.startup.handleInput('rebound', '')).toBe(false)
  })

  it('releases catalogs on selection/settings changes and rejects late callbacks after unload', async () => {
    const f = await fixture({ rows: [summary('one')] })
    f.startup.start()
    await vi.waitFor(() => { expect(f.splash().recent).toHaveLength(1) })
    const late = [...f.primary.catalog][0]!
    f.select({ host: f.primary.client.key, sessionId: SessionId('one') })
    expect(f.startup.splash()).toBeUndefined()
    expect(f.primary.catalog.size).toBe(0)
    expect(f.startup.handleInput('up', '')).toBe(false)
    f.select(undefined)
    await vi.waitFor(() => { expect(f.primary.refresh).toHaveBeenCalledTimes(2) })
    f.settings({ startup: 'conversation' })
    expect(f.primary.catalog.size).toBe(0)
    expect(f.startup.splash()).toBeUndefined()
    f.settings({ startup: 'splash' })
    await vi.waitFor(() => { expect(f.primary.refresh).toHaveBeenCalledTimes(3) })
    f.startup.dispose()
    f.startup.dispose()
    const renders = f.render.mock.calls.length
    late()
    f.primary.rows([summary('late')])
    f.primary.reconnect()
    f.startup.start()
    expect(f.startup.splash()).toBeUndefined()
    expect(f.startup.handleInput('up', '')).toBe(false)
    expect(f.render).toHaveBeenCalledTimes(renders)
    expect(f.primary.connections.size).toBe(0)
    expect(f.topology.size).toBe(0)
  })

  it('fences pending catalog success/failure across Host replacement, reconnect, selection and disposal', async () => {
    const f = await fixture()
    const pending = deferred()
    f.primary.refresh.mockReturnValueOnce(pending.promise)
    f.startup.start()
    const other = host('two', [summary('same-id', { title: 'Other Host' })])
    f.active(other.client)
    await vi.waitFor(() => { expect(f.splash().recent?.[0]?.title).toBe('Other Host') })
    pending.resolve()
    await pending.promise
    expect(f.splash().recent?.[0]?.title).toBe('Other Host')
    const fail = deferred()
    other.refresh.mockReturnValueOnce(fail.promise)
    other.reconnect()
    f.select({ host: other.client.key, sessionId: SessionId('selected') })
    fail.reject(new Error('late failure'))
    await fail.promise.catch(() => {})
    expect(f.startup.splash()).toBeUndefined()
    f.select(undefined)
    const last = deferred()
    other.refresh.mockReturnValueOnce(last.promise)
    other.reconnect()
    f.startup.dispose()
    const renders = f.render.mock.calls.length
    last.resolve()
    await last.promise
    expect(f.render).toHaveBeenCalledTimes(renders)
  })

  it('keeps native load failures empty, handles disconnected startup, and refreshes after reconnect', async () => {
    const f = await fixture()
    f.active(undefined)
    f.startup.start()
    expect(f.splash().recent).toBeUndefined()
    f.primary.refresh.mockRejectedValueOnce(new Error('catalog unavailable'))
    f.active(f.primary.client)
    await vi.waitFor(() => { expect(f.splash().recent).toEqual([]) })
    f.primary.rows([summary('new')])
    expect(f.splash().recent?.[0]?.id).toBe('new')
    f.primary.reconnect()
    await vi.waitFor(() => { expect(f.primary.refresh).toHaveBeenCalledTimes(2) })
  })

  it('plays the canonical fly-in once per start appearance and never replays on theme/settings refresh', async () => {
    const f = await fixture({ settings: { startup: 'conversation', reducedMotion: false } })
    expect(f.startup.flyInAt()).toBe(0)
    vi.useFakeTimers()
    f.startup.start()
    expect(f.startup.flyInAt()).toBe(0)
    vi.advanceTimersByTime(100)
    expect(f.startup.flyInAt()).toBe(100)
    f.settings({ theme: 'tide' })
    expect(f.startup.flyInAt()).toBe(100)
    vi.advanceTimersByTime(FLY_IN_TOTAL_MS)
    expect(f.startup.flyInAt()).toBeUndefined()
    f.select({ host: f.primary.client.key, sessionId: SessionId('first') })
    f.select(undefined)
    expect(f.startup.flyInAt()).toBe(0)
    f.select({ host: f.primary.client.key, sessionId: SessionId('second') })
    expect(f.startup.flyInAt()).toBeUndefined()
    f.select(undefined)
    f.settings({ reducedMotion: true })
    expect(f.startup.flyInAt()).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('greets resumed Sessions at rest and releases pending failures after disposal', async () => {
    const f = await fixture({ selected: true })
    f.startup.start()
    expect(f.startup.flyInAt()).toBeUndefined()
    expect(f.primary.refresh).not.toHaveBeenCalled()
    const failure = deferred()
    f.primary.refresh.mockReturnValueOnce(failure.promise)
    f.select(undefined)
    f.startup.dispose()
    const renders = f.render.mock.calls.length
    failure.reject(new Error('retired'))
    await failure.promise.catch(() => {})
    expect(f.render).toHaveBeenCalledTimes(renders)
  })
})
