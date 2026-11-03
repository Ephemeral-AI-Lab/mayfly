/** Native SessionQuery trace reads, clipboard actions and exact-Agent timeline ownership. @module */
import { Context } from '@deepseek-ai/cordis'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerTraceCommand } from '../../src/interaction/trace-command.ts'
import { tracePanelModel, traceDetailBody } from '../../src/interaction/trace-model.ts'
import type { TraceItem } from '../../src/interaction/trace-format.ts'
import { copyTextToClipboard } from '../../src/interaction/clipboard-write.ts'
import { informationFixture } from './information-fixture.ts'
import { activate, nativeAction, select } from './native-action-fixture.ts'
import { flushRequests } from './request-fixture.ts'

vi.mock('../../src/interaction/clipboard-write.ts', () => ({ copyTextToClipboard: vi.fn(async () => 'native') }))
const contexts: Context[] = []
afterEach(async () => { vi.restoreAllMocks(); vi.mocked(copyTextToClipboard).mockReset().mockResolvedValue('native'); for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

// Exact reads and traces are the concrete native implementation; search is
// intentionally outside this command and must never be consulted by the test.
class NativeTraceQuery extends SessionQueryEngine {
  searchSessions(): Promise<never> { throw new Error('Trace does not search the corpus') }
  searchEvents(): Promise<never> { throw new Error('Trace does not search events') }
}

async function setup(noQuery = false, noScreen = false) {
  const ctx = new Context(); contexts.push(ctx)
  const f = await informationFixture(ctx)
  ctx.effect(() => () => f.agent.ctx.fiber.dispose())
  f.session.append('turn/start', { turn: 1 })
  f.session.append('assistant/attempt', { turn: 1, step: 0, stream: [{ type: 'text-chunks', index: 0, time0: 1, dt: [], texts: ['first '] }] })
  f.session.append('assistant/attempt', { turn: 1, step: 0, stream: [{ type: 'text-chunks', index: 0, time0: 2, dt: [], texts: ['second'] }] })
  f.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const query = noQuery ? undefined : await ctx.plugin(NativeTraceQuery)
  let unregister!: () => void
  const commandWorld = noScreen ? ctx.isolate('mayflyScreen') : ctx
  const fiber = await commandWorld.plugin({ name: 'native-trace-test-command', inject: ['commands', 'mayflyCurrentAgent', 'mayflyOverlays'], apply(owner: Context) { unregister = registerTraceCommand(owner) } })
  const definition = ctx.commands.find(f.agent, 'trace')!
  const invoke = (rawInput = '', signal = new AbortController().signal) => definition.handler({ agent: f.agent, signal, rawInput } as never)
  const model = () => ctx.mayflyUiInteraction.get('overlay', 'mayfly.trace')!
  const text = () => JSON.stringify(model().registration.node)
  const open = async () => { const result = await invoke(); await flushRequests(); return result }
  return { ...f, query, fiber, unregister, definition, invoke, model, text, open }
}

const item: TraceItem = { seq: 1, lastSeq: 2, eventSeqs: [1, 2], time: 0, type: 'assistant/attempt', surface: 'current', title: 'Assistant draft', summary: 'first\n  second' }

describe('native Trace readonly presentation', () => {
  it('keeps a single responsive browser and direct detail panels with empty/default documents', () => {
    expect(JSON.stringify(tracePanelModel('one', []))).toContain('no trace events yet')
    expect(JSON.stringify(tracePanelModel('one', [item], undefined, { selected: item }))).toContain('#1-2')
    expect(JSON.stringify(tracePanelModel('one', [{ ...item, lastSeq: 1 }], undefined, { selected: item, document: 'raw', narrow: 'detail', escapeLabel: 'back' }))).toContain('raw')
    expect(JSON.stringify(traceDetailBody(item, 'document'))).toContain('document')
  })
})

describe('native Trace command ownership', () => {
  it('reads real native SessionQuery observations, groups attempt chunks, and focuses one existing timeline', async () => {
    const f = await setup()
    expect(await f.open()).toEqual({ kind: 'success' })
    expect(f.text()).toContain('first second')
    expect(f.text()).toContain('#1-2')
    const model = f.model()
    await f.open()
    expect(f.model()).toBe(model)
    f.ctx.mayflyLocale.setPreference('zh')
    f.ctx.mayflyLocale.setPreference('en')
    expect(f.text()).toContain('Trace')
    await f.fiber.dispose()
    expect(model.disposed).toBe(true)
    expect(f.ctx.commands.find(f.agent, 'trace')).toBeUndefined()
  })

  it('opens narrow raw detail and consumes back before close while wide detail closes directly', async () => {
    const f = await setup()
    await f.open()
    expect(await nativeAction(f.model(), select('trace-events', 'missing'))).toMatchObject({ kind: 'completed' })
    expect(await nativeAction(f.model(), select('foreign', '1'))).toMatchObject({ kind: 'completed' })
    expect(await nativeAction(f.model(), activate('unrelated'))).toMatchObject({ kind: 'completed' })
    await nativeAction(f.model(), select('trace-events', '1'))
    expect(f.text()).toContain('"escapeLabel":"back"')
    expect(f.text()).toContain('first ')
    expect(await nativeAction(f.model(), { kind: 'dismiss', pagePath: [] })).toMatchObject({ kind: 'completed', dismiss: false })
    expect(await nativeAction(f.model(), { kind: 'dismiss', pagePath: [] })).toMatchObject({ kind: 'completed' })
    f.screen.columns = 120
    await nativeAction(f.model(), select('trace-events', '0'))
    expect(f.text()).toContain('"escapeLabel":"close"')
    expect(await nativeAction(f.model(), { kind: 'dismiss', pagePath: [] })).toMatchObject({ kind: 'completed' })
  })

  it('handles absent Agent, cancelled caller, missing query and invalid copy input without a view', async () => {
    const f = await setup(true)
    f.ctx.mayflyConversations.selectPrimary(null)
    expect(await f.invoke()).toEqual({ kind: 'error', text: 'no session is live yet' })
    f.ctx.mayflyConversations.selectPrimary(f.agent)
    expect(await f.invoke('', AbortSignal.abort())).toEqual({ kind: 'success' })
    expect(await f.invoke()).toEqual({ kind: 'error', text: 'could not read trace: session query is unavailable' })
    expect(f.ctx.mayflyOverlays.list()).toHaveLength(0)
    const ready = await setup()
    expect(await ready.invoke('nonsense')).toEqual({ kind: 'error', text: 'usage: /trace [copy <seq>|copy all]' })
    expect(await ready.invoke('copy 999')).toEqual({ kind: 'error', text: 'trace event #999 was not found' })
  })

  it.each([new Error('read denied'), 'string read'])('shows a current native read failure: %s', async error => {
    const f = await setup()
    vi.spyOn(f.ctx.sessionQuery, 'readSession').mockRejectedValueOnce(error)
    expect(await f.invoke()).toEqual({ kind: 'error', text: `could not read trace: ${error instanceof Error ? error.message : error}` })
  })

  it.each([false, true])('retires a late native read success/failure when its caller ends: failure=%s', async fails => {
    const f = await setup()
    const gate = Promise.withResolvers<Awaited<ReturnType<Context['sessionQuery']['readSession']>>>()
    vi.spyOn(f.ctx.sessionQuery, 'readSession').mockReturnValueOnce(gate.promise)
    const caller = new AbortController()
    const pending = f.invoke('', caller.signal)
    caller.abort()
    if (fails) gate.reject(new Error('late read'))
    else gate.resolve(await f.ctx.sessionQuery.readSession(f.agent.id))
    expect(await pending).toEqual({ kind: 'success' })
    expect(f.ctx.mayflyOverlays.list()).toHaveLength(0)
  })

  it('lets a concurrent native open win while an earlier read is pending', async () => {
    const f = await setup()
    const gate = Promise.withResolvers<Awaited<ReturnType<Context['sessionQuery']['readSession']>>>()
    vi.spyOn(f.ctx.sessionQuery, 'readSession').mockReturnValueOnce(gate.promise)
    const earlier = f.invoke()
    await f.open()
    const model = f.model()
    gate.resolve(await f.ctx.sessionQuery.readSession(f.agent.id))
    expect(await earlier).toEqual({ kind: 'success' })
    expect(f.model()).toBe(model)
    expect(f.ctx.mayflyOverlays.list()).toHaveLength(1)
  })

  it('uses the wide layout when no screen is installed and skips a queued publish after close', async () => {
    const f = await setup(false, true)
    await f.open()
    const model = f.model()
    const queued = f.ctx.mayflyOverlays.list().find(entry => entry.id === 'mayfly.trace')!.definition.onEvent!.action!
    const context = { surfaceId: model.id, source: model.source, revision: model.revision, operationId: 'queued-before-close', signal: new AbortController().signal, report: vi.fn() }
    f.ctx.mayflyOverlays.close('mayfly.trace')
    expect(await queued({ kind: 'selection-accept', pagePath: [], controlId: 'trace-events', selectedIds: ['1'] }, context)).toMatchObject({ kind: 'completed' })
    expect(model.disposed).toBe(true)
  })
})

describe('native Trace clipboard operations', () => {
  it('copies all native grouped events and complete item relations/raw payloads, including the OSC52 note', async () => {
    const f = await setup()
    expect(await f.invoke('copy all')).toEqual({ kind: 'success', text: 'copied 3 trace events' })
    expect(vi.mocked(copyTextToClipboard).mock.calls.at(-1)![0]).toContain('first second')
    vi.mocked(copyTextToClipboard).mockResolvedValueOnce('osc52')
    expect(await f.invoke('copy 1')).toEqual({ kind: 'success', text: 'copied trace item #1 via terminal escape sequence (unverified)' })
    expect(vi.mocked(copyTextToClipboard).mock.calls.at(-1)![0]).toContain('raw events:')
    await f.open()
    expect(await nativeAction(f.model(), activate('copy-all'))).toMatchObject({ kind: 'completed', feedback: { message: 'copied 3 trace events' } })
    await nativeAction(f.model(), select('trace-events', '1'))
    expect(await nativeAction(f.model(), activate('copy'))).toMatchObject({ kind: 'completed', feedback: { message: 'copied trace item #1' } })
  })

  it.each([new Error('clipboard denied'), 'string clipboard'])('reports current native clipboard failures from both command and panel: %s', async error => {
    const f = await setup()
    vi.mocked(copyTextToClipboard).mockRejectedValueOnce(error)
    expect(await f.invoke('copy all')).toEqual({ kind: 'error', text: `could not copy trace: ${error instanceof Error ? error.message : error}` })
    await f.open()
    vi.mocked(copyTextToClipboard).mockRejectedValueOnce(error)
    expect(await nativeAction(f.model(), activate('copy-all'))).toMatchObject({ kind: 'failed', message: `could not copy trace: ${error instanceof Error ? error.message : error}` })
  })

  it.each(['relation', 'clipboard', 'failure'] as const)('retires late %s copy work and drops acknowledgements on cancellation', async stage => {
    const f = await setup()
    await f.open()
    await nativeAction(f.model(), select('trace-events', '1'))
    const caller = new AbortController()
    if (stage === 'relation') {
      const relation = await f.ctx.sessionQuery.traceEvent({ sessionId: f.agent.id, seq: SessionSeq(1) })
      const gate = Promise.withResolvers<typeof relation>()
      vi.spyOn(f.ctx.sessionQuery, 'traceEvent').mockReturnValueOnce(gate.promise)
      const action = nativeAction(f.model(), activate('copy'), caller.signal)
      await flushRequests()
      caller.abort()
      gate.resolve(relation)
      expect(await action).toBeUndefined()
      expect(copyTextToClipboard).not.toHaveBeenCalled()
    } else {
      const gate = Promise.withResolvers<'native'>()
      vi.mocked(copyTextToClipboard).mockReturnValueOnce(gate.promise)
      const action = nativeAction(f.model(), activate('copy-all'), caller.signal)
      await flushRequests()
      caller.abort()
      if (stage === 'failure') gate.reject(new Error('late clipboard'))
      else gate.resolve('native')
      expect(await action).toBeUndefined()
    }
    expect(f.model().feedbackSnapshot()).toEqual([])
  })
})
