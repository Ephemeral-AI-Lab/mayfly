/** Native MCP rows and panels over the tool registry: shared tabs, scope,
 * lifecycle, and the explicit absence of connection configuration.
 * @module @ephemeral-ai/mayfly/tests/interaction/mcp-commands
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { catalogFixture } from './catalog-fixture.ts'
import { flushRequests, renderRequest } from './request-fixture.ts'
import { collectMcpServers } from '../../src/interaction/mcp-servers.ts'
import { mcpServerNode, serverConfigNode, serverItems } from '../../src/interaction/mcp-commands.ts'
import { ui } from '../../../ui/src/index.ts'
import { ADVERSARIAL, SCAN_WIDTHS, expectLinesFit } from '../core/width-scan.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
async function setup() {
  const ctx = new Context(); contexts.push(ctx)
  return catalogFixture(ctx)
}
const selectServer = (serverName = 'demo') => ({ kind: 'selection-accept' as const, controlId: 'servers', pagePath: [], selectedIds: [serverName] })

describe('shared MCP browser', () => {
  it('derives rows from the tool registry and never shows connection configuration', async () => {
    const bench = await setup()
    await bench.register({ name: 'mcp__demo__one', description: 'Visible tool' })
    await bench.register({ name: 'mcp__demo__two', description: 'Restricted tool' })
    bench.restrict(['mcp__demo__two'])
    await bench.run('/mcp')
    const browser = bench.model('mayfly.mcp')
    expect(JSON.stringify(browser.node)).toContain('1/2 tools')
    browser.emit(selectServer())
    await flushRequests()
    const server = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.mcp.server')!
    server.activateTab({ pagePath: [], controlId: 'server-pages' }, 'config')
    const serialized = JSON.stringify(server.node)
    expect(serialized).toContain('"text":"(not resolved)"')
    expect(serialized).not.toContain('TOKEN')
    expect(serialized).not.toContain('Authorization')
    expect(serialized).not.toContain('Environment keys')
    expect(serialized).not.toContain('Header keys')
    expect(serialized).not.toContain('Reconnect')
    expect(serialized).not.toContain('private-env')
    expect((await collectMcpServers(bench.ctx, bench.other)).servers[0]!.toolsVisible).toHaveLength(2)
    expect(bench.execute).not.toHaveBeenCalled()
  })

  it('includes Agent-scoped registrations without inflating duplicate global names', async () => {
    const bench = await setup()
    await bench.register({ name: 'mcp__demo__global', description: 'Global' })
    await bench.register({ name: 'mcp__demo__local', description: 'Local' }, bench.agent)
    const mine = await collectMcpServers(bench.ctx, bench.agent)
    const other = await collectMcpServers(bench.ctx, bench.other)
    expect(mine.servers[0]).toMatchObject({ status: 'synced', registeredCount: 2 })
    expect(mine.servers[0]!.toolsVisible).toHaveLength(2)
    expect(other.servers[0]).toMatchObject({ status: 'synced', registeredCount: 1 })
    expect(other.servers[0]!.toolsVisible).toHaveLength(1)
  })

  it('navigates tool details through nested owners and returns with server tabs/search retained', async () => {
    const bench = await setup()
    await bench.register({ name: 'mcp__demo__one', description: 'Tool details', parameters: { type: 'object', properties: { value: { type: 'string' } } } })
    await bench.run('/mcp')
    bench.model('mayfly.mcp').emit(selectServer())
    await flushRequests()
    const server = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.mcp.server')!
    server.updateChoice({ pagePath: [{ controlId: 'server-pages', itemId: 'tools' }], controlId: 'tools' }, { kind: 'query', query: 'one' })
    server.emit({ kind: 'selection-accept', controlId: 'tools', pagePath: [{ controlId: 'server-pages', itemId: 'tools' }], selectedIds: ['mcp__demo__one'] })
    await flushRequests()
    const detail = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.mcp.tool')!
    expect(JSON.stringify(detail.node)).toContain('Tool details')
    detail.requestClose()
    await flushRequests()
    expect(server.disposed).toBe(false)
    expect(server.choice({ pagePath: [{ controlId: 'server-pages', itemId: 'tools' }], controlId: 'tools' })!.query).toBe('one')
    expect(server.activeTab({ pagePath: [], controlId: 'server-pages' })).toBe('tools')
  })

  it('refreshes tool data and retires a removed server without rebuilding the browser', async () => {
    const bench = await setup()
    const tool = await bench.register({ name: 'mcp__demo__one', description: 'One' })
    await bench.run('/mcp')
    const browser = bench.model('mayfly.mcp')
    browser.emit(selectServer())
    await flushRequests()
    const server = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.mcp.server')!
    await tool.dispose()
    bench.ctx.emit('tools/change')
    await flushRequests()
    expect(server.disposed).toBe(true)
    expect(browser.disposed).toBe(false)
    expect(JSON.stringify(browser.node)).toContain('No MCP servers')
    await bench.run('/mcp')
    expect(bench.ctx.mayflyOverlays.list()).toHaveLength(1)
  })

  it('retires an old tool detail when a server namespace changes', async () => {
    const bench = await setup()
    const demo = await bench.register({ name: 'mcp__demo__one', description: 'Old server' })
    await bench.run('/mcp')
    bench.model('mayfly.mcp').emit(selectServer())
    await flushRequests()
    const server = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.mcp.server')!
    server.emit({ kind: 'selection-accept', controlId: 'tools', pagePath: [{ controlId: 'server-pages', itemId: 'tools' }], selectedIds: ['mcp__demo__one'] })
    await flushRequests()
    const detail = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.mcp.tool')!
    await demo.dispose()
    await bench.register({ name: 'mcp__next__one', description: 'New server' })
    bench.ctx.emit('tools/change')
    await flushRequests()
    expect(detail.disposed).toBe(true)
    expect(server.disposed).toBe(true)
    expect(JSON.stringify(bench.model('mayfly.mcp').node)).toContain('next')
    expect(JSON.stringify(bench.model('mayfly.mcp').node)).not.toContain('demo')
  })

  it('shows restricted, orphan, and failed-read states from registry facts', async () => {
    const bench = await setup()
    await bench.register({ name: 'mcp__demo__one', description: '' })
    await bench.register({ name: 'mcp__nobody', description: '' })
    bench.restrict(['mcp__demo__one'])
    const catalog = await collectMcpServers(bench.ctx)
    expect(catalog.orphanCount).toBe(1)
    expect(serverItems(catalog, key => key)[0]!.id).toBe('demo')
    await bench.run('/mcp')
    const browser = bench.model('mayfly.mcp')
    expect(JSON.stringify(browser.node)).toContain('1 registered MCP tools')
    browser.emit(selectServer())
    await flushRequests()
    const server = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.mcp.server')!
    expect(JSON.stringify(server.node)).toContain('Tools are registered but restricted')
    const schemas = vi.spyOn(bench.ctx.tools, 'schemas').mockImplementation(() => { throw new Error('source unavailable') })
    bench.ctx.emit('tools/change')
    await flushRequests()
    expect(JSON.stringify(browser.node)).toContain('showing the last snapshot')
    schemas.mockRestore()
    server.invoke('refresh')
    await flushRequests()
    expect(JSON.stringify(browser.node)).not.toContain('showing the last snapshot')
  })

  it('sorts equal-status servers by name and renders only resolved configuration', async () => {
    const bench = await setup()
    await bench.register({ name: 'mcp__z__one', description: '' })
    await bench.register({ name: 'mcp__a__one', description: '' })
    const catalog = await collectMcpServers(bench.ctx, bench.agent)
    expect(serverItems(catalog, key => key).map(item => item.label)).toEqual(['a', 'z'])
    const config = JSON.stringify(serverConfigNode(catalog.servers[0]!, key => key))
    expect(config).toContain('Connection')
    expect(config).toContain('(not resolved)')
    expect(config).toContain('Transport')
    expect(config).not.toContain('Policy')
    expect(JSON.stringify(mcpServerNode(catalog.servers[0]!, key => key))).toContain('Configuration')
  })

  it('contains cancelled, wrong-Agent, raced focus, and failed command reads', async () => {
    const bench = await setup()
    await bench.register({ name: 'mcp__demo__one', description: '' })
    const command = bench.ctx.commands.find(bench.agent, 'mcp')!
    const aborted = new AbortController()
    aborted.abort()
    expect(await command.handler({ agent: bench.agent, signal: aborted.signal } as never)).toEqual({ kind: 'success' })
    expect(await command.handler({ agent: bench.other, signal: new AbortController().signal } as never)).toEqual({ kind: 'success' })

    const raced = command.handler({ agent: bench.agent, signal: new AbortController().signal } as never)
    const duplicate = bench.ctx.mayflyOverlays.open({ id: 'mayfly.mcp', presentation: 'editor', capturing: true }, ui.text('already open'))
    expect(await raced).toEqual({ kind: 'success' })
    duplicate.close()

    for (const error of [new Error('catalog failed'), 'bare failure']) {
      const schemas = vi.spyOn(bench.ctx.tools, 'schemas').mockImplementationOnce(() => { throw error })
      expect(await command.handler({ agent: bench.agent, signal: new AbortController().signal } as never)).toEqual({ kind: 'error', text: error instanceof Error ? error.message : error })
      schemas.mockRestore()
    }

    const lateSchemas = vi.spyOn(bench.ctx.tools, 'schemas').mockImplementationOnce(() => { throw new Error('late failure') })
    const late = command.handler({ agent: bench.agent, signal: new AbortController().signal } as never)
    bench.ctx.mayflyConversations.selectPrimary(bench.other)
    expect(await late).toEqual({ kind: 'success' })
    lateSchemas.mockRestore()
  })

  it('coalesces root refreshes and contains stale root actions', async () => {
    const bench = await setup()
    await bench.register({ name: 'mcp__demo__one', description: '' })
    await bench.run('/mcp')
    const root = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.mcp')!
    const entry = bench.ctx.mayflyOverlays.list().find(item => item.id === root.id)!
    const context = (signal = new AbortController().signal) => ({ surfaceId: entry.id, operationId: 'direct', source: entry.source, revision: entry.revision, signal, report: vi.fn() })
    bench.ctx.emit('tools/change')
    bench.ctx.emit('tools/change')
    await flushRequests()
    expect(await entry.definition.onEvent!.action!({ kind: 'activate', pagePath: [], controlId: 'mcp-actions', actionId: 'refresh' }, context())).toEqual({ kind: 'completed' })
    const first = entry.definition.onEvent!.action!({ kind: 'activate', pagePath: [], controlId: 'mcp-actions', actionId: 'refresh' }, context())
    const second = entry.definition.onEvent!.action!({ kind: 'activate', pagePath: [], controlId: 'mcp-actions', actionId: 'refresh' }, context())
    await Promise.all([first, second])

    expect(await entry.definition.onEvent!.action!({ kind: 'selection-accept', pagePath: [], controlId: 'servers', selectedIds: ['missing'] }, context())).toMatchObject({ kind: 'failed' })
    const aborted = new AbortController()
    const pending = entry.definition.onEvent!.action!(selectServer(), context(aborted.signal))
    aborted.abort()
    expect(await pending).toMatchObject({ kind: 'cancelled' })

    bench.ctx.emit('tools/change')
    bench.ctx.mayflyOverlays.close('mayfly.mcp')
    await flushRequests()
  })

  it('contains a failed refresh after its root closes', async () => {
    const bench = await setup()
    await bench.run('/mcp')
    const entry = bench.ctx.mayflyOverlays.list().find(item => item.id === 'mayfly.mcp')!
    vi.spyOn(bench.ctx.tools, 'schemas').mockImplementationOnce(() => { throw new Error('refresh failed') })
    const context = { surfaceId: entry.id, operationId: 'refresh', source: entry.source, revision: entry.revision, signal: new AbortController().signal, report: vi.fn() }
    const pending = entry.definition.onEvent!.action!({ kind: 'activate', pagePath: [], controlId: 'mcp-actions', actionId: 'refresh' }, context)
    bench.ctx.mayflyOverlays.close(entry.id)
    await expect(pending).rejects.toThrow('refresh failed')
  })

  it.each(['agent', 'parent'] as const)('closes all descendants after %s withdrawal', async reason => {
    const bench = await setup()
    await bench.register({ name: 'mcp__demo__one', description: 'Details' })
    await bench.run('/mcp')
    const browser = bench.model('mayfly.mcp')
    browser.emit(selectServer())
    await flushRequests()
    const server = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.mcp.server')!
    server.emit({ kind: 'selection-accept', controlId: 'tools', pagePath: [{ controlId: 'server-pages', itemId: 'tools' }], selectedIds: ['mcp__demo__one'] })
    await flushRequests()
    const detail = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.mcp.tool')!
    if (reason === 'agent') bench.ctx.mayflyConversations.selectPrimary(bench.other)
    else browser.requestClose()
    await flushRequests()
    expect(browser.disposed).toBe(true)
    expect(server.disposed).toBe(true)
    expect(detail.disposed).toBe(true)
  })

  it.each(ADVERSARIAL)('contains long tool metadata at every width: $name', async ({ name, text }) => {
    const bench = await setup()
    await bench.register({ name: 'mcp__demo__one', description: text })
    await bench.run('/mcp')
    bench.model('mayfly.mcp').emit(selectServer())
    await flushRequests()
    const model = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.mcp.server')!
    for (const tab of ['tools', 'config']) {
      model.activateTab({ pagePath: [], controlId: 'server-pages' }, tab)
      const viewport = { columns: 80, rows: 20 }
      const renderer = renderRequest(model, viewport)
      for (const width of SCAN_WIDTHS) for (const height of [20, 7, 3]) {
        viewport.columns = width; viewport.rows = height
        const rows = renderer.component.render(width)
        expectLinesFit(`mcp/${name}/${tab}/${height}`, rows, width)
        expect(rows.length).toBeLessThanOrEqual(height)
      }
      renderer.runtime.dispose()
    }
  })
})

it('draws the no-tools row and the no-tools empty title', async () => {
  const bench = await setup()
  const server = { entryId: 'empty', serverName: 'empty', status: 'no-tools' as const, registeredCount: 0, toolsVisible: [] }
  const t = (key: string, values?: Record<string, unknown>) => values === undefined ? key : `${key} ${JSON.stringify(values)}`
  const config = JSON.stringify(serverConfigNode(server, t))
  expect(config).toContain('No tools registered; connection state is unavailable')
  expect(config).not.toContain('Tools are registered but restricted')
  const node = JSON.stringify(mcpServerNode(server, t))
  expect(node).toContain('No tools registered')
  expect(node).not.toContain('No tools visible to this session')
  expect(bench).toBeDefined()
})

it('returns quietly when the Agent changes while the MCP catalog is being read', async () => {
  const bench = await setup()
  await bench.register({ name: 'mcp__demo__one', description: '' })
  const command = bench.ctx.commands.find(bench.agent, 'mcp')!
  const pending = command.handler({ agent: bench.agent, signal: new AbortController().signal } as never)
  bench.ctx.mayflyConversations.selectPrimary(bench.other)
  expect(await pending).toEqual({ kind: 'success' })
})

it('answers the server overlay events that name no tool and cancels an aborted tool selection', async () => {
  const bench = await setup()
  await bench.register({ name: 'mcp__demo__one', description: 'One' })
  await bench.run('/mcp')
  bench.model('mayfly.mcp').emit(selectServer())
  await flushRequests()
  const entry = bench.ctx.mayflyOverlays.list().find(item => item.id === 'mayfly.mcp.server')!
  const context = (signal = new AbortController().signal) => ({ surfaceId: entry.id, operationId: 'mcp-server-direct', source: entry.source, revision: entry.revision, signal, report: vi.fn() })
  expect(await entry.definition.onEvent!.action!({ kind: 'selection-accept', pagePath: [], controlId: 'servers', selectedIds: ['demo'] }, context())).toEqual({ kind: 'completed' })
  const aborted = new AbortController()
  const pendingAbort = entry.definition.onEvent!.action!({ kind: 'selection-accept', pagePath: [{ controlId: 'server-pages', itemId: 'tools' }], controlId: 'tools', selectedIds: ['mcp__demo__one'] }, context(aborted.signal))
  aborted.abort()
  expect(await pendingAbort).toMatchObject({ kind: 'cancelled' })
  expect(await entry.definition.onEvent!.action!({ kind: 'selection-accept', pagePath: [{ controlId: 'server-pages', itemId: 'tools' }], controlId: 'tools', selectedIds: ['mcp__demo__missing'] }, context())).toMatchObject({ kind: 'failed' })
})

it('opens resource and template catalogs from the native server panel', async () => {
  const bench = await setup()
  await bench.register({ name: 'mcp__demo__one', description: 'One' })
  const execute = vi.spyOn(bench.ctx.tools, 'execute').mockResolvedValue({ isError: false, value: { resources: [], resourceTemplates: [] }, content: [] } as never)
  await bench.run('/mcp')
  bench.model('mayfly.mcp').emit(selectServer())
  await flushRequests()
  const server = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.mcp.server')!
  for (const action of ['resources', 'templates']) {
    server.invoke(action); await flushRequests()
    expect(bench.ctx.mayflyOverlays.list().some(item => item.id === 'mayfly.mcp.resources')).toBe(true)
    bench.ctx.mayflyOverlays.close('mayfly.mcp.resources'); await flushRequests()
  }
  expect(execute).toHaveBeenCalledTimes(2)
})
