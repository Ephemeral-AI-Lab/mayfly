/** Shared information nodes over real token-meter/session-stats projections.
 * @module @ephemeral-ai/mayfly/tests/interaction/session-commands
 */
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sessionInfoFacts } from '../../src/interaction/session-commands.ts'
import { changelogNode, contextNode, formatCreated, statusNode, usageNode, versionNode, type SessionInfoFacts } from '../../src/interaction/session-info-model.ts'
import { MAYFLY_VERSION } from '../../src/transcript/banner-content.ts'
import { informationFixture } from './information-fixture.ts'
import { flushRequests, renderRequest } from './request-fixture.ts'
import { ADVERSARIAL, SCAN_WIDTHS, expectLinesFit } from '../core/width-scan.ts'
import { ui } from '../../../ui/src/index.ts'
import { sessionTreeItems } from '../../src/interaction/session-tree.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
async function setup(version?: string) { const ctx = new Context(); contexts.push(ctx); return informationFixture(ctx, version) }

describe('native session information', () => {
  it('reads usage, context, and counts from one consistent native snapshot', async () => {
    const bench = await setup()
    bench.session.append('turn/start', { turn: 1 })
    bench.session.append('step/start', { turn: 1, step: 0 })
    bench.session.append('request/context', { provider: 'p', model: 'm', contextWindow: 1024 })
    bench.session.append('assistant/message', {
      turn: 1,
      step: 0,
      message: createAssistantMessage({ content: [], source: { kind: 'model', provider: 'p', model: 'm' } }),
      stream: [],
      usage: { inputTokens: 100, outputTokens: 7, cacheReadTokens: 20, cacheWriteTokens: 10 },
    }, { surfaceOp: 'append' })
    bench.session.append('step/end', { turn: 1, step: 0 })
    const snapshot = vi.spyOn(bench.ctx.sessionProjections, 'snapshot')
    const facts = sessionInfoFacts(bench.ctx, bench.agent)
    expect(snapshot).toHaveBeenCalledOnce()
    expect(snapshot.mock.calls[0]![0]).toBe(bench.session)
    expect(facts).toMatchObject({ id: 'current', cwd: '/repo/current', turns: 1, steps: 1, usage: { buckets: { input: 100, output: 7, cacheRead: 20, cacheWrite: 10 }, context: { used: 130, window: 1024 } } })
    expect(sessionInfoFacts(bench.ctx, bench.other)).toMatchObject({ id: 'other', turns: 0, steps: 0, usage: { buckets: { input: 0, output: 0 } } })
  })

  it('updates live status for its exact session and retains the same instance across repaint', async () => {
    const bench = await setup()
    await bench.run('/status')
    const model = bench.model('mayfly.status')
    const initial = model.registration.revision
    bench.otherSession.append('turn/start', { turn: 1 })
    await flushRequests()
    expect(model.registration.revision).toBe(initial)
    bench.session.append('turn/start', { turn: 1 })
    bench.session.append('step/end', { turn: 1, step: 0 })
    await flushRequests()
    expect(model.registration.revision).toBeGreaterThan(initial)
    expect(JSON.stringify(model.node)).toContain('1970-01-01 00:00 UTC')
    await bench.run('/status')
    expect(bench.ctx.mayflyOverlays.list()).toHaveLength(1)
    expect(bench.model('mayfly.status')).toBe(model)
  })

  it('keeps application metadata usable across current-Agent and projection provider gaps', async () => {
    const bench = await setup('acceptance-build')
    await bench.run('/status')
    const status = bench.model('mayfly.status')
    await bench.run('/version')
    const version = bench.model('mayfly.version')
    expect(JSON.stringify(version.node)).toContain('vacceptance-build')
    await bench.projections.dispose()
    await flushRequests()
    expect(status.disposed).toBe(true)
    expect(version.disposed).toBe(false)
    await bench.app.dispose()
    await bench.run('/changelog')
    expect(bench.model('mayfly.changelog').scope.kind).toBe('app')
    expect(version.disposed).toBe(false)
  })

  it('retires Agent views on selection changes and uses placeholders for absent native units', async () => {
    const bench = await setup()
    await bench.stats.dispose()
    await bench.meter.dispose()
    expect(sessionInfoFacts(bench.ctx, bench.agent)).toMatchObject({ turns: 0, steps: 0, usage: { context: {}, buckets: { input: 0 } } })
    await bench.run('/context')
    const model = bench.model('mayfly.context')
    expect(JSON.stringify(model.node)).toContain('no provider usage recorded yet')
    bench.ctx.mayflyCurrentAgent.select(bench.other)
    await flushRequests()
    expect(model.disposed).toBe(true)
  })

  it('contains projection read failures and recovers on an explicit refresh', async () => {
    const bench = await setup()
    await bench.run('/status')
    const model = bench.model('mayfly.status')
    const read = vi.spyOn(bench.ctx.sessionProjections, 'snapshot').mockImplementation(() => { throw new Error('unavailable') })
    model.invoke('refresh')
    await flushRequests()
    expect(JSON.stringify(model.node)).toContain('Session information unavailable')
    expect(model.feedbackSnapshot().at(-1)?.severity).toBe('error')
    read.mockRestore()
    model.invoke('refresh')
    await flushRequests()
    expect(JSON.stringify(model.node)).toContain('/repo/current')
    expect(model.feedbackSnapshot()).toEqual([])
  })

  it('updates Agent status and localized presentation from the corresponding facts', async () => {
    const bench = await setup()
    await bench.run('/status')
    const model = bench.model('mayfly.status')
    Object.assign(bench.agent, { status: 'running' })
    bench.ctx.emit('agent/status', { agent: bench.agent, status: 'running' })
    bench.ctx.mayflyLocale.setPreference('zh')
    await flushRequests()
    expect(JSON.stringify(model.node)).toContain('创建时间')
    expect(JSON.stringify(model.node)).toContain('运行中')
    bench.ctx.emit('agent/status', { agent: bench.other, status: 'idle' })
    bench.ctx.emit('session-projection/changed', bench.otherSession, 'tokenUsage' as never)
    bench.ctx.emit('session-projection/changed', bench.session, 'unrelated' as never)
  })

  it('projects field values and chart data without preformatted character grids', () => {
    const facts: SessionInfoFacts = { id: 'id', createdAt: NaN, status: 'idle', turns: 2, steps: 3, model: { provider: 'p', model: 'm', reasoningEffort: 'high' }, usage: { buckets: { input: 10, cacheRead: 20, cacheWrite: 30, output: 40 }, context: { used: 900, window: 1000 } }, composition: { system: 1, tools: 200, messages: 300 } }
    const value = JSON.stringify(usageNode(facts, key => key))
    expect(value).toContain('"chart":"bar"')
    expect(value).toContain('0.1%')
    expect(value).toContain('Context usage (heuristic)')
    expect(value).not.toMatch(/[█▓▒░]/u)
    expect(JSON.stringify(statusNode(facts, { mayfly: 'test', harness: 'native' }, key => key))).toContain('high')
    expect(formatCreated(NaN)).toBe('unknown UTC')
    expect(JSON.stringify(versionNode({ mayfly: 'custom', harness: 'native' }))).toContain('vcustom')
    expect(JSON.stringify(contextNode({ window: 1000 }, key => key))).toContain('no request')
    expect(JSON.stringify(contextNode({}, key => key))).toContain('not advertised')
    expect(JSON.stringify(changelogNode([{ version: MAYFLY_VERSION, summary: 'summary', highlights: ['long '.repeat(100)], knownIssues: ['known'] }], key => key))).toContain('known')
    expect(JSON.stringify(contextNode({ used: 750, window: 1000 }, key => key))).toContain('warning')
    expect(JSON.stringify(contextNode({ used: 1500, window: 1000 }, key => key))).toContain('1.5k / 1000 (100%)')
    const normalized = contextNode({ used: 12.25, window: 100.5 }, key => key)
    expect(normalized.kind).toBe('stack')
    if (normalized.kind !== 'stack') throw new Error('context node is not a stack')
    expect(normalized.children[0]!.node).toMatchObject({ kind: 'progress', value: 13, max: 101 })
    expect(JSON.stringify(contextNode({ used: Number.NaN, window: 1000 }, key => key))).toContain('no request')
    expect(JSON.stringify(contextNode({ used: 10, window: Number.POSITIVE_INFINITY }, key => key))).toContain('not advertised')
    expect(JSON.stringify(usageNode({ ...facts, usage: { ...facts.usage, context: {} } }, key => key))).not.toContain('%')
    const normalizedComposition = JSON.stringify(usageNode({
      ...facts,
      composition: { system: Number.NaN, tools: -1, messages: Number.POSITIVE_INFINITY },
    }, key => key))
    expect(normalizedComposition.match(/"values":\[0\]/gu)).toHaveLength(3)
  })

  it('renders fractional native context estimates through the command surface', async () => {
    const bench = await setup()
    vi.spyOn(bench.ctx.sessionProjections, 'snapshot').mockReturnValue({
      asOfSeq: 0,
      values: {
        tokenUsage: {},
        contextPressure: { projectedTokens: 12.25, contextWindow: 100.5 },
      },
    } as never)
    await bench.run('/context')
    const model = bench.model('mayfly.context')
    expect(JSON.stringify(model.node)).toContain('13 / 101 (13%)')
    const rendered = renderRequest(model)
    const rows = rendered.component.render(80).join('\n')
    expect(rows).toContain('13/101')
    expect(rows).not.toContain('must be a finite integer')
    rendered.runtime.dispose()
  })

  it('projects optional cwd, model defaults, and pressure fallback facts', async () => {
    const bench = await setup()
    const fallback = { provider: 'fallback', model: 'model' }
    bench.ctx.provide('agentDefaultModel', { currentSelection: () => fallback } as never)
    vi.spyOn(bench.ctx.sessionProjections, 'snapshot').mockReturnValue({
      asOfSeq: 0,
      values: {
        sessionStats: { turns: 1, steps: 2 },
        tokenUsage: {},
        contextPressure: { pressureTokens: 12, contextWindow: 100 },
      },
    } as never)
    const agent = { ...bench.agent, session: { ...bench.session, header: { ...bench.session.header, cwd: undefined } } } as Agent
    expect(sessionInfoFacts(bench.ctx, agent)).toMatchObject({ model: fallback, usage: { context: { used: 12, window: 100 } } })
    expect(sessionInfoFacts(bench.ctx, agent)).not.toHaveProperty('cwd')
  })

  it('handles static command refresh, focus, preabort, and synchronous close', async () => {
    const bench = await setup()
    const command = bench.ctx.commands.find(bench.agent, 'version')!
    const aborted = new AbortController()
    aborted.abort()
    expect(await command.handler({ agent: bench.agent, signal: aborted.signal } as never)).toEqual({ kind: 'success' })
    expect(await command.handler({ agent: bench.agent, signal: new AbortController().signal } as never)).toEqual({ kind: 'success' })
    const entry = bench.ctx.mayflyOverlays.list().find(item => item.id === 'mayfly.version')!
    const context = { surfaceId: entry.id, operationId: 'refresh', source: entry.source, revision: entry.revision, signal: new AbortController().signal, report: vi.fn() }
    expect(await entry.definition.onEvent!.action!({ kind: 'activate', pagePath: [], controlId: 'information-actions', actionId: 'refresh' }, context)).toEqual({ kind: 'completed' })
    expect(await entry.definition.onEvent!.action!({ kind: 'activate', pagePath: [], controlId: 'noop', actionId: 'noop' }, context)).toEqual({ kind: 'completed' })
    const focus = bench.ctx.mayflyOverlays.list().find(item => item.id === entry.id)!.focusRevision
    await command.handler({ agent: bench.agent, signal: new AbortController().signal } as never)
    expect(bench.ctx.mayflyOverlays.list().find(item => item.id === entry.id)!.focusRevision).toBeGreaterThan(focus)
    bench.ctx.mayflyOverlays.close(entry.id)

    bench.ctx.mayflyOverlays.subscribe(delta => { if (delta.kind === 'upsert' && delta.entry.id === 'mayfly.changelog') bench.ctx.mayflyOverlays.close(delta.entry.id) })
    expect(await bench.ctx.commands.find(bench.agent, 'changelog')!.handler({ agent: bench.agent, signal: new AbortController().signal } as never)).toEqual({ kind: 'success' })
    expect(bench.ctx.mayflyOverlays.list().some(item => item.id === 'mayfly.changelog')).toBe(false)
  })

  it('contains cancelled, wrong-Agent, and opening-aborted live commands', async () => {
    const bench = await setup()
    const command = bench.ctx.commands.find(bench.agent, 'status')!
    const aborted = new AbortController()
    aborted.abort()
    expect(await command.handler({ agent: bench.agent, signal: aborted.signal } as never)).toEqual({ kind: 'success' })
    expect(await command.handler({ agent: bench.other, signal: new AbortController().signal } as never)).toEqual({ kind: 'error', text: 'no session is live yet' })

    const opening = new AbortController()
    bench.ctx.mayflyOverlays.subscribe(delta => { if (delta.kind === 'upsert' && delta.entry.id === 'mayfly.status') opening.abort() })
    expect(await command.handler({ agent: bench.agent, signal: opening.signal } as never)).toEqual({ kind: 'success' })
    expect(bench.ctx.mayflyOverlays.list().some(item => item.id === 'mayfly.status')).toBe(false)
  })

  it('ignores unrelated projection notifications', async () => {
    const bench = await setup()
    let listener!: (session: typeof bench.session, key: string) => void
    vi.spyOn(bench.ctx.sessionProjections, 'onChanged').mockImplementation(callback => { listener = callback as typeof listener; return () => {} })
    await bench.run('/status')
    listener(bench.otherSession as typeof bench.session, 'tokenUsage')
    listener(bench.session, 'unrelated')
    await flushRequests()
    expect(bench.model('mayfly.status')).toBeDefined()
  })

  it('promotes cyclic session parents and orders tied timestamps by id', () => {
    const headers = [
      { id: 'a', createdAt: 1, parentSession: 'b' },
      { id: 'b', createdAt: 1, parentSession: 'a' },
      { id: 'c', createdAt: 1 },
      { id: 'e', createdAt: 1, parentSession: 'c' },
      { id: 'd', createdAt: 1, parentSession: 'c' },
    ] as never
    const items = sessionTreeItems(headers, new Map(), 'd', String)
    expect(items.map(item => item.id)).toEqual(['c', 'e', 'd', 'b', 'a'])
    expect(items.find(item => item.id === 'd')).toMatchObject({ parentId: 'c', badge: '← current' })
    expect(items.find(item => item.id === 'a')!.parentId).toBeUndefined()
  })

  it.each(ADVERSARIAL)('contains status, context, and changelog data: $name', async ({ name, text }) => {
    const bench = await setup()
    const facts: SessionInfoFacts = { id: text, cwd: text, createdAt: 0, status: 'running', turns: 1, steps: 2, model: { provider: text, model: text }, usage: { buckets: { input: 100, cacheRead: 0, cacheWrite: 0, output: 10 }, context: { used: 110, window: 1000 } }, composition: { system: 100, tools: 200, messages: 300 } }
    for (const node of [statusNode(facts, { mayfly: text, harness: 'native' }, key => key), usageNode(facts, key => key), changelogNode([{ version: 'test', summary: text, highlights: [text], knownIssues: [text] }], key => key)]) {
      const handle = bench.ctx.mayflyOverlays.open({ id: 'width-info', capturing: true }, ui.scroll(node, { scrollbar: true }))
      const model = bench.ctx.mayflyUiInteraction.get('overlay', 'width-info')!
      const viewport = { columns: 80, rows: 20 }
      const renderer = renderRequest(model, viewport)
      for (const width of SCAN_WIDTHS) for (const height of [20, 7, 3]) {
        viewport.columns = width; viewport.rows = height
        const rows = renderer.component.render(width)
        expectLinesFit(`information/${name}/${height}`, rows, width)
        expect(rows.length).toBeLessThanOrEqual(height)
      }
      renderer.runtime.dispose(); handle.close()
    }
  })
})
