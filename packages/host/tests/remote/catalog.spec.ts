/**
 * Decision tests for the MCP and tool catalogs: the join of registered and
 * visible schemas with native health, status derivation, and the redaction of
 * every connection detail the AGENTS contract names.
 * @module
 */
import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { collectMcpCatalog, collectToolCatalog, mcpCatalog, toolCatalog } from '../../src/remote/catalog.ts'

/** One tool schema with the fields the catalog reads. */
function schema(name: string, overrides: Partial<ToolSchema> = {}): ToolSchema {
  return { name, description: `${name} description`, parameters: { type: 'object', properties: {} }, ...overrides } as ToolSchema
}

/** A context answering global/visible tool schemas and an optional MCP health face. */
function ctx(overrides: Partial<{
  readonly global: readonly ToolSchema[]
  readonly visible: readonly ToolSchema[]
  readonly health: readonly { serverName: string, transport: 'stdio' | 'streamable-http', endpoint: string | null, connection: 'connecting' | 'connected' | 'reconnecting' | 'disconnected', toolsVisible: boolean }[] | undefined
}> = {}): { readonly ctx: Context, readonly agent: Agent } {
  const agent = { id: 'session-1' } as Agent
  const face = overrides.health === undefined ? undefined : { listServers: (): unknown => overrides.health }
  const context = {
    get: (name: string): unknown => name === 'mcpResources' ? face : undefined,
    tools: {
      schemas: (forAgent?: Agent): readonly ToolSchema[] => forAgent === undefined
        ? overrides.global ?? []
        : overrides.visible ?? overrides.global ?? [],
    },
  } as unknown as Context
  return { ctx: context, agent }
}

describe('collectMcpCatalog', () => {
  it('ignores ordinary tools and malformed visible MCP names', () => {
    const { ctx: context, agent } = ctx({ global: [schema('bash'), schema('mcp__broken!')], visible: [schema('bash'), schema('mcp__broken!')] })
    expect(collectMcpCatalog(context, agent)).toEqual({ servers: [], orphanCount: 1, sessionLive: true })
  })

  it('keeps the first sanitized catalog observation for a duplicate server identity', () => {
    const { ctx: context, agent } = ctx({ health: [
      { serverName: 'docs', transport: 'stdio', endpoint: null, connection: 'connected', toolsVisible: false },
      { serverName: 'docs', transport: 'streamable-http', endpoint: 'https://later.example', connection: 'disconnected', toolsVisible: false },
    ] })
    expect(collectMcpCatalog(context, agent).servers).toMatchObject([{ serverName: 'docs', config: { transport: 'stdio', endpoint: null }, connection: 'connected' }])
  })

  it('marks a server with no registered tools as no-tools, even when configured', () => {
    const { ctx: context, agent } = ctx({
      health: [{ serverName: 'docs', transport: 'stdio', endpoint: null, connection: 'connected', toolsVisible: false }],
    })
    const catalog = collectMcpCatalog(context, agent)
    expect(catalog.servers).toHaveLength(1)
    expect(catalog.servers[0]).toMatchObject({ serverName: 'docs', status: 'no-tools', registeredCount: 0 })
    // A configured-but-toolless server still carries its connection state.
    expect(catalog.servers[0]).toHaveProperty('connection', 'connected')
  })

  it('derives restricted and synced from whether any registered tool is visible', () => {
    // Restricted means the Agent sees none of the server's registered tools.
    const restricted = ctx({
      global: [schema('mcp__docs__read'), schema('mcp__docs__write')],
      visible: [],
    })
    const servers = collectMcpCatalog(restricted.ctx, restricted.agent).servers
    expect(servers[0]).toMatchObject({ status: 'restricted', registeredCount: 2 })
    expect(servers[0]?.toolsVisible).toEqual([])
    const synced = ctx({
      global: [schema('mcp__docs__read'), schema('mcp__docs__write')],
      visible: [schema('mcp__docs__read')],
    })
    expect(collectMcpCatalog(synced.ctx, synced.agent).servers[0]).toMatchObject({ status: 'synced', registeredCount: 2 })
    expect(collectMcpCatalog(synced.ctx, synced.agent).servers[0]?.toolsVisible).toHaveLength(1)
  })

  it.each(['connecting', 'reconnecting', 'disconnected'] as const)('keeps %s servers unknown instead of claiming no tools or healthy tools', connection => {
    const { ctx: context, agent } = ctx({ health: [
      { serverName: 'empty', transport: 'stdio', endpoint: null, connection, toolsVisible: false },
      { serverName: 'cached', transport: 'stdio', endpoint: null, connection, toolsVisible: true },
    ], global: [schema('mcp__cached__read')] })
    const servers = collectMcpCatalog(context, agent).servers
    expect(servers.map(server => server.status)).toEqual(['unknown', 'unknown'])
    expect(servers.map(server => server.connection)).toEqual([connection, connection])
  })

  it('redacts userinfo and query from an endpoint and drops non-HTTP schemes', () => {
    const { ctx: context, agent } = ctx({
      health: [
        { serverName: 'cloud', transport: 'streamable-http', endpoint: 'https://user:secret@corp.example/api?token=tok', connection: 'connected', toolsVisible: true },
        { serverName: 'local', transport: 'stdio', endpoint: 'file:///etc/passwd', connection: 'disconnected', toolsVisible: false },
      ],
    })
    const byName = new Map(collectMcpCatalog(context, agent).servers.map(server => [server.serverName, server]))
    // Neither credentials nor the query cross the DTO.
    expect(byName.get('cloud')?.config.endpoint).toBe('https://corp.example/api')
    expect(byName.get('local')?.config.endpoint).toBeNull()
  })

  it('leaves config unresolved when the native runtime is absent', () => {
    const { ctx: context, agent } = ctx({
      global: [schema('mcp__docs__read')],
      visible: [schema('mcp__docs__read')],
    })
    const server = collectMcpCatalog(context, agent).servers[0]
    expect(server?.config).toEqual({ transport: null, endpoint: null })
    expect(server).not.toHaveProperty('connection')
  })

  it('drops malformed endpoint URLs and rejects non-JSON tool schemas', () => {
    const { ctx: context, agent } = ctx({ health: [
      { serverName: 'bad', transport: 'streamable-http', endpoint: 'invalid URL', connection: 'connected', toolsVisible: true },
      { serverName: 'empty', transport: 'streamable-http', endpoint: '', connection: 'connected', toolsVisible: true },
    ] })
    expect(collectMcpCatalog(context, agent).servers.every(server => server.config.endpoint === null)).toBe(true)
    const invalid = ctx({ visible: [schema('broken', { parameters: { callback: () => undefined } } as never)] })
    expect(() => collectToolCatalog(invalid.ctx, invalid.agent)).toThrow('parameters are not lossless JSON')
  })

  it('counts malformed mcp-prefixed names as orphans without a server row', () => {
    const { ctx: context, agent } = ctx({
      global: [schema('mcp__not-a-server-shape!')],
    })
    const catalog = collectMcpCatalog(context, agent)
    expect(catalog.orphanCount).toBe(1)
    expect(catalog.servers).toEqual([])
    expect(catalog.sessionLive).toBe(true)
  })

  it('sorts servers and visible tools by name and freezes the catalog', () => {
    const { ctx: context, agent } = ctx({
      global: [schema('mcp__zeta__run'), schema('mcp__alpha__run'), schema('mcp__alpha__list')],
      visible: [schema('mcp__zeta__run'), schema('mcp__alpha__run'), schema('mcp__alpha__list')],
    })
    const catalog = collectMcpCatalog(context, agent)
    expect(catalog.servers.map(server => server.serverName)).toEqual(['alpha', 'zeta'])
    expect(catalog.servers[0]?.toolsVisible.map(tool => tool.name)).toEqual(['mcp__alpha__list', 'mcp__alpha__run'])
    expect(Object.isFrozen(catalog)).toBe(true)
  })
})

describe('collectToolCatalog', () => {
  it('lists the exact Agent\'s visible tools in name order', () => {
    const { ctx: context, agent } = ctx({ visible: [schema('bash'), schema('edit')] })
    const catalog = collectToolCatalog(context, agent)
    expect(catalog.tools.map(tool => tool.name)).toEqual(['bash', 'edit'])
    expect(Object.isFrozen(catalog.tools[0])).toBe(true)
  })

  it('keeps deferLoading only where the schema declares it', () => {
    const { ctx: context, agent } = ctx({ visible: [schema('lazy', { deferLoading: true }), schema('eager')] })
    const catalog = collectToolCatalog(context, agent)
    // Name order puts 'eager' first; find by name instead of by index.
    expect(catalog.tools.find(tool => tool.name === 'lazy')).toHaveProperty('deferLoading', true)
    expect(catalog.tools.find(tool => tool.name === 'eager')).not.toHaveProperty('deferLoading')
  })
})

describe('exact scoped catalog reads', () => {
  function fixture(stale = false): Context {
    const session = { id: 's', header: { origin: 'user' } }
    const agent = { id: 's', session }
    let registered: unknown = agent
    return {
      agents: { get: () => registered }, sessions: { get: () => session }, get: () => undefined,
      tools: { schemas: () => {
        if (stale) registered = { ...agent }
        return [schema('mcp__docs__read')]
      } },
    } as unknown as Context
  }

  it('returns the exact live Agent catalogs', async () => {
    const context = fixture()
    const signal = new AbortController().signal
    await expect(mcpCatalog(context, 's' as never, signal)).resolves.toMatchObject({ sessionLive: true, servers: [{ serverName: 'docs' }] })
    await expect(toolCatalog(context, 's' as never, signal)).resolves.toMatchObject({ tools: [{ name: 'mcp__docs__read' }] })
  })

  it('discards synchronous native catalogs that replaced the exact Agent', async () => {
    const signal = new AbortController().signal
    await expect(mcpCatalog(fixture(true), 's' as never, signal)).rejects.toMatchObject({ code: 'mayflyHost/session-stale' })
    await expect(toolCatalog(fixture(true), 's' as never, signal)).rejects.toMatchObject({ code: 'mayflyHost/session-stale' })
  })
})
