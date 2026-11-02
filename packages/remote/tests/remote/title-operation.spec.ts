/** Exact native title subscriptions and stale notification retirement. @module */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TITLE_MAX_CHARS } from '@ephemeral-ai/mayfly/core'
import { mountRemoteTitleOperations } from '../../src/remote/operations/title.ts'
import { RemotePresentSlot, type RemoteOperationsContext } from '../../src/remote/operations/support.ts'
import { projection } from './approval-feature-fixture.ts'
import { taskFixture } from './task-feature-fixture.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const stop of cleanups.splice(0).reverse()) await stop(); vi.restoreAllMocks() })

async function fixture(selected = true) {
  const f = await taskFixture(selected)
  const title = projection<unknown>(undefined)
  const catalog = projection<{ byId: Record<string, { displayTitle: string }> }>({ byId: { session: { displayTitle: 'Native title' } } })
  const current = f.options.hosts.current()
  if (current !== undefined) Object.assign(current.binding.session, { projections: { faceOf: () => title } })
  Object.assign(f.client, { sessions: { list: catalog } })
  const setTitle = vi.fn()
  Object.assign(f.options, { screen: { setTitle } })
  const options = { localCwd: '/local', btw: {} } as RemoteOperationsContext['options']
  const presentSlot = new RemotePresentSlot(options)
  const stop = mountRemoteTitleOperations({ base: f.options, options, presentSlot })
  cleanups.push(async () => { stop(); presentSlot.dispose(); await f.dispose() })
  return { ...f, title, catalog, setTitle, stop }
}

describe('native terminal title ownership', () => {
  it('reads exact projected titles with a catalog fallback and deduplicates native publications', async () => {
    const f = await fixture()
    expect(f.setTitle).toHaveBeenLastCalledWith('Native title')
    f.title.set('Projected title')
    expect(f.setTitle).toHaveBeenLastCalledWith('Projected title')
    const calls = f.setTitle.mock.calls.length
    f.catalog.set({ byId: { session: { displayTitle: 'New native title' } } })
    expect(f.setTitle).toHaveBeenCalledTimes(calls)
    f.title.set({ value: 'Record title' })
    expect(f.setTitle).toHaveBeenLastCalledWith('Record title')
    f.title.set({ value: 1 })
    expect(f.setTitle).toHaveBeenLastCalledWith('New native title')
    f.title.set(12)
    f.catalog.set({ byId: {} })
    expect(f.setTitle).toHaveBeenLastCalledWith('mayfly')
    f.title.set('')
    expect(f.setTitle).toHaveBeenLastCalledWith('mayfly')
    f.title.set('界'.repeat(TITLE_MAX_CHARS + 3))
    expect(f.setTitle).toHaveBeenLastCalledWith('界'.repeat(TITLE_MAX_CHARS))
  })

  it('restores fallback on detach and retires queued old title callbacks on reconnect or disposal', async () => {
    const f = await fixture()
    const queued = [...f.title.listeners][0]!
    f.reconnect()
    const count = f.setTitle.mock.calls.length
    queued()
    expect(f.setTitle).toHaveBeenCalledTimes(count)
    const afterReconnect = [...f.title.listeners][0]!
    f.detach()
    expect(f.setTitle).toHaveBeenLastCalledWith('mayfly')
    afterReconnect()
    expect(f.setTitle).toHaveBeenLastCalledWith('mayfly')
    f.stop(); f.stop(); queued()
    expect(f.title.listeners.size + f.catalog.listeners.size).toBe(0)
    expect(f.topology.size + f.connections.size).toBe(0)
    const empty = await fixture(false)
    expect(empty.setTitle).toHaveBeenLastCalledWith('mayfly')
    empty.stop()
    expect(empty.setTitle).toHaveBeenCalledTimes(2)
  })
})
