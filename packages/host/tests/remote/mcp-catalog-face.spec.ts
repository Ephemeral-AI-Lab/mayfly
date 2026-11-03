/** Optional native catalog probes reject malformed rows without leaking connection data. @module */
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { mcpCatalogServers } from '../../src/remote/mcp-catalog-face.ts'

function ctx(value: unknown): Context {
  return { get: () => value } as unknown as Context
}

describe('optional native MCP catalog face', () => {
  it('uses only sanitized valid configured rows, preserving their order', () => {
    const valid = { serverName: 'native', transport: 'stdio', endpoint: null, connection: 'connected', toolsVisible: true }
    const rows = [null, 1, { ...valid, serverName: '' }, { ...valid, serverName: 1 },
      { ...valid, transport: 'socket' }, { ...valid, transport: 1 }, { ...valid, endpoint: 1 },
      { ...valid, connection: 'unknown' }, { ...valid, connection: 1 }, { ...valid, toolsVisible: 1 }, valid]
    expect(mcpCatalogServers(ctx({ listServers: () => rows }))).toEqual([valid])
  })

  it('degrades to an empty configured list when native listing fails or has an invalid shape', () => {
    expect(mcpCatalogServers(ctx({ listServers: () => { throw new Error('private endpoint failed') } }))).toEqual([])
    expect(mcpCatalogServers(ctx({ listServers: () => ({}) }))).toEqual([])
    expect(mcpCatalogServers(ctx(undefined))).toBeUndefined()
  })
})
