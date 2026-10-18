/** Native MCP rows and one shared panel over the tool registry: in-place server
 * pages and tabs, scope, lifecycle, resources, and the absence of connection
 * configuration.
 * @module @ephemeral-ai/mayfly/tests/interaction/mcp-commands
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { catalogFixture } from './catalog-fixture.ts'
import { flushRequests, renderRequest } from './request-fixture.ts'
import { collectMcpServers } from '../../src/interaction/mcp-servers.ts'
import { mcpServerNode, serverConfigNode, serverItems } from '../../src/interaction/mcp-commands.ts'
import { ui, type MayflyUiActionEvent } from '../../../ui/src/index.ts'
import { ADVERSARIAL, SCAN_WIDTHS, expectLinesFit } from '../core/width-scan.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
async function setup() {
  const ctx = new Context(); contexts.push(ctx)
  return catalogFixture(ctx)
}
const selectServer = (serverName = 'demo') => ({ kind: 'selection-accept' as const, controlId: 'servers', pagePath: [], selectedIds: [serverName] })
const selectTool = (toolName = 'mcp__demo__one') => ({ kind: 'selection-accept' as const, controlId: 'tools', pagePath: [{ controlId: 'server-pages', itemId: 'tools' }], selectedIds: [toolName] })
const selectResource = (index = '0') => ({ kind: 'selection-accept' as const, controlId: 'resources', pagePath: [{ controlId: 'server-pages', itemId: 'resources' }], selectedIds: [index] })

function rootEntry(bench: Awaited<ReturnType<typeof setup>>) {
  const entry = bench.ctx.mayflyOverlays.list().find(item => item.id === 'mayfly.mcp')
  if (entry === undefined) throw new Error('the MCP root panel is not open')
  return entry
}
function eventContext(entry: ReturnType<typeof rootEntry>, signal = new AbortController().signal) {
  return { surfaceId: entry.id, operationId: 'mcp-direct', source: entry.source, revision: entry.revision, signal, report: vi.fn() }
}

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
    browser.activateTab({ pagePath: [], controlId: 'server-pages' }, 'config')
    await flushRequests()
    const serialized = JSON.stringify(browser.node)
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

  it('navigates tool details and returns to the server tools tab', async () => {
    const bench = await setup()
    await bench.register({ name: 'mcp__demo__one', description: 'Tool details', parameters: { type: 'object', properties: { value: { type: 'string' } } } })
    await bench.run('/mcp')
    const browser = bench.model('mayfly.mcp')
    browser.emit(selectServer())
    await flushRequests()
    browser.emit(selectTool())
    await flushRequests()
    expect(JSON.stringify(browser.node)).toContain('Tool details')
    expect(JSON.stringify(browser.node)).toContain('"value"')
    browser.requestClose()
    await flushRequests()
    expect(browser.disposed).toBe(false)
    expect(browser.activeTab({ pagePath: [], controlId: 'server-pages' })).toBe('tools')
  })

  it('refreshes tool data and retires a removed server without rebuilding the browser', async () => {
    const bench = await setup()
    const tool = await bench.register({ name: 'mcp__demo__one', description: 'One' })
    await bench.run('/mcp')
    const browser = bench.model('mayfly.mcp')
    browser.emit(selectServer())
    await flushRequests()
    await tool.dispose()
    bench.ctx.emit('tools/change')
    await flushRequests()
    expect(browser.disposed).toBe(false)
    expect(JSON.stringify(browser.node)).toContain('No MCP servers')
    await bench.run('/mcp')
    expect(bench.ctx.mayflyOverlays.list()).toHaveLength(1)
  })

  it('retires an old server page when its namespace changes', async () => {
    const bench = await setup()
    const demo = await bench.register({ name: 'mcp__demo__one', description: 'Old server' })
    await bench.run('/mcp')
    const browser = bench.model('mayfly.mcp')
    browser.emit(selectServer())
    await flushRequests()
    browser.emit(selectTool())
    await flushRequests()
    expect(JSON.stringify(browser.node)).toContain('Old server')
    await demo.dispose()
    await bench.register({ name: 'mcp__next__one', description: 'New server' })
    bench.ctx.emit('tools/change')
    await flushRequests()
    expect(browser.disposed).toBe(false)
    expect(JSON.stringify(browser.node)).toContain('next')
    expect(JSON.stringify(browser.node)).not.toContain('demo')
  })

  it('shows restricted, orphan, and failed-catalog states from registry facts', async () => {
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
    const schemas = vi.spyOn(bench.ctx.tools, 'schemas').mockImplementation(() => { throw new Error('source unavailable') })
    bench.ctx.emit('tools/change')
    await flushRequests()
    expect(JSON.stringify(browser.node)).toContain('showing the last snapshot')
    schemas.mockRestore()
    browser.invoke('refresh')
    await flushRequests()
    expect(JSON.stringify(browser.node)).not.toContain('showing the last snapshot')
    browser.emit(selectServer())
    await flushRequests()
    browser.activateTab({ pagePath: [], controlId: 'server-pages' }, 'config')
    await flushRequests()
    expect(JSON.stringify(browser.node)).toContain('Tools are registered but restricted')
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

  it('coalesces root refreshes and contains missing or already-aborted root selections', async () => {
    const bench = await setup()
    await bench.register({ name: 'mcp__demo__one', description: '' })
    await bench.run('/mcp')
    const entry = rootEntry(bench)
    const act = (event: MayflyUiActionEvent, signal = new AbortController().signal) =>
      entry.definition.onEvent!.action!(event, eventContext(entry, signal))
    bench.ctx.emit('tools/change')
    bench.ctx.emit('tools/change')
    await flushRequests()
    expect(await act({ kind: 'activate', pagePath: [], controlId: 'mcp-actions', actionId: 'refresh' })).toEqual({ kind: 'completed' })
    await Promise.all([
      act({ kind: 'activate', pagePath: [], controlId: 'mcp-actions', actionId: 'refresh' }),
      act({ kind: 'activate', pagePath: [], controlId: 'mcp-actions', actionId: 'refresh' }),
    ])
    expect(await act(selectServer('missing'))).toMatchObject({ kind: 'failed' })
    const aborted = new AbortController()
    aborted.abort()
    expect(await act(selectServer(), aborted.signal)).toEqual({ kind: 'cancelled', dismiss: true })
    bench.ctx.emit('tools/change')
    bench.ctx.mayflyOverlays.close('mayfly.mcp')
    await flushRequests()
  })

  it('reports a failed refresh after its root closes', async () => {
    const bench = await setup()
    await bench.run('/mcp')
    const entry = rootEntry(bench)
    vi.spyOn(bench.ctx.tools, 'schemas').mockImplementationOnce(() => { throw new Error('refresh failed') })
    const pending = entry.definition.onEvent!.action!(
      { kind: 'activate', pagePath: [], controlId: 'mcp-actions', actionId: 'refresh' },
      eventContext(entry),
    )
    bench.ctx.mayflyOverlays.close(entry.id)
    await expect(pending).resolves.toMatchObject({ kind: 'failed', message: 'refresh failed' })
    expect(bench.ctx.mayflyOverlays.list()).toHaveLength(0)
  })

  it('closes the browser when the Agent changes on a tool page', async () => {
    const bench = await setup()
    await bench.register({ name: 'mcp__demo__one', description: 'Tool details' })
    await bench.run('/mcp')
    const browser = bench.model('mayfly.mcp')
    browser.emit(selectServer())
    await flushRequests()
    browser.emit(selectTool())
    await flushRequests()
    expect(JSON.stringify(browser.node)).toContain('Tool details')
    bench.ctx.mayflyConversations.selectPrimary(bench.other)
    await flushRequests()
    expect(browser.disposed).toBe(true)
  })

  it('backs out through tool, server, and list pages before closing', async () => {
    const bench = await setup()
    await bench.register({ name: 'mcp__demo__one', description: 'Tool details' })
    await bench.run('/mcp')
    const browser = bench.model('mayfly.mcp')
    browser.emit(selectServer())
    await flushRequests()
    browser.emit(selectTool())
    await flushRequests()
    browser.requestClose()
    await flushRequests()
    expect(browser.disposed).toBe(false)
    expect(browser.activeTab({ pagePath: [], controlId: 'server-pages' })).toBe('tools')
    browser.requestClose()
    await flushRequests()
    expect(browser.disposed).toBe(false)
    expect(JSON.stringify(browser.node)).toContain('MCP servers')
    browser.requestClose()
    await flushRequests()
    expect(browser.disposed).toBe(true)
  })

  it.each(ADVERSARIAL)('contains long tool metadata at every width: $name', async ({ name, text }) => {
    const bench = await setup()
    await bench.register({ name: 'mcp__demo__one', description: text })
    await bench.run('/mcp')
    const browser = bench.model('mayfly.mcp')
    browser.emit(selectServer())
    await flushRequests()
    for (const tab of ['tools', 'config']) {
      browser.activateTab({ pagePath: [], controlId: 'server-pages' }, tab)
      await flushRequests()
      const viewport = { columns: 80, rows: 20 }
      const renderer = renderRequest(browser, viewport)
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

it('answers root selections that name no server or tool and cancels an aborted action', async () => {
  const bench = await setup()
  await bench.register({ name: 'mcp__demo__one', description: 'One' })
  await bench.run('/mcp')
  const browser = bench.model('mayfly.mcp')
  browser.emit(selectServer())
  await flushRequests()
  const entry = rootEntry(bench)
  const act = (event: MayflyUiActionEvent, signal = new AbortController().signal) =>
    entry.definition.onEvent!.action!(event, eventContext(entry, signal))
  expect(await act({ kind: 'selection-accept', pagePath: [], controlId: 'servers', selectedIds: ['missing'] })).toMatchObject({ kind: 'failed' })
  expect(await act(selectTool('mcp__demo__missing'))).toMatchObject({ kind: 'failed' })
  const aborted = new AbortController()
  aborted.abort()
  expect(await act(selectTool(), aborted.signal)).toEqual({ kind: 'cancelled', dismiss: true })
})

it('opens resource and template catalogs inside the server page', async () => {
  const bench = await setup()
  await bench.register({ name: 'mcp__demo__one', description: 'One' })
  const execute = vi.spyOn(bench.ctx.tools, 'execute').mockImplementation(async call => {
    if (call.name === 'list_mcp_resources') return { isError: false, value: { resources: [{ name: 'Doc', uri: 'test://doc', description: 'Body' }] }, content: [] }
    if (call.name === 'list_mcp_resource_templates') return { isError: false, value: { resourceTemplates: [{ name: 'Template', uriTemplate: 'test://{name}' }] }, content: [] }
    return { isError: false, value: { contents: [] }, content: [] }
  })
  await bench.run('/mcp')
  const browser = bench.model('mayfly.mcp')
  browser.emit(selectServer())
  await flushRequests()
  browser.invoke('resources')
  await flushRequests()
  expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'list_mcp_resources', arguments: { server: 'demo' } }))
  expect(JSON.stringify(browser.node)).toContain('Doc')
  expect(bench.ctx.mayflyOverlays.list()).toHaveLength(1)
  browser.invoke('templates')
  await flushRequests()
  expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'list_mcp_resource_templates', arguments: { server: 'demo' } }))
  expect(JSON.stringify(browser.node)).toContain('Template')
  expect(execute).toHaveBeenCalledTimes(2)
  expect(bench.ctx.mayflyOverlays.list()).toHaveLength(1)
})

it('pages and reads a resource inside the server page and returns through it', async () => {
  const bench = await setup()
  await bench.register({ name: 'mcp__demo__one', description: 'One' })
  const execute = vi.spyOn(bench.ctx.tools, 'execute').mockImplementation(async call => {
    const args = call.arguments as Record<string, string>
    if (call.name === 'list_mcp_resources') {
      return (args.cursor === undefined
        ? { isError: false, value: { resources: [{ name: 'Doc', uri: 'test://doc' }], nextCursor: 'page2' }, content: [] }
        : { isError: false, value: { resources: [{ name: 'Second', uri: 'test://second' }] }, content: [] }) as never
    }
    if (call.name === 'read_mcp_resource') return { isError: false, value: { contents: [{ uri: args.uri, text: 'Document body' }] }, content: [] } as never
    return { isError: false, value: { contents: [] }, content: [] } as never
  })
  await bench.run('/mcp')
  const browser = bench.model('mayfly.mcp')
  browser.emit(selectServer())
  await flushRequests()
  browser.invoke('resources')
  await flushRequests()
  browser.invoke('more')
  await flushRequests()
  expect(execute).toHaveBeenCalledWith(expect.objectContaining({ name: 'list_mcp_resources', arguments: { server: 'demo', cursor: 'page2' } }))
  expect(JSON.stringify(browser.node)).toContain('Second')
  browser.emit(selectResource())
  await flushRequests()
  expect(JSON.stringify(browser.node)).toContain('Resource URI')
  browser.edit({ pagePath: [], formId: 'resource-uri', fieldId: 'uri' }, 'test://expanded')
  browser.invoke('read')
  await flushRequests()
  expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'read_mcp_resource', arguments: { server: 'demo', uri: 'test://expanded' } }))
  expect(JSON.stringify(browser.node)).toContain('Document body')
  browser.requestClose()
  await flushRequests()
  expect(browser.disposed).toBe(false)
  expect(JSON.stringify(browser.node)).toContain('Resource URI')
  browser.requestClose()
  await flushRequests()
  expect(browser.disposed).toBe(false)
  expect(browser.activeTab({ pagePath: [], controlId: 'server-pages' })).toBe('resources')
  expect(JSON.stringify(browser.node)).toContain('Doc')
})
