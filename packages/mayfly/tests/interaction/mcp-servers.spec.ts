/** Tool-registry-only MCP catalog read.
 * @module @ephemeral-ai/mayfly/tests/interaction/mcp-servers
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { collectMcpServers, deriveMcpStatus, parseMcpToolName } from '../../src/interaction/mcp-servers.ts'

/** A tool schema carrying only what the read layer joins on. */
function tool(name: string): ToolSchema {
  return { name, description: '', parameters: { type: 'object', properties: {} } }
}

/** Provide a context with the tools registry views the collector reads. */
function collectContext(over: {
  readonly global?: readonly ToolSchema[]
  readonly scoped?: readonly ToolSchema[]
  readonly session?: boolean
  readonly dropTools?: boolean
}): Context {
  const ctx = new Context()
  if (over.dropTools !== true) {
    ctx.provide('tools', {
      schemas: (scope?: unknown) => (scope === undefined ? over.global ?? [] : over.scoped ?? over.global ?? []),
    } as never)
  }
  const agent = over.session === false ? null : { ctx: new Context() }
  ctx.provide('mayflyCurrentAgent', {
    current: () => agent,
    revision: () => 0,
    subscribe: () => () => {},
  } as never)
  return ctx
}

describe('parseMcpToolName', () => {
  it('splits the public server/tool contract', () => {
    expect(parseMcpToolName('mcp__github__create_issue')).toEqual({ serverName: 'github', toolName: 'create_issue' })
    expect(parseMcpToolName('mcp__docs__read')).toEqual({ serverName: 'docs', toolName: 'read' })
  })

  it('prefers the longest server segment in an ambiguous namespace', () => {
    expect(parseMcpToolName('mcp__a__b__two')).toEqual({ serverName: 'a__b', toolName: 'two' })
  })

  it('rejects names outside the contract', () => {
    expect(parseMcpToolName('spec_probe')).toBeUndefined()
    expect(parseMcpToolName('mcp__nobody')).toBeUndefined()
    expect(parseMcpToolName('mcp____tool')).toBeUndefined()
    expect(parseMcpToolName(`mcp__${'x'.repeat(33)}__tool`)).toBeUndefined()
  })
})

describe('deriveMcpStatus', () => {
  it('derives only the facts the tool registry holds', () => {
    expect(deriveMcpStatus({ registeredCount: 2, visibleCount: 1 })).toBe('synced')
    expect(deriveMcpStatus({ registeredCount: 2, visibleCount: 0 })).toBe('restricted')
    expect(deriveMcpStatus({ registeredCount: 0, visibleCount: 0 })).toBe('no-tools')
  })
})

describe('collectMcpServers', () => {
  it('builds configured server rows from registered tools and no loader entry', async () => {
    const ctx = collectContext({ global: [tool('mcp__github__create_issue'), tool('mcp__github__search'), tool('spec_probe')] })
    const catalog = await collectMcpServers(ctx)
    expect(catalog.sessionLive).toBe(true)
    expect(catalog.orphanCount).toBe(0)
    expect(catalog.servers).toHaveLength(1)
    expect(catalog.servers[0]).toMatchObject({
      entryId: 'github',
      serverName: 'github',
      transport: 'unknown',
      endpoint: '(not exposed by the native registry)',
      envKeys: [],
      headerKeys: [],
      cwd: undefined,
      toolCallTimeoutMs: undefined,
      failOnStartupError: undefined,
      reconnect: undefined,
      disabled: false,
      status: 'synced',
      registeredCount: 2,
    })
    expect(catalog.servers[0]!.toolsVisible.map(schema => schema.name)).toEqual([
      'mcp__github__create_issue',
      'mcp__github__search',
    ])
  })

  it('joins the global health view with the exact Agent scope', async () => {
    const ctx = collectContext({
      global: [tool('mcp__limited__one'), tool('mcp__limited__two'), tool('mcp__other__one')],
      scoped: [tool('mcp__other__one')],
    })
    const catalog = await collectMcpServers(ctx)
    expect(catalog.servers.map(server => [server.serverName, server.status, server.registeredCount, server.toolsVisible.length])).toEqual([
      ['limited', 'restricted', 2, 0],
      ['other', 'synced', 1, 1],
    ])
  })

  it('includes local registrations without inflating duplicate global names', async () => {
    const ctx = new Context()
    let scoped: readonly ToolSchema[] = []
    ctx.provide('tools', {
      schemas: (scope?: unknown) => scope === undefined
        ? [tool('mcp__demo__global')]
        : scoped,
    } as never)
    ctx.provide('mayflyCurrentAgent', { current: () => ({ ctx: new Context() }), revision: () => 0, subscribe: () => () => {} } as never)
    scoped = [tool('mcp__demo__global'), tool('mcp__demo__local')]
    const catalog = await collectMcpServers(ctx)
    expect(catalog.servers[0]).toMatchObject({ status: 'synced', registeredCount: 1, toolsVisible: expect.any(Array) })
    expect(catalog.servers[0]!.toolsVisible).toHaveLength(2)
  })

  it('counts names outside the public contract as unknown and ignores non-MCP tools', async () => {
    const ctx = collectContext({ global: [
      tool('spec_probe'),
      tool('mcp__known__one'),
      tool('mcp__nobody'),
      tool('mcp____tool'),
    ] })
    const catalog = await collectMcpServers(ctx)
    expect(catalog.orphanCount).toBe(2)
    expect(catalog.servers.map(server => server.serverName)).toEqual(['known'])
  })

  it('shows no row for a configured server that registered no tools', async () => {
    const ctx = collectContext({ global: [tool('read_file')] })
    const catalog = await collectMcpServers(ctx)
    expect(catalog.servers).toEqual([])
    expect(catalog.orphanCount).toBe(0)
  })

  it('degrades to the global view with a session flag when no agent is live', async () => {
    const ctx = collectContext({ global: [tool('mcp__github__create_issue')], session: false })
    const catalog = await collectMcpServers(ctx)
    expect(catalog.sessionLive).toBe(false)
    expect(catalog.servers[0]).toMatchObject({ status: 'synced', registeredCount: 1 })
    expect(catalog.servers[0]!.toolsVisible).toHaveLength(1)
  })

  it('uses the exact Agent view for visibility', async () => {
    const ctx = collectContext({ global: [tool('mcp__github__one')], scoped: [] })
    const agent = { ctx: new Context() } as never
    const catalog = await collectMcpServers(ctx, agent)
    expect(catalog.servers[0]!.status).toBe('restricted')
    expect(catalog.servers[0]!.toolsVisible).toEqual([])
  })

  it('sorts server rows by namespace', async () => {
    const ctx = collectContext({ global: [tool('mcp__z__one'), tool('mcp__a__one')] })
    expect((await collectMcpServers(ctx)).servers.map(server => server.serverName)).toEqual(['a', 'z'])
  })

  it('rejects when the host composes no tools service', async () => {
    await expect(collectMcpServers(collectContext({ dropTools: true }))).rejects.toThrow(/tools/)
  })
})
