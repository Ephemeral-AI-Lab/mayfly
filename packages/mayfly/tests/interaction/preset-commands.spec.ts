/** Shared preset UI over native selection serialization and session projections.
 * @module @ephemeral-ai/mayfly/tests/interaction/preset-commands
 */
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import AgentPresets, { type AgentPreset } from '@deepseek-ai/dsh-agent-presets'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { presetItems } from '../../src/interaction/preset-commands.ts'
import { requestFixture, renderRequest, flushRequests } from './request-fixture.ts'
import { ADVERSARIAL, SCAN_WIDTHS, expectLinesFit } from '../core/width-scan.ts'

const preset = (id: string, options: Partial<AgentPreset> = {}): AgentPreset => ({ id, trust: 'system', path: `/presets/${id}/cordis.yml`, ...options })

class FixturePresets extends AgentPresets {
  catalog: AgentPreset[] = [preset('standard', { name: 'Standard' }), preset('minimal', { name: 'Minimal' })]
  selected = new Map<Context, string>()
  readonly recomposeCalls = vi.fn(async (ctx: Context, id: string): Promise<AgentPreset> => {
    const preset = this.catalog.find(item => item.id === id)
    if (preset === undefined || preset.broken !== undefined) throw new Error('Preset unavailable')
    this.selected.set(ctx, id)
    return preset
  })
  constructor(ctx: Context) { super(ctx, { default: 'standard', roots: [], includeShippedRoot: false, includeUserRoot: false }) }
  override async list() { return this.catalog }
  override composedPreset(ctx: Context) { return this.selected.get(ctx) }
  override recompose(ctx: Context, id: string) { return this.recomposeCalls(ctx, id) }
}

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  const bench = await requestFixture(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  const session = ctx.sessions.create(SessionId('current'))
  Object.assign(bench.agent, { session, status: 'idle', ctx: new Context() })
  const rosterOwner = await ctx.plugin({ name: 'native-roster', inject: ['sessionProjections'], apply(owner: Context) {
    owner.sessionProjections.register(turnBoundaryProjectionDefinition)
    new FixturePresets(owner.extend({ baseUrl: import.meta.url }))
  } })
  await flushRequests()
  const run = (line = '/preset', signal = new AbortController().signal) => ctx.commands.execute(bench.agent, line, [], signal)
  return { ...bench, rosterOwner, roster: ctx.agentPresets as FixturePresets, session, run }
}

describe('native preset selection UI', () => {
  it.each(ADVERSARIAL)('contains preset metadata at all widths and short heights: $name', async ({ name, text }) => {
    const bench = await setup()
    bench.roster.catalog = [preset('adversarial', { name: text, description: text })]
    await bench.run()
    const viewport = { columns: 80, rows: 20 }
    const renderer = renderRequest(bench.model('mayfly.presets'), viewport)
    for (const width of SCAN_WIDTHS) for (const height of [20, 7, 3]) {
      viewport.columns = width
      viewport.rows = height
      const rows = renderer.component.render(width)
      expectLinesFit(`presets/${name}/${height}`, rows, width)
      expect(rows.length).toBeLessThanOrEqual(height)
    }
    renderer.runtime.dispose()
  })

  it('projects stable ordered choices, native labels, and disabled failures', () => {
    const rows = presetItems([preset('z'), preset('broken', { trust: 'user', broken: 'Bad composition', order: 1 }), preset('first', { name: 'First', order: 0, description: 'Description' })], 'first', key => key)
    expect(rows.map(row => row.id)).toEqual(['first', 'broken', 'z'])
    expect(rows[0]).toMatchObject({ label: 'First', detail: 'Description', badge: 'current' })
    expect(rows[1]).toMatchObject({ disabled: true, disabledReason: 'Bad composition' })
  })

  it('opens without renderer services, keeps failed selection visible, and retries through native select', async () => {
    const bench = await setup()
    expect((await bench.run())?.result.kind).toBe('success')
    const model = bench.model('mayfly.presets')
    bench.roster.recomposeCalls.mockRejectedValueOnce(new Error('Composition could not load'))
    model.emit({ kind: 'selection-accept', controlId: 'presets', pagePath: [], selectedIds: ['minimal'] })
    model.emit({ kind: 'selection-accept', controlId: 'presets', pagePath: [], selectedIds: ['minimal'] })
    await flushRequests()
    expect(bench.roster.recomposeCalls).toHaveBeenCalledTimes(1)
    expect(model.disposed).toBe(false)
    expect(model.feedbackSnapshot().at(-1)?.message).toBe('Composition could not load')
    model.emit({ kind: 'selection-accept', controlId: 'presets', pagePath: [], selectedIds: ['minimal'] })
    await flushRequests()
    expect(model.disposed).toBe(true)
    expect(bench.session.snapshotEvents().filter(event => event.type === 'agent-preset/selected')).toMatchObject([{ data: { agentPreset: 'minimal' } }])
  })

  it('uses native guards for a session that has started and keeps inspectable choices', async () => {
    const bench = await setup()
    bench.session.append('turn/start', { turn: 1 })
    const direct = await bench.run('/preset minimal')
    expect(direct?.result.kind).toBe('error')
    expect(bench.roster.recomposeCalls).not.toHaveBeenCalled()
    await bench.run()
    const model = bench.model('mayfly.presets')
    model.emit({ kind: 'selection-accept', controlId: 'presets', pagePath: [], selectedIds: ['minimal'] })
    await flushRequests()
    expect(model.disposed).toBe(false)
    expect(model.feedbackSnapshot().at(-1)?.severity).toBe('error')
    expect(bench.roster.recomposeCalls).not.toHaveBeenCalled()
  })

  it('rejects running or noncurrent command targets before calling the native service', async () => {
    const bench = await setup()
    Object.assign(bench.agent, { status: 'running' })
    expect((await bench.run('/preset minimal'))?.result.kind).toBe('error')
    bench.ctx.mayflyCurrentAgent.select(bench.other)
    expect((await bench.run('/preset minimal'))?.result.kind).toBe('error')
    expect(bench.roster.recomposeCalls).not.toHaveBeenCalled()
  })

  it('serializes direct selections through the native service and records each native result once', async () => {
    const bench = await setup()
    const first = Promise.withResolvers<AgentPreset>()
    bench.roster.recomposeCalls.mockImplementationOnce(() => first.promise)
    const one = bench.run('/preset standard')
    const two = bench.run('/preset minimal')
    await flushRequests()
    expect(bench.roster.recomposeCalls).toHaveBeenCalledOnce()
    first.resolve(bench.roster.catalog[0]!)
    await expect(one).resolves.toMatchObject({ result: { kind: 'success' } })
    await expect(two).resolves.toMatchObject({ result: { kind: 'success' } })
    expect(bench.session.snapshotEvents().filter(event => event.type === 'agent-preset/selected').map(event => event.data.agentPreset)).toEqual(['standard', 'minimal'])
  })

  it('retains search across refresh/repaint and blocks broken or removed choices', async () => {
    const bench = await setup()
    bench.roster.catalog.push(preset('broken', { trust: 'user', broken: 'Invalid' }))
    await bench.run()
    const model = bench.model('mayfly.presets')
    const renderer = renderRequest(model)
    renderer.input('mini')
    expect(model.choice({ pagePath: [], controlId: 'presets' })!.query).toBe('mini')
    renderer.runtime.dispose()
    await bench.run()
    expect(bench.model('mayfly.presets')).toBe(model)
    model.emit({ kind: 'selection-accept', controlId: 'presets', pagePath: [], selectedIds: ['broken'] })
    await flushRequests()
    expect(bench.roster.recomposeCalls).not.toHaveBeenCalled()
    bench.roster.catalog = []
    model.invoke('refresh')
    await flushRequests()
    expect(model.choice({ pagePath: [], controlId: 'presets' })!.query).toBe('mini')
    const next = renderRequest(model)
    next.input('\x15')
    expect(next.component.render(60).join('\n')).toContain('No presets composed')
    next.runtime.dispose()
  })

  it.each(['agent', 'roster', 'frontend'] as const)('retires the picker on %s changes and ignores late native results', async kind => {
    const bench = await setup()
    await bench.run()
    const model = bench.model('mayfly.presets')
    const gate = Promise.withResolvers<AgentPreset>()
    bench.roster.recomposeCalls.mockImplementationOnce(() => gate.promise)
    model.emit({ kind: 'selection-accept', controlId: 'presets', pagePath: [], selectedIds: ['minimal'] })
    await flushRequests()
    if (kind === 'agent') bench.ctx.mayflyCurrentAgent.select(bench.other)
    else await (kind === 'roster' ? bench.rosterOwner : bench.front).dispose()
    expect(model.disposed).toBe(true)
    gate.resolve(preset('minimal'))
    await flushRequests()
    expect(bench.ctx.mayflyOverlays.list()).toEqual([])
    expect(bench.session.snapshotEvents().filter(event => event.type === 'agent-preset/selected')).toMatchObject([{ data: { agentPreset: 'minimal' } }])
  })

  it('does not mount a picker from a discovery result after the selected Agent changes', async () => {
    const bench = await setup()
    const gate = Promise.withResolvers<AgentPreset[]>()
    vi.spyOn(bench.roster, 'list').mockReturnValue(gate.promise)
    const pending = bench.run()
    await flushRequests()
    bench.ctx.mayflyCurrentAgent.select(bench.other)
    gate.resolve(bench.roster.catalog)
    await pending
    expect(bench.ctx.mayflyOverlays.list()).toEqual([])
  })

  it('contains failed discovery and handles an initially empty roster through the shared empty state', async () => {
    const bench = await setup()
    vi.spyOn(bench.roster, 'list').mockRejectedValueOnce('Discovery failed')
    expect((await bench.run())?.result).toEqual({ kind: 'error', text: 'Discovery failed' })
    bench.roster.catalog = []
    await bench.run()
    const model = bench.model('mayfly.presets')
    const renderer = renderRequest(model)
    expect(renderer.component.render(60).join('\n')).toContain('No presets composed')
    renderer.input('\x1b')
    await flushRequests()
    expect(model.disposed).toBe(true)
    renderer.runtime.dispose()
  })

  it('refreshes locale while preserving search and blocks a forged unavailable selection at the endpoint', async () => {
    const bench = await setup()
    await bench.run()
    const model = bench.model('mayfly.presets')
    model.updateChoice({ pagePath: [], controlId: 'presets' }, { kind: 'query', query: 'mini' })
    bench.ctx.mayflyLocale.setPreference('zh')
    await flushRequests()
    expect(model.choice({ pagePath: [], controlId: 'presets' })!.query).toBe('mini')
    expect(JSON.stringify(model.node)).toContain('预设')
    const entry = bench.ctx.mayflyOverlays.list().find(entry => entry.id === 'mayfly.presets')!
    const reply = await entry.events.prepare({ kind: 'selection-accept', controlId: 'presets', pagePath: [], selectedIds: ['missing'] }, { surfaceId: entry.id, operationId: 'forged', source: [], revision: 0, signal: new AbortController().signal, report: vi.fn() })
    expect(reply.reply).toMatchObject({ kind: 'failed' })
    expect(bench.roster.recomposeCalls).not.toHaveBeenCalled()
  })

  it('contains pre-aborted and mid-selection command invocations', async () => {
    const bench = await setup()
    const command = bench.ctx.commands.find(bench.agent, 'preset')!
    const aborted = new AbortController()
    aborted.abort()
    expect(await command.handler({ agent: bench.agent, rawInput: '', signal: aborted.signal } as never)).toEqual({ kind: 'success' })

    const gate = Promise.withResolvers<AgentPreset>()
    bench.roster.recomposeCalls.mockImplementationOnce(() => gate.promise)
    const during = new AbortController()
    const pending = command.handler({ agent: bench.agent, rawInput: 'minimal', signal: during.signal } as never)
    await vi.waitFor(() => expect(bench.roster.recomposeCalls).toHaveBeenCalled())
    during.abort()
    gate.resolve(preset('minimal'))
    expect(await pending).toEqual({ kind: 'success' })
  })

  it('focuses a picker opened while roster discovery is pending', async () => {
    const bench = await setup()
    const gate = Promise.withResolvers<AgentPreset[]>()
    vi.spyOn(bench.roster, 'list').mockReturnValueOnce(gate.promise)
    const command = bench.ctx.commands.find(bench.agent, 'preset')!
    const pending = command.handler({ agent: bench.agent, rawInput: '', signal: new AbortController().signal } as never)
    const duplicate = bench.ctx.mayflyOverlays.open({ id: 'mayfly.presets', presentation: 'editor', capturing: true }, { kind: 'text', content: 'existing' })
    gate.resolve(bench.roster.catalog)
    expect(await pending).toEqual({ kind: 'success' })
    expect(bench.ctx.mayflyOverlays.list().find(entry => entry.id === 'mayfly.presets')!.focusRevision).toBeGreaterThan(0)
    duplicate.close()
  })

  it('contains child creation races and refresh cancellation', async () => {
    const missing = await setup()
    let reads = 0
    vi.spyOn(missing.ctx.mayflyCurrentAgent, 'current').mockImplementation(() => ++reads >= 3 ? missing.other : missing.agent)
    const command = missing.ctx.commands.find(missing.agent, 'preset')!
    expect(await command.handler({ agent: missing.agent, rawInput: '', signal: new AbortController().signal } as never)).toEqual({ kind: 'success' })
    expect(missing.ctx.mayflyOverlays.list()).toEqual([])

    const closed = await setup()
    closed.ctx.mayflyOverlays.subscribe(delta => { if (delta.kind === 'upsert' && delta.entry.id === 'mayfly.presets') closed.ctx.mayflyOverlays.close('mayfly.presets') })
    expect(await closed.ctx.commands.find(closed.agent, 'preset')!.handler({ agent: closed.agent, rawInput: '', signal: new AbortController().signal } as never)).toEqual({ kind: 'success' })
    expect(closed.ctx.mayflyOverlays.list()).toEqual([])

    const refreshing = await setup()
    await refreshing.run()
    const entry = refreshing.ctx.mayflyOverlays.list().find(item => item.id === 'mayfly.presets')!
    const gate = Promise.withResolvers<AgentPreset[]>()
    vi.spyOn(refreshing.roster, 'list').mockReturnValueOnce(gate.promise)
    const abort = new AbortController()
    const context = { surfaceId: entry.id, operationId: 'refresh', source: entry.source, revision: entry.revision, signal: abort.signal, report: vi.fn() }
    const pending = entry.definition.onEvent!.action!({ kind: 'activate', pagePath: [], controlId: 'preset-actions', actionId: 'refresh' }, context)
    abort.abort()
    gate.resolve(refreshing.roster.catalog)
    expect(await pending).toMatchObject({ kind: 'cancelled' })
  })

  it('contains a discovery failure after the selected Agent changes', async () => {
    const bench = await setup()
    const gate = Promise.withResolvers<AgentPreset[]>()
    vi.spyOn(bench.roster, 'list').mockReturnValueOnce(gate.promise)
    const pending = bench.ctx.commands.find(bench.agent, 'preset')!.handler({ agent: bench.agent, rawInput: '', signal: new AbortController().signal } as never)
    bench.ctx.mayflyCurrentAgent.select(bench.other)
    gate.reject(new Error('late discovery failure'))
    expect(await pending).toEqual({ kind: 'success' })
  })

  it('rejects a selection when the Agent changes between wrapper and native select', async () => {
    const bench = await setup()
    await bench.run()
    const entry = bench.ctx.mayflyOverlays.list().find(item => item.id === 'mayfly.presets')!
    let reads = 0
    vi.spyOn(bench.ctx.mayflyCurrentAgent, 'current').mockImplementation(() => ++reads === 1 ? bench.agent : bench.other)
    const context = { surfaceId: entry.id, operationId: 'select', source: entry.source, revision: entry.revision, signal: new AbortController().signal, report: vi.fn() }
    expect(await entry.definition.onEvent!.action!({ kind: 'selection-accept', pagePath: [], controlId: 'presets', selectedIds: ['minimal'] }, context)).toMatchObject({ kind: 'failed', message: 'The active Agent changed before the preset switch' })
  })
})
