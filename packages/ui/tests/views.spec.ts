/** The views lane's public surface: a `views` pane, its summary, and `setSummary`.
 * @module @ephemeral-ai/mayfly-ui/tests/views
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/provider.ts'
import type { MayflyPaneDefinition, MayflyPaneSummary, MayflySnapshotProvider, MayflyUiNode } from '../src/contracts.ts'
import { ui } from '../src/index.ts'

const summaryNode = ui.richText([{ text: 'Agents 5', tone: 'muted' }])
const view = (id: string, extra: Partial<MayflyPaneDefinition> = {}): MayflyPaneDefinition => ({ id, placement: 'views', title: 'Agents', ...extra })

async function api(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin({ name: 'api-owner', apply })
  return ctx
}

describe('views pane definitions', () => {
  it('registers with an initial summary and lists it on the entry, not on the definition-only entries of other panes', async () => {
    const ctx = await api()
    const summary: MayflyPaneSummary = { node: summaryNode, count: 5 }
    ctx.mayflyPanes.register(view('test.agents', { summary }), ui.text('panel'))
    ctx.mayflyPanes.register({ id: 'test.bottom', placement: 'bottom' }, ui.text('bottom'))
    const [agents, bottom] = ctx.mayflyPanes.list()
    expect(agents!.summary).toEqual(summary)
    expect(Object.isFrozen(agents!.summary)).toBe(true)
    expect('summary' in bottom!).toBe(false)
  })

  it('starts without a summary as null, so the view stays out of row 2 until it declares one', async () => {
    const ctx = await api()
    ctx.mayflyPanes.register(view('test.agents'), ui.text('panel'))
    expect(ctx.mayflyPanes.list()[0]!.summary).toBeNull()
  })

  it.each([
    ['a size', { size: { min: 10 } }],
    ['a narrow policy', { narrow: 'overlay' as const }],
  ])('refuses %s, which a view does not have', async (_name, extra) => {
    const ctx = await api()
    expect(() => ctx.mayflyPanes.register(view('test.agents', extra))).toThrow('neither size nor narrow')
  })

  it('refuses a summary on any other placement', async () => {
    const ctx = await api()
    expect(() => ctx.mayflyPanes.register({ id: 'test.bottom', placement: 'bottom', summary: { node: summaryNode } })).toThrow('only a views pane')
  })

  it.each([
    ['a non-object summary', 'Agents 5', 'must be an object'],
    ['an unknown field', { node: summaryNode, label: 'x' }, 'unknown field'],
    ['no node', {}, 'must be a status node'],
    ['a null node', { node: null }, 'must be a status node'],
    ['an array node', { node: [] }, 'must be a status node'],
    ['an interactive node', { node: ui.loader({ message: 'busy' }) }, 'must be a status node'],
    ['a non-finite count', { node: summaryNode, count: Number.POSITIVE_INFINITY }, 'count must be'],
    ['an object count', { node: summaryNode, count: {} }, 'count must be'],
    ['a long count', { node: summaryNode, count: 'x'.repeat(33) }, 'count must be'],
  ])('refuses %s', async (_name, summary, message) => {
    const ctx = await api()
    expect(() => ctx.mayflyPanes.register(view('test.agents', { summary: summary as never }))).toThrow(message)
  })

  it('accepts a string count and a stack summary', async () => {
    const ctx = await api()
    ctx.mayflyPanes.register(view('test.todo', { summary: { node: ui.stack.row([ui.child(ui.text('Todo'))]) as never, count: '2/6' } }))
    expect(ctx.mayflyPanes.list()[0]!.summary!.count).toBe('2/6')
  })
})

describe('setSummary', () => {
  it('republishes the entry at the same revision and node, and null takes the view out of row 2', async () => {
    const ctx = await api()
    const deltas = vi.fn()
    const pane = ctx.mayflyPanes.register(view('test.agents', { summary: { node: summaryNode, count: 5 } }), ui.text('panel'))
    ctx.mayflyPanes.subscribe(deltas)
    deltas.mockClear()
    const before = ctx.mayflyPanes.list()[0]!
    pane.setSummary({ node: ui.richText([{ text: 'Agents 6' }]), count: 6 })
    const after = ctx.mayflyPanes.list()[0]!
    expect(after.revision).toBe(before.revision)
    expect(after.node).toBe(before.node)
    expect(after.summary!.count).toBe(6)
    expect(pane.revision).toBe(0)
    expect(deltas).toHaveBeenCalledTimes(1)
    pane.setSummary(null)
    expect(ctx.mayflyPanes.list()[0]!.summary).toBeNull()
    expect(deltas).toHaveBeenCalledTimes(2)
  })

  it('keeps the summary across a panel publish and does not disturb an in-flight refresh', async () => {
    const ctx = await api()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const load: MayflySnapshotProvider<MayflyUiNode | null> = async () => { await gate; return { node: ui.text('loaded') } }
    const pane = ctx.mayflyPanes.register(view('test.agents', { load, summary: { node: summaryNode } }))
    pane.setSummary({ node: summaryNode, count: 2 })
    release()
    await new Promise<void>(resolve => { setImmediate(resolve) })
    const entry = ctx.mayflyPanes.list()[0]!
    expect(entry.node).toEqual(ui.text('loaded'))
    expect(entry.summary!.count).toBe(2)
    pane.set(ui.text('again'))
    expect(ctx.mayflyPanes.list()[0]!.summary!.count).toBe(2)
  })

  it('validates what it is given and leaves the previous summary on a refusal', async () => {
    const ctx = await api()
    const pane = ctx.mayflyPanes.register(view('test.agents', { summary: { node: summaryNode, count: 1 } }))
    expect(() => pane.setSummary({ node: ui.loader({ message: 'busy' }) as never })).toThrow('must be a status node')
    expect(ctx.mayflyPanes.list()[0]!.summary!.count).toBe(1)
  })

  it('does nothing after disposal and is refused on a pane that is not a view', async () => {
    const ctx = await api()
    const pane = ctx.mayflyPanes.register(view('test.agents', { summary: { node: summaryNode } }))
    const bottom = ctx.mayflyPanes.register({ id: 'test.bottom', placement: 'bottom' })
    expect(() => bottom.setSummary({ node: summaryNode })).toThrow('only a views pane')
    pane.dispose()
    expect(() => pane.setSummary({ node: summaryNode })).not.toThrow()
    expect(ctx.mayflyPanes.list().map(entry => entry.id)).toEqual(['test.bottom'])
  })
})
