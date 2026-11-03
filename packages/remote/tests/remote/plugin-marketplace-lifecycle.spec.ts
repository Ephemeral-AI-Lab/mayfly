/** Real Cordis overlay replacement, acknowledgement, rendering and native manager ownership. @module */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MayflyOverlayEntry, MayflyUiActionEvent, MayflyUiEventContext } from '@ephemeral-ai/mayfly-ui'
import { visibleWidth } from '@ephemeral-ai/mayfly/core'
import { mountRemoteMarketplace } from '../../src/remote/operations/plugin-marketplace.ts'
import { RemotePresentSlot, type RemoteOperationsContext } from '../../src/remote/operations/support.ts'
import { taskFixture, tick, activated, good } from './task-feature-fixture.ts'

const mocks = vi.hoisted(() => ({ catalog: vi.fn() }))
vi.mock('@ephemeral-ai/mayfly/plugin-marketplace', async importOriginal => ({ ...await importOriginal<object>(), loadMarketCatalog: mocks.catalog }))
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks() })

async function fixture() {
  const f = await taskFixture()
  const entry = { id: 'alpha', displayName: 'Native Alpha', description: 'Reads project files.', source: 'community', author: { name: 'Example' }, category: 'tools', status: 'stable', surfaces: { server: {} }, install: { rows: [{ name: '@scope/alpha', npm: { spec: '@scope/alpha@2.0.0' } }] } }
  mocks.catalog.mockReset()
  mocks.catalog.mockResolvedValue({ status: 'fresh', index: { schemaVersion: 1, entries: [entry] } })
  const nativeBundle = { name: '@scope/alpha', version: '2.0.0', enabled: true, installed: true, removable: true, official: false, availability: 'profile', optional: false, updatable: true, rows: [], overrides: [] }
  let installed = false
  const manager = {
    listBundles: vi.fn(async () => good(installed ? [nativeBundle] : [])),
    installBundle: vi.fn(async (..._args: unknown[]) => { installed = true; return good({ application: 'restart-required' }) }),
    removeBundle: vi.fn(async (..._args: unknown[]) => { installed = false; return good({ application: 'restart-required' }) }),
    setBundleEnabled: vi.fn(async (..._args: unknown[]) => good({ application: 'applied' })),
  }
  Object.assign(f.client.remote, { pluginManager: manager })
  const options = { localCwd: '/work' } as RemoteOperationsContext['options']
  const presentSlot = new RemotePresentSlot(options)
  const stop = mountRemoteMarketplace({ base: f.options, options, presentSlot })
  cleanups.push(async () => { stop(); presentSlot.dispose(); await f.dispose() })
  const panel = () => f.ctx.mayflyOverlays.list().find(row => row.id === 'mayfly.plugin-market')!
  const context = (row: MayflyOverlayEntry, signal: AbortSignal): MayflyUiEventContext => ({ surfaceId: row.id, source: row.source, revision: row.revision, operationId: 'market-action', signal, report: vi.fn() })
  const act = async (event: MayflyUiActionEvent, signal = new AbortController().signal, row = panel()) => {
    const prepared = await row.events.prepare(event, context(row, signal))
    prepared.publish()
    return prepared.reply
  }
  const open = async (input = '', signal = new AbortController().signal) => { await f.run('plugin', input, signal); await tick(); return panel() }
  return { ...f, manager, stop, panel, act, open }
}

describe('real marketplace command and ordinary overlay boundary', () => {
  it.each(['remove', 'abort'] as const)('retires a marketplace closed during its initial publication without starting later reads: %s', async reason => {
    const f = await fixture()
    const abort = new AbortController()
    const off = f.ctx.mayflyOverlays.subscribe(delta => {
      if (delta.kind !== 'upsert' || delta.entry.id !== 'mayfly.plugin-market') return
      if (reason === 'remove') f.ctx.mayflyOverlays.close(delta.entry.id)
      else abort.abort()
    })
    try {
      await expect(f.run('plugin', '', abort.signal)).resolves.toBe(true)
      await tick()
      expect(f.ctx.mayflyOverlays.list()).toEqual([])
      expect(f.manager.listBundles).not.toHaveBeenCalled()
      expect(mocks.catalog).not.toHaveBeenCalled()
      expect(f.options.notice.set).not.toHaveBeenCalled()
    } finally { off() }
    // The closed mount cannot retain an owner that interferes with the next command.
    await f.open()
    expect(JSON.stringify(f.panel().node)).toContain('Native Alpha')
    expect(f.manager.listBundles).toHaveBeenCalledOnce()
    expect(mocks.catalog).toHaveBeenCalledOnce()
  })

  it('replaces the rc.2 browser on repeated commands, drops its old action endpoint, and preserves native restart feedback', async () => {
    const f = await fixture()
    const old = await f.open()
    const loadingId = old.id
    expect(JSON.stringify(old.node)).toContain('Native Alpha')
    for (const input of ['list', 'updates', '', 'info alpha']) {
      await f.open(input)
      expect(f.ctx.mayflyOverlays.list().filter(row => row.id === loadingId)).toHaveLength(1)
    }
    expect(await f.act(activated('install'), new AbortController().signal, old)).toBeUndefined()
    expect(f.manager.installBundle).not.toHaveBeenCalled()
    expect(await f.act(activated('install'))).toMatchObject({ kind: 'accepted', feedback: { severity: 'success', message: 'installed; restart Mayfly and start a new session to apply' } })
    expect(f.manager.installBundle).toHaveBeenCalledWith('@scope/alpha@2.0.0', { enabled: true })
    expect(f.ctx.mayflyStatus.list().find(row => row.id === 'mayfly.plugin-restart')).toBeDefined()
    expect(JSON.stringify(f.panel().node)).toContain('1 change applies after you restart Mayfly')
    for (const width of [1, 8, 20, 40, 80, 99, 100, 120]) expect(f.render(f.panel().node, width).every(row => visibleWidth(row) <= width)).toBe(true)
    await f.open('list')
    expect(await f.act(activated('remove'))).toMatchObject({ kind: 'accepted', feedback: { severity: 'success', message: 'removed; restart Mayfly and start a new session to apply' } })
    expect(f.manager.removeBundle).toHaveBeenCalledWith('@scope/alpha')
    f.stop(); f.stop(); expect(f.ctx.mayflyOverlays.list()).toEqual([])
    expect(f.ctx.mayflyStatus.list()).toEqual([]); expect(await f.run('plugin')).toBe(false)
  })

  it('closes only the local browser on caller cancellation/reconnect and fences pending native acknowledgement', async () => {
    const f = await fixture()
    const abort = new AbortController()
    await f.open('', abort.signal); abort.abort()
    expect(f.ctx.mayflyOverlays.list()).toEqual([])
    await f.open('info alpha')
    const pending = Promise.withResolvers<ReturnType<typeof good<{ application: 'restart-required' }>>>()
    f.manager.installBundle.mockReturnValueOnce(pending.promise)
    const operation = f.act(activated('install'))
    await tick(); f.reconnect()
    pending.resolve(good({ application: 'restart-required' }))
    expect(await operation).toBeUndefined()
    await tick()
    expect(f.ctx.mayflyOverlays.list()).toEqual([])
    expect(f.ctx.mayflyStatus.list()).toEqual([])
    expect(f.manager.installBundle).toHaveBeenCalledOnce()
  })
})
