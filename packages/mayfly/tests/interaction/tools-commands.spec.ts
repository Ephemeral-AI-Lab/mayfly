/** Shared tool browsing, native scope changes, and full schema inspection.
 * @module @ephemeral-ai/mayfly/tests/interaction/tools-commands
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { firstSentence, openToolDetail, toolDetailNode, toolItems } from '../../src/interaction/tools-commands.ts'
import { catalogFixture } from './catalog-fixture.ts'
import { flushRequests, renderRequest } from './request-fixture.ts'
import { ADVERSARIAL, SCAN_WIDTHS, expectLinesFit } from '../core/width-scan.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
async function setup() { const ctx = new Context(); contexts.push(ctx); return catalogFixture(ctx) }
const tool = (name: string, description = '') => ({ name, description, parameters: { type: 'object' as const, properties: { path: { type: 'string' as const } }, required: ['path'] } })
const accept = (controlId: string, id: string) => ({ kind: 'selection-accept' as const, controlId, pagePath: [], selectedIds: [id] })

describe('shared native tool catalogs', () => {
  it('keeps textual summaries independent of wrapping and retains full schema data', () => {
    expect(firstSentence('  First sentence. Second sentence.\nMore')).toBe('First sentence.')
    expect(firstSentence('中文。更多。')).toBe('中文。')
    expect(firstSentence('\n \n')).toBe('')
    expect(firstSentence('No punctuation')).toBe('No punctuation')
    expect(toolItems([tool('z'), tool('a')]).map(item => item.id)).toEqual(['a', 'z'])
    const source = '  source line\n\n' + 'long '.repeat(100)
    const node = toolDetailNode(tool('schema', source), key => key)
    expect(JSON.stringify(node)).toContain(JSON.stringify(source).slice(1, -1))
    expect(JSON.stringify(node)).toContain('required')
    expect(JSON.stringify(toolDetailNode({ name: 'empty', description: '' }, key => key))).toContain('(no parameters)')
  })

  it('opens exact-Agent choices, retains search when returning from detail, and never executes tools', async () => {
    const bench = await setup()
    await bench.register(tool('alpha', 'Read a path.'))
    await bench.register(tool('beta'))
    await bench.run('/tools')
    const model = bench.model('mayfly.tools')
    const renderer = renderRequest(model)
    renderer.input('alp')
    renderer.input('\r')
    await flushRequests()
    const detail = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.tools.detail')!
    expect(detail.scope).toEqual({ kind: 'session', sessionId: bench.agent.id })
    expect(JSON.stringify(detail.node)).toContain('Read a path.')
    detail.requestClose()
    await flushRequests()
    expect(model.disposed).toBe(false)
    expect(model.choice({ pagePath: [], controlId: 'tools' })!.query).toBe('alp')
    await bench.run('/tools')
    expect(bench.ctx.mayflyOverlays.list()).toHaveLength(1)
    expect(bench.execute).not.toHaveBeenCalled()
    renderer.runtime.dispose()
  })

  it('removes restricted tools using the real native scope and closes newly inaccessible details', async () => {
    const bench = await setup()
    await bench.register(tool('alpha'))
    await bench.register(tool('beta'))
    await bench.run('/tools')
    const model = bench.model('mayfly.tools')
    model.emit(accept('tools', 'alpha'))
    await flushRequests()
    const detail = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.tools.detail')!
    const lift = bench.restrict(['alpha'])
    await flushRequests()
    expect(bench.ctx.tools.schemas(bench.agent).map(tool => tool.name)).toEqual(['beta'])
    expect(bench.ctx.tools.schemas(bench.other).map(tool => tool.name)).toEqual(['alpha', 'beta'])
    expect(model.choice({ pagePath: [], controlId: 'tools' })!.definition.items.map(item => item.id)).toEqual(['beta'])
    expect(detail.disposed).toBe(true)
    lift()
    await flushRequests()
    expect(model.choice({ pagePath: [], controlId: 'tools' })!.definition.items).toHaveLength(2)
  })

  it('keeps empty catalogs reachable and reacts to registration and removal', async () => {
    const bench = await setup()
    await bench.run('/tools')
    const model = bench.model('mayfly.tools')
    expect(JSON.stringify(model.node)).toContain('No tools visible')
    const owner = await bench.register(tool('late'))
    await flushRequests()
    model.emit(accept('tools', 'late'))
    await flushRequests()
    expect(bench.ctx.mayflyOverlays.list()).toHaveLength(2)
    await owner.dispose()
    await flushRequests()
    expect(bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.tools.detail')).toBeUndefined()
    expect(model.choice({ pagePath: [], controlId: 'tools' })!.definition.items).toEqual([])
  })

  it('does not replace an unchanged document for unrelated native catalog changes', async () => {
    const bench = await setup()
    await bench.register(tool('alpha', 'Long document'))
    await bench.run('/tools')
    bench.model('mayfly.tools').emit(accept('tools', 'alpha'))
    await flushRequests()
    const detail = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.tools.detail')!
    const before = detail.registration.revision
    await bench.register(tool('unrelated'))
    await flushRequests()
    expect(detail.registration.revision).toBe(before)
  })

  it('contains malformed native schema refreshes, then recovers without executing a tool', async () => {
    const bench = await setup()
    await bench.register(tool('alpha'))
    await bench.run('/tools')
    const browser = bench.model('mayfly.tools')
    browser.emit(accept('tools', 'alpha'))
    await flushRequests()
    const detail = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.tools.detail')!
    const schemas = vi.spyOn(bench.ctx.tools, 'schemas').mockImplementation(() => { throw new Error('broken schema') })
    bench.ctx.emit('tools/change')
    await flushRequests()
    expect(JSON.stringify(browser.node)).toContain('Tool catalog unavailable')
    expect(JSON.stringify(detail.node)).toContain('Tool catalog unavailable')
    schemas.mockRestore()
    detail.invoke('refresh')
    browser.invoke('refresh')
    await flushRequests()
    expect(JSON.stringify(detail.node)).toContain('Parameters')
    expect(browser.choice({ pagePath: [], controlId: 'tools' })!.definition.items).toHaveLength(1)
    expect(bench.execute).not.toHaveBeenCalled()
  })

  it('rejects unavailable detail dependencies, cancelled calls, and missing tools', async () => {
    const empty = new Context()
    contexts.push(empty)
    const options = { id: 'detail', name: 'missing', signal: new AbortController().signal }
    expect(await openToolDetail(empty, {} as never, options)).toBe(false)
    empty.provide('tools', { schemas: () => [] } as never)
    expect(await openToolDetail(empty, {} as never, options)).toBe(false)

    const bench = await setup()
    const aborted = new AbortController()
    aborted.abort()
    expect(await openToolDetail(bench.ctx, bench.agent, { ...options, signal: aborted.signal })).toBe(false)
    expect(await openToolDetail(bench.ctx, bench.agent, options)).toBe(false)
  })

  it('coalesces native changes and contains stale direct detail and browser actions', async () => {
    const bench = await setup()
    await bench.register(tool('alpha'))
    await bench.run('/tools')
    const browserEntry = bench.ctx.mayflyOverlays.list().find(entry => entry.id === 'mayfly.tools')!
    bench.ctx.emit('tools/change')
    bench.ctx.emit('tools/change')
    await flushRequests()
    const context = (entry: typeof browserEntry, signal = new AbortController().signal) => ({ surfaceId: entry.id, operationId: 'direct', source: entry.source, revision: entry.revision, signal, report: vi.fn() })
    const aborted = new AbortController()
    aborted.abort()
    expect(await browserEntry.definition.onEvent!.action!(accept('tools', 'alpha'), context(browserEntry, aborted.signal))).toMatchObject({ kind: 'cancelled' })
    expect(await browserEntry.definition.onEvent!.action!({ kind: 'selection-accept', pagePath: [], controlId: 'tools', selectedIds: [] }, context(browserEntry))).toMatchObject({ kind: 'failed' })

    browserEntry.definition.onEvent!.action!(accept('tools', 'alpha'), context(browserEntry))
    await flushRequests()
    const detailEntry = bench.ctx.mayflyOverlays.list().find(entry => entry.id === 'mayfly.tools.detail')!
    bench.ctx.emit('tools/change')
    bench.ctx.emit('tools/change')
    await flushRequests()
    const detailAbort = new AbortController()
    detailAbort.abort()
    expect(await detailEntry.definition.onEvent!.action!({ kind: 'activate', pagePath: [], controlId: 'tool-actions', actionId: 'refresh' }, context(detailEntry, detailAbort.signal))).toMatchObject({ kind: 'cancelled' })
  })

  it('contains cancelled and wrong-Agent command invocations', async () => {
    const bench = await setup()
    const aborted = new AbortController()
    aborted.abort()
    const command = bench.ctx.commands.find(bench.agent, 'tools')!
    expect(await command.handler({ agent: bench.agent, rawInput: '', signal: aborted.signal } as never)).toEqual({ kind: 'success' })
    expect((await bench.ctx.commands.execute(bench.other, '/tools', [], new AbortController().signal))?.result).toEqual({ kind: 'error', text: 'no session is live yet' })
  })

  it('reaches the end of long descriptions and schemas without losing position on unrelated changes', async () => {
    const bench = await setup()
    await bench.register({ name: 'long', description: Array.from({ length: 100 }, (_, index) => `Description line ${index}`).join('\n'), parameters: { type: 'object', properties: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`parameter_${index}`, { type: 'string' }])) } })
    await bench.run('/tools')
    bench.model('mayfly.tools').emit(accept('tools', 'long'))
    await flushRequests()
    const detail = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.tools.detail')!
    const renderer = renderRequest(detail)
    expect(renderer.component.render(80).join('\n')).toContain('Description line 0')
    renderer.input('\x1b[F')
    expect(renderer.component.render(80).join('\n')).toContain('parameter_99')
    await bench.register(tool('unrelated'))
    await flushRequests()
    expect(renderer.component.render(80).join('\n')).toContain('parameter_99')
    renderer.runtime.dispose()
  })

  it.each(['agent', 'tools', 'frontend', 'parent'] as const)('retires the entire view tree on %s withdrawal', async reason => {
    const bench = await setup()
    await bench.register(tool('alpha'))
    await bench.run('/tools')
    const browser = bench.model('mayfly.tools')
    browser.emit(accept('tools', 'alpha'))
    await flushRequests()
    const detail = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.tools.detail')!
    if (reason === 'agent') bench.ctx.mayflyCurrentAgent.select(bench.other)
    else if (reason === 'parent') browser.requestClose()
    else await (reason === 'tools' ? bench.toolsOwner : bench.front).dispose()
    await flushRequests()
    expect(browser.disposed).toBe(true)
    expect(detail.disposed).toBe(true)
    browser.emit(accept('tools', 'alpha'))
    expect(bench.ctx.mayflyOverlays.list()).toEqual([])
  })

  it.each(ADVERSARIAL)('contains actual catalog and document metadata: $name', async ({ name, text }) => {
    const bench = await setup()
    await bench.register(tool('adversarial', text))
    await bench.run('/tools')
    const browser = bench.model('mayfly.tools')
    browser.emit(accept('tools', 'adversarial'))
    await flushRequests()
    const detail = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.tools.detail')!
    for (const model of [browser, detail]) {
      const viewport = { columns: 80, rows: 20 }
      const renderer = renderRequest(model, viewport)
      for (const width of SCAN_WIDTHS) for (const height of [20, 7, 3]) {
        viewport.columns = width; viewport.rows = height
        const rows = renderer.component.render(width)
        expectLinesFit(`tools/${name}/${height}`, rows, width)
        expect(rows.length).toBeLessThanOrEqual(height)
      }
      renderer.runtime.dispose()
    }
  })
})
