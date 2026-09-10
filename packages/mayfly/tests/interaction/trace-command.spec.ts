/** Headless tests for the native `/trace` query, document, and action flow.
 * @module @ephemeral-ai/mayfly/tests/interaction/trace-command
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { fakeMayflyContext } from './fakes.ts'
import { setClipboardOsc52Emitter, setClipboardTextWriter } from '../../src/interaction/clipboard-write.ts'
import { registerTraceCommand, traceDetailPanelModel, tracePanelModel } from '../../src/interaction/trace-command.ts'
import type { TraceItem } from '../../src/interaction/trace-format.ts'
import { mountUiRegistryObservers, UiInteractionService } from '../../src/core/ui-interaction-state.ts'
import { MayflyLocaleService } from '../../src/frontend/locale.ts'

const record = { sessionId: SessionId('trace-test'), seq: 0, time: 1, type: 'user/message', surface: 'current' as const }
const target = { type: 'user/message', seq: 0, time: 1, surfaceOp: 'append', data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } } as SessionEvent
const contexts: Context[] = []
const flush = () => new Promise<void>(resolve => { setImmediate(resolve) })

describe('registerTraceCommand', () => {
  let copied: string[]

  beforeEach(() => {
    copied = []
    setClipboardTextWriter(async text => { copied.push(text) })
    setClipboardOsc52Emitter(() => false)
  })

  afterEach(async () => {
    setClipboardTextWriter(undefined)
    setClipboardOsc52Emitter(undefined)
    for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  })

  it('builds complete empty, aggregated, and paged detail documents', () => {
    const empty = tracePanelModel('session', [])
    expect(empty).toMatchObject({ kind: 'surface', title: 'Trace · session' })
    expect(JSON.stringify(empty)).toContain('no trace events yet')
    const item: TraceItem = {
      seq: 3, lastSeq: 5, eventSeqs: [3, 4, 5], time: Number.NaN,
      type: 'assistant/attempt', surface: 'shadowed', title: 'Thinking', summary: 'first\nsecond',
    }
    const aggregated = JSON.stringify(tracePanelModel('session', [item]))
    expect(aggregated).toContain('??:??:?? #3-5 Thinking')
    expect(aggregated).toContain('first second')
    expect(aggregated).toContain('shadowed')
    const detail = JSON.stringify(traceDetailPanelModel(item, ['page one', 'page two'], 2))
    expect(detail).toContain('Trace detail #3-5')
    expect(detail).toContain('trace-document/2')
    expect(detail).toContain('page two')
    expect(detail).toContain('"id":"page","label":"Page","value":2')
  })

  async function mount(options: {
    session?: boolean
    query?: boolean
    display?: boolean
    events?: readonly SessionEvent[]
    read?: () => Promise<{ session: object, events: readonly SessionEvent[] }>
  } = {}) {
    const { ctx } = fakeMayflyContext({ display: options.display })
    contexts.push(ctx)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('trace-test'))
    const agent = { id: session.id, session, status: 'idle' } as never
    const state: { current: unknown | null } = { current: options.session === false ? null : agent }
    ctx.provide('testSession', state)
    const query = options.query === false ? undefined : {
      readSession: vi.fn(options.read ?? (async () => ({ session: {}, events: options.events ?? [target] }))),
      traceEvent: vi.fn(async () => ({ session: {}, target: record, replacementChain: [], replacedEventSeqs: [], sourceEventSeqs: [], derivedEventSeqs: [] })),
    }
    if (query !== undefined) ctx.provide('sessionQuery', query as never)
    new MayflyLocaleService(ctx, { systemLocale: 'en' })
    new UiInteractionService(ctx)
    mountUiRegistryObservers(ctx)
    await flush()
    const dispose = registerTraceCommand(ctx)
    const model = (id: string) => ctx.mayflyUiInteraction.get('overlay', id)
    return { ctx, dispose, agent, query, model, state }
  }

  it('copies all, copies one native event, and reports argument errors', async () => {
    const { ctx, dispose, agent } = await mount()
    expect(await ctx.commands.execute(agent, '/trace copy all', [], new AbortController().signal)).toMatchObject({ result: { kind: 'success' } })
    expect(copied[0]).toContain('# Trace')
    expect(await ctx.commands.execute(agent, '/trace copy 0', [], new AbortController().signal)).toMatchObject({ result: { kind: 'success' } })
    expect(copied[1]).toContain('hello')
    expect(await ctx.commands.execute(agent, '/trace copy 9', [], new AbortController().signal)).toMatchObject({ result: { kind: 'error', text: 'trace event #9 was not found' } })
    expect(await ctx.commands.execute(agent, '/trace invalid', [], new AbortController().signal)).toMatchObject({ result: { kind: 'error', text: expect.stringContaining('usage') } })
    setClipboardTextWriter(async () => { throw new Error('clipboard down') })
    expect(await ctx.commands.execute(agent, '/trace copy 0', [], new AbortController().signal)).toMatchObject({ result: { kind: 'error', text: 'could not copy trace: clipboard down' } })
    dispose()
  })

  it('opens root and detail surfaces and reports copy actions on their owning operation', async () => {
    const { ctx, agent, model } = await mount()
    expect(await ctx.commands.execute(agent, '/trace', [], new AbortController().signal)).toMatchObject({ result: { kind: 'success' } })
    await vi.waitFor(() => expect(model('mayfly.trace')).toBeDefined())
    const root = model('mayfly.trace')!
    root.emit({ kind: 'selection-accept', pagePath: [], controlId: 'trace-events', selectedIds: ['0'] })
    await vi.waitFor(() => expect(model('mayfly.trace.detail')).toBeDefined())
    const detail = model('mayfly.trace.detail')!
    expect(JSON.stringify(detail.node)).toContain('user/message')
    detail.invoke('copy')
    await vi.waitFor(() => expect(detail.feedbackSnapshot()).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'success', message: 'copied trace item #0' })])))
    root.invoke('copy-all')
    await vi.waitFor(() => expect(root.feedbackSnapshot()).toEqual(expect.arrayContaining([expect.objectContaining({ message: 'copied 1 trace events' })])))

    setClipboardTextWriter(async () => { throw new Error('native unavailable') })
    setClipboardOsc52Emitter(() => true)
    root.invoke('copy-all')
    await vi.waitFor(() => expect(root.feedbackSnapshot().some(item => item.message.includes('terminal escape sequence'))).toBe(true))

    setClipboardOsc52Emitter(() => false)
    root.invoke('copy-all')
    await vi.waitFor(() => expect(root.feedbackSnapshot()).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'error', message: 'could not copy trace: native unavailable' })])))
    ctx.mayflyOverlays.close('mayfly.trace.detail')
    ctx.mayflyOverlays.close('mayfly.trace')
  })

  it('keeps every long detail page reachable without rereading the session', async () => {
    const long = { ...target, data: { ...target.data, payload: `${'x'.repeat(20_000)}TAIL` } } as SessionEvent
    const { ctx, agent, query, model } = await mount({ events: [long] })
    await ctx.commands.execute(agent, '/trace', [], new AbortController().signal)
    const root = model('mayfly.trace')!
    root.emit({ kind: 'selection-accept', pagePath: [], controlId: 'trace-events', selectedIds: ['0'] })
    await vi.waitFor(() => expect(model('mayfly.trace.detail')?.form({ pagePath: [], formId: 'trace-page' })).toBeDefined())
    const detail = model('mayfly.trace.detail')!
    const page = { pagePath: [], formId: 'trace-page', fieldId: 'page' } as const
    const maximum = detail.form(page)!.fields.page!.definition.kind === 'number' ? detail.form(page)!.fields.page!.definition.max! : 1
    detail.edit(page, String(maximum))
    detail.invoke('go')
    await vi.waitFor(() => expect(JSON.stringify(detail.node)).toContain(`trace-document/${String(maximum)}`))
    expect(JSON.stringify(detail.node)).toContain('TAIL')
    expect(query?.readSession).toHaveBeenCalledOnce()
  })

  it('reports missing native state and still publishes a headless surface', async () => {
    const missing = await mount({ session: false })
    expect(await missing.ctx.commands.execute(missing.agent, '/trace', [], new AbortController().signal)).toMatchObject({ result: { kind: 'error', text: 'no session is live yet' } })
    const noQuery = await mount({ query: false })
    expect(await noQuery.ctx.commands.execute(noQuery.agent, '/trace', [], new AbortController().signal)).toMatchObject({ result: { kind: 'error', text: 'could not read trace: session query is unavailable' } })
    noQuery.dispose()
    expect(await noQuery.ctx.commands.execute(noQuery.agent, '/trace copy all', [], new AbortController().signal)).toBeUndefined()
    const broken = await mount({ read: async () => { throw 'broken' } })
    expect(await broken.ctx.commands.execute(broken.agent, '/trace', [], new AbortController().signal)).toMatchObject({ result: { text: 'could not read trace: broken' } })
    const headless = await mount({ display: false })
    expect(await headless.ctx.commands.execute(headless.agent, '/trace', [], new AbortController().signal)).toMatchObject({ result: { kind: 'success' } })
    await vi.waitFor(() => expect(headless.ctx.mayflyOverlays.list().map(entry => entry.id)).toContain('mayfly.trace'))
  })

  it('drops late reads and closes exact-Agent views on replacement or unload', async () => {
    const gate = Promise.withResolvers<{ session: object, events: readonly SessionEvent[] }>()
    const late = await mount({ read: () => gate.promise })
    const pending = late.ctx.commands.execute(late.agent, '/trace', [], new AbortController().signal)
    late.dispose()
    gate.resolve({ session: {}, events: [target] })
    await pending
    expect(late.ctx.mayflyOverlays.list()).toEqual([])

    const live = await mount()
    await live.ctx.commands.execute(live.agent, '/trace', [], new AbortController().signal)
    await vi.waitFor(() => expect(live.model('mayfly.trace')).toBeDefined())
    live.state.current = { id: live.agent.id, session: live.agent.session, status: 'idle' }
    live.ctx.emit('test/session-changed')
    await vi.waitFor(() => expect(live.ctx.mayflyOverlays.list()).toEqual([]))
  })

  it('contains pre-cancelled commands, focuses existing roots, and handles read races', async () => {
    const bench = await mount()
    const command = bench.ctx.commands.find(bench.agent, 'trace')!
    const aborted = new AbortController()
    aborted.abort()
    expect(await command.handler({ rawInput: '', signal: aborted.signal } as never)).toEqual({ kind: 'success' })
    await command.handler({ rawInput: '', signal: new AbortController().signal } as never)
    const root = bench.ctx.mayflyOverlays.list().find(entry => entry.id === 'mayfly.trace')!
    const focus = root.focusRevision
    expect(await command.handler({ rawInput: '', signal: new AbortController().signal } as never)).toEqual({ kind: 'success' })
    expect(bench.ctx.mayflyOverlays.list().find(entry => entry.id === root.id)!.focusRevision).toBeGreaterThan(focus)
    bench.ctx.mayflyOverlays.close(root.id)

    const failed = Promise.withResolvers<{ session: object, events: readonly SessionEvent[] }>()
    vi.spyOn(bench.query!, 'readSession').mockReturnValueOnce(failed.promise)
    const late = command.handler({ rawInput: '', signal: new AbortController().signal } as never)
    bench.state.current = { id: 'other' }
    failed.reject(new Error('late failure'))
    expect(await late).toEqual({ kind: 'success' })

    bench.state.current = bench.agent
    const gate = Promise.withResolvers<{ session: object, events: readonly SessionEvent[] }>()
    vi.spyOn(bench.query!, 'readSession').mockReturnValueOnce(gate.promise)
    const raced = command.handler({ rawInput: '', signal: new AbortController().signal } as never)
    const duplicate = bench.ctx.mayflyOverlays.open({ id: 'mayfly.trace', presentation: 'editor', capturing: true }, { kind: 'text', content: 'existing' })
    gate.resolve({ session: {}, events: [target] })
    expect(await raced).toEqual({ kind: 'success' })
    duplicate.close()
  })

  it('contains cancellation after relation lookup and clipboard settlement', async () => {
    const relation = { session: {}, target: record, replacementChain: [], replacedEventSeqs: [], sourceEventSeqs: [], derivedEventSeqs: [] }

    const duringRelation = await mount()
    const relationGate = Promise.withResolvers<typeof relation>()
    vi.spyOn(duringRelation.query!, 'traceEvent').mockReturnValueOnce(relationGate.promise)
    const relationAbort = new AbortController()
    const relationResult = duringRelation.ctx.commands.find(duringRelation.agent, 'trace')!.handler({ rawInput: 'copy 0', signal: relationAbort.signal } as never)
    await vi.waitFor(() => expect(duringRelation.query!.traceEvent).toHaveBeenCalled())
    relationAbort.abort()
    relationGate.resolve(relation)
    expect(await relationResult).toEqual({ kind: 'success' })

    const duringCopy = await mount()
    const copyGate = Promise.withResolvers<void>()
    const writer = vi.fn(() => copyGate.promise)
    setClipboardTextWriter(writer)
    const copyAbort = new AbortController()
    const copyResult = duringCopy.ctx.commands.find(duringCopy.agent, 'trace')!.handler({ rawInput: 'copy 0', signal: copyAbort.signal } as never)
    await vi.waitFor(() => expect(writer).toHaveBeenCalled())
    copyAbort.abort()
    copyGate.resolve()
    expect(await copyResult).toEqual({ kind: 'success' })

    const failedCopy = await mount()
    const rejection = Promise.withResolvers<never>()
    const failingWriter = vi.fn(() => rejection.promise)
    setClipboardTextWriter(failingWriter)
    const failedAbort = new AbortController()
    const failedResult = failedCopy.ctx.commands.find(failedCopy.agent, 'trace')!.handler({ rawInput: 'copy 0', signal: failedAbort.signal } as never)
    await vi.waitFor(() => expect(failingWriter).toHaveBeenCalled())
    failedAbort.abort()
    rejection.reject(new Error('late clipboard failure'))
    expect(await failedResult).toEqual({ kind: 'success' })
  })

  it('defends root and paged detail events and refreshes localized nodes', async () => {
    const long = { ...target, data: { ...target.data, payload: 'x'.repeat(20_000) } } as SessionEvent
    const bench = await mount({ events: [long] })
    await bench.ctx.commands.find(bench.agent, 'trace')!.handler({ rawInput: '', signal: new AbortController().signal } as never)
    const root = bench.ctx.mayflyOverlays.list().find(entry => entry.id === 'mayfly.trace')!
    const context = (entry: typeof root, signal = new AbortController().signal) => ({ surfaceId: entry.id, operationId: 'direct', source: entry.source, revision: entry.revision, signal, report: vi.fn() })
    expect(await root.definition.onEvent!.action!({ kind: 'activate', pagePath: [], controlId: 'noop', actionId: 'noop' }, context(root))).toEqual({ kind: 'completed' })
    expect(await root.definition.onEvent!.action!({ kind: 'selection-accept', pagePath: [], controlId: 'trace-events', selectedIds: ['missing'] }, context(root))).toEqual({ kind: 'completed' })
    const rootRevision = root.revision
    bench.ctx.mayflyLocale.setPreference('zh')
    await flush()
    expect(bench.ctx.mayflyOverlays.list().find(entry => entry.id === root.id)!.revision).toBeGreaterThan(rootRevision)

    await root.definition.onEvent!.action!({ kind: 'selection-accept', pagePath: [], controlId: 'trace-events', selectedIds: ['0'] }, context(root))
    const detail = bench.ctx.mayflyOverlays.list().find(entry => entry.id === 'mayfly.trace.detail')!
    expect(await detail.definition.onEvent!.action!({ kind: 'activate', pagePath: [], controlId: 'noop', actionId: 'noop' }, context(detail))).toEqual({ kind: 'completed' })
    expect(await detail.definition.onEvent!.action!({ kind: 'submit', submission: { actionId: 'go', source: [], forms: [] } }, context(detail))).toMatchObject({ kind: 'failed', message: 'Invalid page' })
    const page = (actionId: string, value: number) => ({ kind: 'submit' as const, submission: { actionId, source: [], forms: [{ pagePath: [], formId: 'trace-page', fields: [{ id: 'page', value, change: 'set' as const }] }] } })
    expect(await detail.definition.onEvent!.action!(page('next', 1), context(detail))).toMatchObject({ kind: 'accepted' })
    expect(await detail.definition.onEvent!.action!(page('previous', 2), context(detail))).toMatchObject({ kind: 'accepted' })
    bench.ctx.mayflyLocale.setPreference('en')
    await flush()
    expect(bench.ctx.mayflyOverlays.list().find(entry => entry.id === detail.id)!.node).toBeDefined()
  })

  it('omits copy feedback when authority disappears during the clipboard write', async () => {
    const bench = await mount()
    await bench.ctx.commands.find(bench.agent, 'trace')!.handler({ rawInput: '', signal: new AbortController().signal } as never)
    const root = bench.ctx.mayflyOverlays.list().find(entry => entry.id === 'mayfly.trace')!
    const gate = Promise.withResolvers<void>()
    const writer = vi.fn(() => gate.promise)
    setClipboardTextWriter(writer)
    const controller = new AbortController()
    const context = { surfaceId: root.id, operationId: 'copy-all', source: root.source, revision: root.revision, signal: controller.signal, report: vi.fn() }
    const pending = root.definition.onEvent!.action!({ kind: 'activate', pagePath: [], controlId: 'trace-actions', actionId: 'copy-all' }, context)
    await vi.waitFor(() => expect(writer).toHaveBeenCalled())
    controller.abort()
    gate.resolve()
    expect(await pending).toEqual({ kind: 'completed' })
  })
})
