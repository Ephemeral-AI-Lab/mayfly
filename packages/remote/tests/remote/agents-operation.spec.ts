/** Native descendant tree parity, exact-parent stops and caller-owned reads. @module */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type { MayflyUiActionEvent, MayflyUiEventContext } from '@ephemeral-ai/mayfly-ui'
import type { MayflySubagentTreeEntry } from '../../src/frontend/host-contract.ts'
import { mountRemoteAgentsOperations } from '../../src/remote/operations/agents.ts'
import { RemotePresentSlot, type RemoteOperationsContext } from '../../src/remote/operations/support.ts'
import type { RemoteBrowserOptions } from '../../src/remote/panels/browser.ts'
import { taskFixture, tick, activated, good, bad } from './task-feature-fixture.ts'

const native = vi.hoisted(() => ({ browser: vi.fn() }))
vi.mock('../../src/remote/panels/browser.ts', () => ({ openRemoteBrowser: native.browser }))
const eventContext = (signal = new AbortController().signal): MayflyUiEventContext => ({ surfaceId: 'mayfly.agents', source: [], signal, revision: 1, operationId: 'action', report: vi.fn() })
const choose = (id?: string, controlId = 'subagents'): MayflyUiActionEvent => ({ kind: 'selection-accept', controlId, selectedIds: id === undefined ? [] : [id], pagePath: [] })
const stopEvent = (id?: string): MayflyUiActionEvent => ({ ...activated('stop'), ...id === undefined ? {} : { inputs: { actionId: 'stop', draftRevision: 1, source: [], forms: [], selections: [{ pagePath: [], controlId: 'subagents', selectedIds: [id] }] } } })
const row = (id: string, extra: Partial<Extract<MayflySubagentTreeEntry, { readonly kind: 'child' }>> = {}): MayflySubagentTreeEntry => ({
  kind: 'child', id: SessionId(id), parentId: SessionId('session'), depth: 1, activity: 'inactive', hasChildren: false, mode: 'continuable', label: id, ...extra,
})
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const stop of cleanups.splice(0).reverse()) await stop(); vi.restoreAllMocks(); native.browser.mockReset() })

async function fixture(selected = true, primary = false) {
  const f = await taskFixture(selected)
  const primarySelection = f.options.hosts.current()
  let entries: readonly MayflySubagentTreeEntry[] = [
    row('child', { label: 'Build worker', activity: 'running', hasChildren: true, live: true, tokens: 2048, toolCount: 2 }),
    row('grandchild', { parentId: SessionId('child'), depth: 2 }),
    row('cold', { mode: 'one-shot', label: 'Cold reader', stopBlocked: 'not-continuable' }),
    row('external', { mode: 'external' }), row('btw', { label: 'btw' }),
    { kind: 'diagnostic', id: SessionId('diagnostic'), parentId: SessionId('session'), depth: 1, reason: 'corrupt' },
  ]
  const catalogListeners = new Set<() => void>()
  const addresses = new Map<string, SubagentAddress>([
    ['child', { parentSessionId: SessionId('session'), childSessionId: SessionId('child'), mode: 'continuable' }],
    ['grandchild', { parentSessionId: SessionId('child'), childSessionId: SessionId('grandchild'), mode: 'continuable' }],
  ])
  const sessions = { list: { getSnapshot: () => ({ byId: { child: { cwd: '/work/child' } } }), subscribe: (listener: () => void) => { catalogListeners.add(listener); return () => { catalogListeners.delete(listener) } } }, subagentAddress: (id: string) => addresses.get(id) }
  const tree = vi.fn(async (..._args: unknown[]) => good(entries))
  const stopping = vi.fn(async (..._args: unknown[]) => good({ kind: 'success' as const, text: 'stopped subagent child' }))
  Object.assign(f.client, { sessions }); Object.assign(f.client.remote, { mayflyHost: { subagentTree: tree, subagentStop: stopping } })
  const present = vi.fn(), closePresent = vi.fn(), showPrimary = vi.fn(), release = vi.fn()
  const retain = vi.fn((..._args: unknown[]) => ({ ready: Promise.resolve({ sessionId: SessionId('child') }), release }))
  const options = { localCwd: '/work', present, closePresent, showPrimary, ...primary ? { primary: () => primarySelection } : {}, btw: { retainColdSubagentView: retain } } as unknown as RemoteOperationsContext['options']
  const presentSlot = new RemotePresentSlot(options)
  const context: RemoteOperationsContext = { base: f.options, options, presentSlot }
  const panels: Array<{ options: RemoteBrowserOptions, refresh: ReturnType<typeof vi.fn<() => void>>, close: ReturnType<typeof vi.fn<() => void>>, closed: boolean }> = []
  let closeOnOpen = false
  native.browser.mockImplementation((_base, options: RemoteBrowserOptions) => {
    const result = { options, refresh: vi.fn(), closed: false, close: vi.fn(() => { if (result.closed) return; result.closed = true; options.onClosed?.() }) }
    panels.push(result)
    if (closeOnOpen) result.close()
    return result
  })
  const stop = mountRemoteAgentsOperations(context)
  cleanups.push(async () => { stop(); presentSlot.dispose(); await f.dispose() })
  const act = async (event: MayflyUiActionEvent, signal?: AbortSignal) => await panels.at(-1)!.options.action!(event, eventContext(signal))
  const open = async (signal?: AbortSignal) => { await f.run('agents', '', signal); return panels.at(-1)! }
  const text = () => JSON.stringify(panels.at(-1)!.options.view())
  return { ...f, context, primarySelection, tree, stopping, present, closePresent, retain, release, addresses, panels, stop, act, open, text, showPrimary, catalogListeners,
    setEntries: (next: readonly MayflySubagentTreeEntry[]) => { entries = next },
    catalog: () => { for (const listener of catalogListeners) listener() },
    closeDuringOpen: () => { closeOnOpen = true },
  }
}

describe('reference descendant command and presentation', () => {
  it('uses the exact rc.2 parser, primary session and native tree rather than catalog reconstruction', async () => {
    const f = await fixture(false)
    await f.open()
    expect(f.options.notice.set).toHaveBeenCalledWith('no session is live yet', 'error')
    expect(f.panels).toEqual([])
    for (const input of ['close', 'child', 'stop', 'stop child extra']) await expect(f.run('agents', input)).rejects.toThrow('usage: /agents [stop <id>]')
    f.select(true)
    const panel = await f.open()
    expect(f.showPrimary).toHaveBeenCalledOnce()
    expect(f.tree).toHaveBeenCalledWith({ sessionId: 'session' }, expect.any(AbortSignal))
    expect(panel.options.id).toBe('mayfly.agents')
    expect(panel.options.scope).toEqual({ kind: 'session', sessionId: 'session' })
    const node = panel.options.view()
    expect(JSON.stringify(node)).toContain('Build worker')
    expect(JSON.stringify(node)).not.toContain('btw')
    expect(JSON.stringify(node)).toContain('"tree":true')
    expect(JSON.stringify(node)).toContain('"filterMode":"slash"')
    expect(JSON.stringify(node)).toContain('"key":"x"')
    expect(JSON.stringify(node)).toContain('Stop selected subagent?')
    expect(JSON.stringify(node)).toContain('Its live Agent shuts down; the stored conversation stays browsable.')
    expect(JSON.stringify(node)).not.toContain('agents-open')
    expect(f.context.base.commands.list()[0]!.input).toEqual({ hint: '[stop <id>]' })
  })

  it('keeps primary ownership while a child conversation is displayed', async () => {
    const f = await fixture(true, true)
    f.silentlyDeselect()
    const panel = await f.open()
    expect(panel.options.isCurrent()).toBe(true)
    expect(f.tree).toHaveBeenCalledWith({ sessionId: 'session' }, expect.any(AbortSignal))
    expect(f.showPrimary).toHaveBeenCalledOnce()
  })

  it('shows empty and native read failures without mounting a browser', async () => {
    const f = await fixture()
    f.setEntries([row('btw', { label: 'btw' })])
    await f.open()
    expect(f.options.notice.set).toHaveBeenCalledWith('no subagents in this session')
    expect(f.panels).toEqual([])
    f.tree.mockResolvedValueOnce(bad('tree refused') as never)
    await f.open()
    expect(f.options.notice.set).toHaveBeenCalledWith('tree refused', 'error')
    f.tree.mockRejectedValueOnce('tree failed')
    await f.open()
    expect(f.options.notice.set).toHaveBeenCalledWith('tree failed', 'error')
  })

  it('localizes native stop reasons before the shared reference tree blocks unavailable actions', async () => {
    const f = await fixture()
    f.setEntries(['not-continuable', 'not-live', 'live-descendants', 'parent-not-live'].map((stopBlocked, index) => row(String(index), { stopBlocked: stopBlocked as 'not-live' })))
    await f.open()
    for (const reason of ['Only continuable subagents can be stopped', 'Not live; there is nothing to stop', 'Stop its live descendants first', 'Its direct parent is not live']) expect(f.text()).toContain(reason)
  })
})

describe('exact native descendant stop', () => {
  it('supports /agents stop <id>, native refusal, failure, and stops the exact child view', async () => {
    const f = await fixture()
    await f.run('agents', 'stop\tchild')
    expect(f.stopping).toHaveBeenCalledWith({ sessionId: 'session', childSessionId: 'child' }, expect.any(AbortSignal))
    expect(f.closePresent).toHaveBeenCalledWith({ host: f.client.key, sessionId: 'child' })
    expect(f.options.notice.set).toHaveBeenCalledExactlyOnceWith('stopped subagent child', 'info')
    f.stopping.mockResolvedValueOnce(bad('unknown subagent: missing') as never)
    await f.run('agents', 'stop missing')
    expect(f.options.notice.set).toHaveBeenCalledWith('unknown subagent: missing', 'error')
    f.stopping.mockRejectedValueOnce(new Error('stop failed'))
    await f.run('agents', 'stop child')
    expect(f.options.notice.set).toHaveBeenCalledWith('stop failed', 'error')
  })

  it('reads the selected row from the confirmed action, relists after real stop and preserves feedback', async () => {
    const f = await fixture()
    const panel = await f.open()
    expect(await f.act(stopEvent())).toEqual({ kind: 'failed', message: 'Select a subagent first' })
    expect(await f.act(activated('other'))).toEqual({ kind: 'completed' })
    expect(await f.act({ kind: 'dismiss', pagePath: [] })).toEqual({ kind: 'completed' })
    expect(await f.act(stopEvent('child'))).toEqual({ kind: 'completed', feedback: { severity: 'success', message: 'stopped subagent child' } })
    expect(f.tree).toHaveBeenCalledTimes(2)
    expect(panel.refresh).toHaveBeenCalledOnce()
    f.stopping.mockResolvedValueOnce(bad('stop its live descendants first') as never)
    expect(await f.act(stopEvent('child'))).toEqual({ kind: 'failed', message: 'stop its live descendants first' })
    expect(f.tree).toHaveBeenCalledTimes(2)
  })

  it('retires pending native success or failure across caller abort, connection and unload', async () => {
    for (const mode of ['caller', 'connection', 'unload'] as const) for (const reject of [false, true]) {
      const f = await fixture()
      const caller = new AbortController()
      const pending = Promise.withResolvers<Awaited<ReturnType<typeof f.stopping>>>()
      f.stopping.mockReturnValueOnce(pending.promise)
      const result = f.run('agents', 'stop child', caller.signal)
      if (mode === 'caller') caller.abort()
      else if (mode === 'connection') f.reconnect()
      else f.stop()
      if (reject) pending.reject('late failure'); else pending.resolve(good({ kind: 'success', text: 'stopped subagent child' }))
      await result
      expect(f.closePresent).not.toHaveBeenCalled()
      expect(f.options.notice.set).not.toHaveBeenCalled()
    }
  })

  it('passes action cancellation to native stop and rejects stale retained dispatchers', async () => {
    const f = await fixture()
    await f.open()
    expect(await f.act(stopEvent('child'), AbortSignal.abort())).toEqual({ kind: 'cancelled' })
    expect(f.stopping).not.toHaveBeenCalled()
    const caller = new AbortController()
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof f.stopping>>>()
    f.stopping.mockReturnValueOnce(pending.promise)
    const result = f.act(stopEvent('child'), caller.signal)
    caller.abort()
    expect((f.stopping.mock.calls[0]![1] as AbortSignal).aborted).toBe(true)
    pending.resolve(good({ kind: 'success', text: 'stopped subagent child' }))
    expect(await result).toEqual({ kind: 'cancelled' })
    f.silentlyDeselect()
    expect(await f.act(stopEvent('child'))).toEqual({ kind: 'cancelled' })
  })
})

describe('selected subagent conversations', () => {
  it('opens on tree acceptance, closes the browser and preserves native addressing/cwd', async () => {
    const f = await fixture()
    const panel = await f.open()
    for (const event of [choose(), choose('diagnostic'), choose('missing'), choose('child', 'other')]) expect(await f.act(event)).toEqual({ kind: 'completed' })
    expect(await f.act(choose('external'))).toEqual({ kind: 'failed', message: 'External subagents have no local conversation' })
    expect(await f.act(choose('child'))).toEqual({ kind: 'completed' })
    expect(panel.close).toHaveBeenCalledOnce()
    expect(f.retain).toHaveBeenCalledWith({ host: f.client.key, sessionId: 'session' }, { host: f.client.key, sessionId: 'child' }, 'remote-agents-cold')
    expect(f.present).toHaveBeenCalledWith({ host: f.client.key, sessionId: 'child' }, expect.anything(), { kind: 'subagent', access: 'interactive', label: 'Build worker', cwd: '/work/child', address: f.addresses.get('child') })
    expect(f.options.notice.set).not.toHaveBeenCalled()
    await f.open()
    expect(await f.act(choose('grandchild'))).toEqual({ kind: 'completed' })
    expect(f.present.mock.calls.at(-1)![2]).toMatchObject({ access: 'resumable', address: f.addresses.get('grandchild') })
    await f.open()
    expect(await f.act(choose('cold'))).toEqual({ kind: 'completed' })
    expect(f.present.mock.calls.at(-1)![2]).toEqual({ kind: 'subagent', access: 'readonly', label: 'Cold reader' })
    f.setEntries([{ kind: 'child', id: SessionId('unlabeled'), parentId: SessionId('session'), depth: 1, activity: 'inactive', hasChildren: false, mode: 'one-shot' }])
    await f.open()
    expect(await f.act(choose('unlabeled'))).toEqual({ kind: 'completed' })
    expect(f.present.mock.calls.at(-1)![2]).toMatchObject({ label: 'unlabeled' })
  })

  it('fences selected child acquisition after the tree closes but preserves the original caller', async () => {
    for (const reject of [false, true]) {
      const f = await fixture()
      const caller = new AbortController()
      await f.open(caller.signal)
      const pending = Promise.withResolvers<unknown>()
      f.retain.mockReturnValueOnce({ ready: pending.promise, release: f.release } as never)
      const result = f.act(choose('child'))
      caller.abort()
      expect(f.release).toHaveBeenCalledOnce()
      if (reject) pending.reject('late lease failure'); else pending.resolve({})
      expect(await result).toEqual({ kind: 'cancelled' })
      expect(f.present).not.toHaveBeenCalled()
    }
    const f = await fixture()
    await f.open()
    f.retain.mockImplementationOnce(() => { throw new Error('cannot retain') })
    expect(await f.act(choose('child'))).toEqual({ kind: 'failed', message: 'cannot retain' })
  })
})

describe('browser read lifecycle', () => {
  it('pre-abort and retained commands after unload cannot focus, read, mount, or publish', async () => {
    const f = await fixture()
    await f.open(AbortSignal.abort())
    expect(f.showPrimary).not.toHaveBeenCalled()
    const retained = f.context.base.commands.list()[0]!
    f.stop()
    await retained.execute('', new AbortController().signal)
    expect(f.tree).not.toHaveBeenCalled()
    expect(f.context.base.commands.list()).toEqual([])
  })

  it('does not admit work for a detached Client left in a stale selection snapshot', async () => {
    const f = await fixture(true, true)
    f.detach()
    await f.open()
    await f.run('agents', 'stop child')
    expect(f.tree).not.toHaveBeenCalled()
    expect(f.stopping).not.toHaveBeenCalled()
    expect(f.panels).toEqual([])
  })

  it('retires initial discovery, old browser owners and queued catalog callbacks on replacement', async () => {
    const f = await fixture()
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof f.tree>>>()
    f.tree.mockReturnValueOnce(pending.promise)
    const first = f.open()
    const second = await f.open()
    pending.resolve(good([row('stale')]))
    await first
    expect(f.panels).toHaveLength(1)
    expect(f.text()).not.toContain('stale')
    const callback = [...f.catalogListeners][0]!
    f.stop()
    expect(second.close).toHaveBeenCalledOnce()
    const reads = f.tree.mock.calls.length
    callback()
    expect(f.tree).toHaveBeenCalledTimes(reads)
    expect(f.catalogListeners.size).toBe(0)
  })

  it('does not mount after stale initial errors or add observers to a synchronously closed browser', async () => {
    const f = await fixture()
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof f.tree>>>()
    f.tree.mockReturnValueOnce(pending.promise)
    const result = f.open()
    f.reconnect()
    pending.reject('late initial failure')
    await result
    expect(f.options.notice.set).not.toHaveBeenCalled()
    expect(f.panels).toEqual([])
    f.closeDuringOpen()
    const browser = await f.open()
    expect(browser.closed).toBe(true)
    expect(f.catalogListeners.size).toBe(0)
  })

  it('refreshes whole native rows, keeps the last readable tree on errors and coalesces pending reads', async () => {
    const f = await fixture()
    const panel = await f.open()
    f.setEntries([row('new', { activity: 'running' })])
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof f.tree>>>()
    f.tree.mockReturnValueOnce(pending.promise)
    f.catalog(); f.catalog()
    expect(f.tree).toHaveBeenCalledTimes(2)
    pending.resolve(good([row('new', { activity: 'running' })]))
    await tick()
    expect(f.text()).toContain('new')
    f.tree.mockRejectedValueOnce('background failure')
    f.catalog(); await tick()
    expect(f.text()).toContain('new')
    expect(f.options.notice.set).not.toHaveBeenCalled()
    const paints = panel.refresh.mock.calls.length
    const late = Promise.withResolvers<Awaited<ReturnType<typeof f.tree>>>()
    f.tree.mockReturnValueOnce(late.promise)
    f.catalog(); panel.close()
    late.resolve(good([row('late')]))
    await tick()
    expect(panel.refresh).toHaveBeenCalledTimes(paints)
  })

  it('ticks only running descendants and releases the timer after native settlement', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const f = await fixture()
      const panel = await f.open()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(panel.refresh).toHaveBeenCalledOnce()
      f.setEntries([row('settled')])
      f.catalog(); await tick()
      const reads = f.tree.mock.calls.length
      await vi.advanceTimersByTimeAsync(2_000)
      expect(f.tree).toHaveBeenCalledTimes(reads)
      f.stop()
    } finally { vi.useRealTimers() }
  })
})
