/** Real command, native Host query, ordinary overlay, rc.2 presentation and generation boundaries. @module */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { MayflyTraceCatalogRequest, MayflyTraceDetailRequest, MayflyTraceDetail } from '@ephemeral-ai/mayfly-host/types'
import type { MayflyOverlayEntry, MayflyUiActionEvent, MayflyUiEventContext } from '@ephemeral-ai/mayfly-ui'
import { formatTraceAll, formatTraceItem, tracePanelModel } from '@ephemeral-ai/mayfly/trace'
import { visibleWidth } from '@ephemeral-ai/mayfly/core'
import { traceCatalog, traceDetail } from '../../../host/src/remote/trace-catalog.ts'
import { mountRemoteTraceOperations } from '../../src/remote/operations/trace.ts'
import { RemotePresentSlot, type RemoteOperationsContext } from '../../src/remote/operations/support.ts'
import { taskFixture, tick, translate, activated, good, bad } from './task-feature-fixture.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const stop of cleanups.splice(0).reverse()) await stop(); vi.restoreAllMocks() })
const choose = (id?: string, controlId = 'trace-events'): MayflyUiActionEvent => ({ kind: 'selection-accept', controlId, selectedIds: id === undefined ? [] : [id], pagePath: [] })
const dismiss: MayflyUiActionEvent = { kind: 'dismiss', pagePath: [] }
const wire = (seq: number, type: string, data: unknown): SessionEvent => ({ type, data, seq, time: 1_000 + seq }) as unknown as SessionEvent

async function fixture(selected = true, canCopy = true, columns?: number) {
  const f = await taskFixture(selected)
  const screen = { columns }
  if (columns !== undefined) { f.ctx.reflect.provide('mayflyScreen'); Object.assign(f.ctx, { mayflyScreen: screen }) }
  const events = Array.from({ length: 60 }, (_value, index) => wire(index, 'custom/event', { value: `Native ${index}`, nested: { text: 'raw payload' } }))
  events.push(wire(60, 'assistant/attempt', { turn: 1, step: 1, stream: [{ type: 'reasoning-chunks', time0: 1060, index: 0, dt: [], texts: ['reason'] }] }))
  events.push(wire(61, 'assistant/attempt', { turn: 1, step: 1, stream: [{ type: 'reasoning-chunks', time0: 1061, index: 0, dt: [], texts: ['ing'] }] }))
  events.push(wire(62, 'assistant/attempt', { turn: 1, step: 1, stream: [{ type: 'text-chunks', time0: 1062, index: 0, dt: [], texts: ['draft'] }] }))
  const relation = { replacedBy: 65, replacementChain: [65, 66], replacedEventSeqs: [2], sourceEventSeqs: [3], derivedEventSeqs: [67] }
  const readSession = vi.fn(async () => ({ events }))
  const nativeTrace = vi.fn(async (..._args: unknown[]) => relation)
  const activate = vi.fn()
  const native = { sessionQuery: { readSession, traceEvent: nativeTrace }, agents: { activate } } as unknown as Context
  const catalog = vi.fn(async (request: MayflyTraceCatalogRequest, signal: AbortSignal): Promise<unknown> => good(await traceCatalog(native, request, signal)))
  const detail = vi.fn(async (request: MayflyTraceDetailRequest, signal: AbortSignal): Promise<unknown> => good(await traceDetail(native, request, signal)))
  const capabilities = vi.fn(async (): Promise<unknown> => good({ features: ['trace'] }))
  Object.assign(f.client.remote, { mayflyHost: { capabilities, traceCatalog: catalog, traceDetail: detail } })
  const copy = vi.fn(async (_text: string): Promise<'native' | 'osc52' | void> => 'native')
  const options = { localCwd: '/work', ...canCopy ? { copy } : {} } as unknown as RemoteOperationsContext['options']
  const presentSlot = new RemotePresentSlot(options)
  const stop = mountRemoteTraceOperations({ base: f.options, options, presentSlot })
  cleanups.push(async () => { stop(); presentSlot.dispose(); await f.dispose() })
  const entry = () => f.ctx.mayflyOverlays.list().find(entry => entry.id === 'mayfly.trace')
  const eventContext = (entry: MayflyOverlayEntry, signal: AbortSignal): MayflyUiEventContext => ({ surfaceId: entry.id, source: entry.source, signal, revision: entry.revision, operationId: 'trace-action', report: vi.fn() })
  const act = async (event: MayflyUiActionEvent, signal = new AbortController().signal, snapshot = entry()!) => {
    const prepared = await snapshot.events.prepare(event, eventContext(snapshot, signal))
    prepared.publish()
    return prepared.reply
  }
  const open = async (input = '', signal = new AbortController().signal) => { await f.run('trace', input, signal); await tick(); return entry() }
  const node = () => entry()!.node
  const rows = async () => await traceCatalog(native, { sessionId: 'session' as never }, new AbortController().signal)
  return { ...f, events, screen, readSession, nativeTrace, activate, catalog, detail, capabilities, relation, copy, stop, entry, act, open, node, rows }
}

describe('canonical rc.2 trace command and ordinary overlay', () => {
  it('reads the complete native timeline, groups streams, and uses the exact shared reference node tree', async () => {
    const f = await fixture()
    const entry = (await f.open())!
    const items = await f.rows()
    expect(items).toHaveLength(62)
    expect(items.at(-2)).toMatchObject({ seq: 60, lastSeq: 61, eventSeqs: [60, 61], title: 'Thinking', summary: 'reasoning' })
    expect(entry.node).toEqual(tracePanelModel('session', items, translate))
    expect(f.catalog).toHaveBeenCalledWith({ sessionId: 'session' }, expect.any(AbortSignal))
    expect(f.readSession).toHaveBeenCalledWith('session')
    expect(f.activate).not.toHaveBeenCalled()
    expect(f.options.commands.list().find(row => row.name === 'trace')).toMatchObject({ description: 'Browse and copy the current session execution trace', input: { hint: '[copy <seq>|copy all]' } })
    expect(JSON.stringify(entry.node)).toContain('Native 0')
    const reads = f.catalog.mock.calls.length
    const focus = entry.focusRevision
    await f.open('   ')
    expect(f.catalog).toHaveBeenCalledTimes(reads)
    expect(f.entry()!.focusRevision).toBeGreaterThan(focus)
    for (const event of [choose('0', 'ignored'), choose('missing'), choose(), activated('ignored')]) expect(await f.act(event)).toEqual({ kind: 'completed' })
    expect(await f.act(choose('60'))).toEqual({ kind: 'completed' })
    const expectedDetail = JSON.stringify(f.events.slice(60, 62), null, 2)
    expect(f.node()).toEqual(tracePanelModel('session', items, translate, { selected: items.at(-2), document: expectedDetail, narrow: 'list', escapeLabel: 'close' }))
    expect(f.detail).toHaveBeenCalledWith({ sessionId: 'session', seq: 60, eventSeqs: [60, 61] }, expect.any(AbortSignal))
    for (const width of [1, 8, 20, 40, 80, 99, 100, 120]) expect(f.render(f.node(), width).every(row => visibleWidth(row) <= width)).toBe(true)
    expect(await f.act(dismiss)).toBeUndefined()
    expect(f.entry()).toBeUndefined()
    f.events.splice(0)
    await f.open()
    expect(f.node()).toEqual(tracePanelModel('session', [], translate))
    f.stop(); f.stop()
    expect(f.entry()).toBeUndefined(); expect(await f.run('trace')).toBe(false)
    expect(f.connections.size).toBe(0)
  })

  it('keeps the reference 100-column page/back boundary and closes one layer at a time', async () => {
    const f = await fixture(true, true, 99)
    await f.open(); await f.act(choose('60'))
    const items = await f.rows()
    expect(f.node()).toEqual(tracePanelModel('session', items, translate, { selected: items.at(-2), document: JSON.stringify(f.events.slice(60, 62), null, 2), narrow: 'detail', escapeLabel: 'back' }))
    expect(await f.act(dismiss)).toEqual({ kind: 'completed', dismiss: false })
    expect(f.node()).toEqual(tracePanelModel('session', items, translate, { selected: items.at(-2), document: JSON.stringify(f.events.slice(60, 62), null, 2), narrow: 'list', escapeLabel: 'close' }))
    await f.act(choose('61')); expect(f.nativeTrace).toHaveBeenCalledTimes(1)
    await f.act(choose('62')); f.screen.columns = 100
    f.ctx.mayflyLocale.setPreference('zh')
    expect(JSON.stringify(f.node())).toContain('界面')
    expect(JSON.stringify(f.node())).toContain('跟踪 · session')
    expect(await f.act(dismiss)).toBeUndefined()
    expect(f.entry()).toBeUndefined()
  })

  it('copies exact grouped raw events and native relationships with native/OSC52 feedback, including command grammar', async () => {
    const f = await fixture()
    const items = await f.rows()
    await f.open(' copy   60 ')
    expect(f.copy).toHaveBeenLastCalledWith(formatTraceItem(items.at(-2)!, undefined, f.relation, f.events.slice(60, 62)))
    expect(f.options.notice.set).toHaveBeenLastCalledWith('copied trace item #60', 'success')
    f.copy.mockResolvedValueOnce('osc52')
    await f.open('copy all')
    expect(f.copy).toHaveBeenLastCalledWith(formatTraceAll(items, 'session'))
    expect(f.options.notice.set).toHaveBeenLastCalledWith('copied 62 trace events via terminal escape sequence (unverified)', 'success')
    expect(f.entry()).toBeUndefined()
    await expect(f.open('user')).rejects.toThrow('usage: /trace [copy <seq>|copy all]')
    await expect(f.open('copy 61')).rejects.toThrow('trace event #61 was not found')
    await f.open()
    expect(await f.act(activated('copy'))).toMatchObject({ kind: 'completed', feedback: { message: 'copied 62 trace events' } })
    f.copy.mockResolvedValueOnce(undefined)
    expect(await f.act(activated('copy-all'))).toMatchObject({ kind: 'completed', feedback: { message: 'copied 62 trace events' } })
    await f.act(choose('60')); f.copy.mockResolvedValueOnce('osc52')
    expect(await f.act(activated('copy'))).toMatchObject({ kind: 'completed', feedback: { message: 'copied trace item #60 via terminal escape sequence (unverified)' } })
    expect(f.copy).toHaveBeenLastCalledWith(formatTraceItem(items.at(-2)!, undefined, f.relation, f.events.slice(60, 62)))
    f.copy.mockRejectedValueOnce(new Error('clipboard refused'))
    expect(await f.act(activated('copy'))).toEqual({ kind: 'failed', message: 'could not copy trace: clipboard refused' })
    f.detail.mockResolvedValueOnce(bad('query refused'))
    expect(await f.act(activated('copy'))).toEqual({ kind: 'failed', message: 'could not copy trace: query refused' })
    f.copy.mockRejectedValueOnce('command clipboard refused')
    await expect(f.open('copy 60')).rejects.toThrow('could not copy trace: command clipboard refused')
    const disabled = await fixture(true, false)
    await disabled.open()
    expect(await disabled.act(activated('copy-all'))).toEqual({ kind: 'failed', message: 'Copying is unavailable in this frontend' })
    await expect(disabled.open('copy all')).rejects.toThrow('Copying is unavailable in this frontend')
  })

  it('reports current native read failures, capability refusals and missing scope without inventing trace facts', async () => {
    const f = await fixture(false)
    await expect(f.open()).rejects.toThrow('no session is live yet')
    await expect(f.open('', AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' })
    f.select(true)
    f.capabilities.mockResolvedValueOnce(good({ features: [] }))
    await expect(f.open()).rejects.toThrow('could not read trace: trace is unavailable on this Host')
    f.capabilities.mockResolvedValueOnce(bad('capability refused'))
    await expect(f.open()).rejects.toThrow('could not read trace: capability refused')
    f.catalog.mockRejectedValueOnce(new Error('session query failed'))
    await expect(f.open()).rejects.toThrow('could not read trace: session query failed')
    f.catalog.mockResolvedValueOnce(bad('native query refused'))
    await expect(f.open()).rejects.toThrow('could not read trace: native query refused')
    await f.open()
    f.detail.mockRejectedValueOnce('detail query failed')
    expect(await f.act(choose('60'))).toEqual({ kind: 'failed', message: 'could not read trace: detail query failed' })
    expect(f.node()).toEqual(tracePanelModel('session', await f.rows(), translate))
  })
})

describe('exact trace generation and asynchronous ownership', () => {
  it('retains only the newest command capability/catalog read and retires cancellation, selection, detach and reconnect', async () => {
    for (const stage of ['capability', 'catalog'] as const) for (const retire of ['newer', 'cancel', 'select', 'detach', 'reconnect', 'unload'] as const) for (const reject of [false, true]) {
      const f = await fixture()
      const pending = Promise.withResolvers<unknown>()
      const method = stage === 'capability' ? f.capabilities : f.catalog
      method.mockReturnValueOnce(pending.promise)
      const abort = new AbortController()
      const old = f.open('', abort.signal)
      await tick()
      if (retire === 'newer') await f.open()
      else if (retire === 'cancel') abort.abort()
      else if (retire === 'select') f.select(false)
      else if (retire === 'detach') f.detach()
      else if (retire === 'reconnect') f.reconnect()
      else f.stop()
      const current = f.entry()
      if (reject) pending.reject('late native failure')
      else pending.resolve(stage === 'capability' ? good({ features: ['trace'] }) : good([]))
      await old
      expect(f.entry()).toBe(current)
      expect(f.options.notice.set).not.toHaveBeenCalled()
      if (stage === 'capability' && retire !== 'newer') expect(f.catalog).not.toHaveBeenCalled()
    }
  })

  it('fences older details, late failures, closed panels, cancelled actions, and silently replaced selection', async () => {
    for (const retire of ['newer', 'close', 'cancel', 'select', 'reconnect', 'unload', 'silent'] as const) for (const reject of [false, true]) {
      const f = await fixture()
      await f.open()
      const pending = Promise.withResolvers<unknown>()
      f.detail.mockReturnValueOnce(pending.promise)
      const abort = new AbortController()
      const old = f.act(choose('60'), abort.signal)
      await tick()
      if (retire === 'newer') await f.act(choose('62'))
      else if (retire === 'close') f.ctx.mayflyOverlays.close('mayfly.trace')
      else if (retire === 'cancel') abort.abort()
      else if (retire === 'select') f.select(false)
      else if (retire === 'reconnect') f.reconnect()
      else if (retire === 'silent') f.silentlyDeselect()
      else f.stop()
      const current = f.entry()?.node
      if (reject) pending.reject('retired detail failure')
      else pending.resolve(good({ rawEvents: [], relation: f.relation }))
      expect(await old).toEqual(retire === 'newer' || retire === 'silent' ? { kind: 'cancelled' } : undefined)
      await tick()
      expect(f.entry()?.node).toBe(current)
    }
  })

  it('retires clipboard/query success and failure after panel close, cancellation, generation replacement and newer commands', async () => {
    for (const stage of ['detail', 'clipboard'] as const) for (const retire of ['close', 'cancel', 'reconnect', 'unload', 'silent', 'command'] as const) for (const reject of [false, true]) {
      const f = await fixture()
      await f.open(); await f.act(choose('60'))
      const pending = Promise.withResolvers<unknown>()
      if (stage === 'detail') f.detail.mockReturnValueOnce(pending.promise)
      else f.copy.mockReturnValueOnce(pending.promise as Promise<'native'>)
      const abort = new AbortController()
      const old = retire === 'command' ? f.open('copy 60', abort.signal) : f.act(activated('copy'), abort.signal)
      await tick()
      if (retire === 'close') f.ctx.mayflyOverlays.close('mayfly.trace')
      else if (retire === 'cancel') abort.abort()
      else if (retire === 'reconnect') f.reconnect()
      else if (retire === 'unload') f.stop()
      else if (retire === 'silent') f.silentlyDeselect()
      else await f.open('copy all')
      if (reject) pending.reject('retired clipboard failure')
      else pending.resolve(stage === 'detail' ? good({ rawEvents: [], relation: f.relation } satisfies MayflyTraceDetail) : 'native')
      const result = await old
      if (retire !== 'command') expect(result).toEqual(retire === 'silent' ? { kind: 'cancelled' } : undefined)
      await tick()
      expect(vi.mocked(f.options.notice.set).mock.calls.flat()).not.toContain('copied trace item #60')
      expect(vi.mocked(f.options.notice.set).mock.calls.flat()).not.toContain('retired clipboard failure')
    }
  })

  it('closes live overlays on caller cancellation and rejects action callbacks after scope replacement', async () => {
    const f = await fixture()
    const abort = new AbortController()
    const old = (await f.open('', abort.signal))!
    abort.abort(); expect(f.entry()).toBeUndefined()
    await f.open()
    expect((await old.events.prepare(choose('60'), { surfaceId: old.id, source: old.source, revision: old.revision, operationId: 'old', signal: new AbortController().signal, report: vi.fn() })).reply).toBeUndefined()
    f.silentlyDeselect()
    expect(await f.act(choose('60'))).toEqual({ kind: 'cancelled', dismiss: true })
  })
})
