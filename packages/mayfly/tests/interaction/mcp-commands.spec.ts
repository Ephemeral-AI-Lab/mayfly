/** Native MCP catalog scope, shared tabs, redaction, and view-tree lifetime.
 * @module @ephemeral-ai/mayfly/tests/interaction/mcp-commands
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { catalogFixture, mcpEntry } from './catalog-fixture.ts'
import { flushRequests, renderRequest } from './request-fixture.ts'
import { collectMcpServers } from '../../src/interaction/mcp-servers.ts'
import { mcpServerNode, serverConfigNode, serverItems } from '../../src/interaction/mcp-commands.ts'
import { ui } from '../../../ui/src/index.ts'
import { ADVERSARIAL, SCAN_WIDTHS, expectLinesFit } from '../core/width-scan.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
async function setup() {
  const ctx = new Context(); contexts.push(ctx)
  const bench = await catalogFixture(ctx)
  bench.entries.push(mcpEntry('demo', { serverName: 'demo', transport: 'stdio', command: 'server', env: { TOKEN: 'private-env' }, headers: { Authorization: 'private-header' }, reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 3000, maxAttempts: 4 }, toolCallTimeoutMs: 1000, failOnStartupError: false }))
  return bench
}
const selectServer = { kind: 'selection-accept' as const, controlId: 'servers', pagePath: [], selectedIds: ['demo'] }

describe('shared MCP browser', () => {
  it('separates registered and scoped tool counts and never publishes secret values', async () => {
    const bench = await setup()
    await bench.register({ name: 'mcp__demo__one', description: 'Visible tool' })
    await bench.register({ name: 'mcp__demo__two', description: 'Restricted tool' })
    bench.restrict(['mcp__demo__two'])
    await bench.run('/mcp')
    const browser = bench.model('mayfly.mcp')
    expect(JSON.stringify(browser.node)).toContain('1/2 tools')
    browser.emit(selectServer)
    await flushRequests()
    const server = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.mcp.server')!
    server.activateTab({ pagePath: [], controlId: 'server-pages' }, 'config')
    const serialized = JSON.stringify(server.node)
    expect(serialized).toContain('TOKEN')
    expect(serialized).toContain('Authorization')
    expect(serialized).not.toMatch(/private-env|private-header|Restricted tool/)
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
    bench.model('mayfly.mcp').emit(selectServer)
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

  it('refreshes loader data and retires a removed server without rebuilding the browser', async () => {
    const bench = await setup()
    await bench.run('/mcp')
    const browser = bench.model('mayfly.mcp')
    browser.emit(selectServer)
    await flushRequests()
    const server = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.mcp.server')!
    bench.entries.splice(0)
    server.invoke('refresh')
    await flushRequests()
    expect(server.disposed).toBe(true)
    expect(browser.disposed).toBe(false)
    expect(JSON.stringify(browser.node)).toContain('No MCP servers')
    await bench.run('/mcp')
    expect(bench.ctx.mayflyOverlays.list()).toHaveLength(1)
  })

  it('retires an old tool detail when the same loader entry changes its server namespace', async () => {
    const bench = await setup()
    await bench.register({ name: 'mcp__demo__one', description: 'Old server' })
    await bench.register({ name: 'mcp__next__one', description: 'New server' })
    await bench.run('/mcp')
    bench.model('mayfly.mcp').emit(selectServer)
    await flushRequests()
    const server = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.mcp.server')!
    server.emit({ kind: 'selection-accept', controlId: 'tools', pagePath: [{ controlId: 'server-pages', itemId: 'tools' }], selectedIds: ['mcp__demo__one'] })
    await flushRequests()
    const detail = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.mcp.tool')!
    bench.entries.splice(0, 1, mcpEntry('demo', { serverName: 'next', transport: 'stdio', command: 'next-server' }))
    server.invoke('refresh')
    await flushRequests()
    expect(detail.disposed).toBe(true)
    expect(JSON.stringify(server.node)).toContain('New server')
    expect(JSON.stringify(server.node)).not.toContain('Old server')
  })

  it('shows restricted, ambiguous no-tool, orphan, and failed states from actual catalog facts', async () => {
    const bench = await setup()
    await bench.register({ name: 'mcp__demo__one', description: '' })
    await bench.register({ name: 'mcp__orphan__one', description: '' })
    bench.restrict(['mcp__demo__one'])
    bench.entries.push(mcpEntry('failed', { serverName: 'failed' }, 3))
    const catalog = await collectMcpServers(bench.ctx)
    expect(serverItems(catalog, key => key)[0]!.id).toBe('failed')
    await bench.run('/mcp')
    const browser = bench.model('mayfly.mcp')
    expect(JSON.stringify(browser.node)).toContain('1 registered MCP tools')
    browser.emit(selectServer)
    await flushRequests()
    const server = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.mcp.server')!
    expect(JSON.stringify(server.node)).toContain('Tools are registered but restricted')
  })

  it('sorts equal-status servers by name and renders disabled reconnect policy', async () => {
    const bench = await setup()
    bench.entries.splice(0, 1,
      mcpEntry('z', { serverName: 'z', transport: 'stdio', command: 'z', reconnect: { enabled: false, initialDelayMs: 1, maxDelayMs: 2, maxAttempts: 3 } }),
      mcpEntry('a', { serverName: 'a', transport: 'stdio', command: 'a', reconnect: { enabled: false, initialDelayMs: 1, maxDelayMs: 2, maxAttempts: 3 } }),
    )
    const catalog = await collectMcpServers(bench.ctx, bench.agent)
    expect(serverItems(catalog, key => key).map(item => item.label)).toEqual(['a', 'z'])
    expect(JSON.stringify(serverConfigNode(catalog.servers[0]!, key => key))).toContain('disabled')
    expect(JSON.stringify(mcpServerNode(catalog.servers[0]!, key => key))).toContain('Configuration')
  })

  it('contains cancelled, wrong-Agent, raced focus, and failed command reads', async () => {
    const bench = await setup()
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
    bench.ctx.mayflyCurrentAgent.select(bench.other)
    expect(await late).toEqual({ kind: 'success' })
    lateSchemas.mockRestore()
  })

  it('coalesces root refreshes and contains stale root actions', async () => {
    const bench = await setup()
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
    const pending = entry.definition.onEvent!.action!(selectServer, context(aborted.signal))
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

  it('contains a server child whose Agent changes during Fiber creation', async () => {
    const bench = await setup()
    await bench.run('/mcp')
    const entry = bench.ctx.mayflyOverlays.list().find(item => item.id === 'mayfly.mcp')!
    let reads = 0
    let changeAt = Number.POSITIVE_INFINITY
    vi.spyOn(bench.ctx.mayflyCurrentAgent, 'current').mockImplementation(() => ++reads >= changeAt ? bench.other : bench.agent)
    const context = { surfaceId: entry.id, operationId: 'open', source: entry.source, revision: entry.revision, signal: new AbortController().signal, report: vi.fn() }
    changeAt = reads + 5
    expect(await entry.definition.onEvent!.action!(selectServer, context)).toEqual({ kind: 'completed' })
    expect(bench.ctx.mayflyOverlays.list().some(item => item.id === 'mayfly.mcp.server')).toBe(false)
  })

  it('defends server refresh and removed tool selections', async () => {
    const bench = await setup()
    await bench.register({ name: 'mcp__demo__one', description: 'One' })
    await bench.run('/mcp')
    bench.model('mayfly.mcp').emit(selectServer)
    await flushRequests()
    const server = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.mcp.server')!
    const entry = bench.ctx.mayflyOverlays.list().find(item => item.id === server.id)!
    const context = (signal = new AbortController().signal) => ({ surfaceId: entry.id, operationId: 'direct', source: entry.source, revision: entry.revision, signal, report: vi.fn() })
    expect(await entry.definition.onEvent!.action!({ kind: 'activate', pagePath: [], controlId: 'server-actions', actionId: 'refresh' }, context())).toEqual({ kind: 'completed' })
    expect(await entry.definition.onEvent!.action!({ kind: 'activate', pagePath: [], controlId: 'noop', actionId: 'noop' }, context())).toEqual({ kind: 'completed' })
    expect(await entry.definition.onEvent!.action!({ kind: 'selection-accept', pagePath: [], controlId: 'tools', selectedIds: ['missing'] }, context())).toMatchObject({ kind: 'failed' })
    const aborted = new AbortController()
    const pending = entry.definition.onEvent!.action!({ kind: 'selection-accept', pagePath: [], controlId: 'tools', selectedIds: ['mcp__demo__one'] }, context(aborted.signal))
    aborted.abort()
    expect(await pending).toMatchObject({ kind: 'cancelled' })
  })

  it('marks failed background reads and recovers while retaining the active server tab', async () => {
    const bench = await setup()
    await bench.run('/mcp')
    const browser = bench.model('mayfly.mcp')
    browser.emit(selectServer)
    await flushRequests()
    const server = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.mcp.server')!
    server.activateTab({ pagePath: [], controlId: 'server-pages' }, 'config')
    const schemas = vi.spyOn(bench.ctx.tools, 'schemas').mockImplementation(() => { throw new Error('source unavailable') })
    bench.ctx.emit('tools/change')
    await flushRequests()
    expect(JSON.stringify(browser.node)).toContain('showing the last snapshot')
    expect(JSON.stringify(server.node)).toContain('showing the last snapshot')
    schemas.mockRestore()
    server.invoke('refresh')
    await flushRequests()
    expect(JSON.stringify(server.node)).not.toContain('showing the last snapshot')
    expect(server.activeTab({ pagePath: [], controlId: 'server-pages' })).toBe('config')
  })

  it.each(['/tools', '/mcp'])('does not open a stale %s command result after Agent selection changes', async line => {
    const bench = await setup()
    await bench.register({ name: 'mcp__demo__one', description: 'Details' })
    const schemas = vi.spyOn(bench.ctx.tools, 'schemas')
    const pending = bench.run(line)
    bench.ctx.mayflyCurrentAgent.select(bench.other)
    await pending
    await flushRequests()
    expect(bench.ctx.mayflyOverlays.list()).toEqual([])
    expect(schemas.mock.calls.some(([agent]) => agent === bench.other)).toBe(false)
  })

  it.each(['agent', 'loader', 'frontend', 'parent'] as const)('closes all descendants after %s withdrawal', async reason => {
    const bench = await setup()
    await bench.register({ name: 'mcp__demo__one', description: 'Details' })
    await bench.run('/mcp')
    const browser = bench.model('mayfly.mcp')
    browser.emit(selectServer)
    await flushRequests()
    const server = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.mcp.server')!
    server.emit({ kind: 'selection-accept', controlId: 'tools', pagePath: [{ controlId: 'server-pages', itemId: 'tools' }], selectedIds: ['mcp__demo__one'] })
    await flushRequests()
    const detail = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.mcp.tool')!
    if (reason === 'agent') bench.ctx.mayflyCurrentAgent.select(bench.other)
    else if (reason === 'parent') browser.requestClose()
    else await (reason === 'loader' ? bench.loaderOwner : bench.front).dispose()
    await flushRequests()
    expect(browser.disposed).toBe(true)
    expect(server.disposed).toBe(true)
    expect(detail.disposed).toBe(true)
  })

  it.each(ADVERSARIAL)('contains server configuration and tool metadata: $name', async ({ name, text }) => {
    const bench = await setup()
    bench.entries.splice(0, 1, mcpEntry('demo', { serverName: 'demo', transport: 'stdio', command: text, cwd: text }))
    await bench.register({ name: 'mcp__demo__one', description: text })
    await bench.run('/mcp')
    bench.model('mayfly.mcp').emit(selectServer)
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
