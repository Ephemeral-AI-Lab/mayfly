/**
 * Runtime-optional structural probe for the native MCP resource runtime. The
 * published npm line does not ship `listServers`; a Host composition that
 * includes it exposes a wider public face. This module owns the narrow shape
 * both the MCP catalog and the dynamic capability list read, without
 * importing private Host types: only fields already documented as sanitized
 * public catalog values cross this seam.
 *
 * @module @ephemeral-ai/mayfly-host/remote/mcp-catalog-face
 */

import type { Context } from '@deepseek-ai/cordis'

/** One sanitized configured-server row the native public catalog exposes. */
export interface McpCatalogServerRow {
  readonly serverName: string
  readonly transport: 'stdio' | 'streamable-http'
  readonly endpoint: string | null
  readonly connection: 'connecting' | 'connected' | 'reconnecting' | 'disconnected'
  readonly toolsVisible: boolean
}

/**
 * The narrow structural face of the native `mcpResources` service this package
 * consumes: one sanitized server listing, no registrations and no requests.
 */
export interface McpCatalogFace {
  listServers?(): readonly {
    readonly serverName: string
    readonly transport: 'stdio' | 'streamable-http'
    readonly endpoint: string | null
    readonly connection: 'connecting' | 'connected' | 'reconnecting' | 'disconnected'
    readonly toolsVisible: boolean
  }[]
}

const TRANSPORTS: readonly string[] = ['stdio', 'streamable-http']
const CONNECTIONS: readonly string[] = ['connecting', 'connected', 'reconnecting', 'disconnected']

/**
 * Read the optional native catalog face; `undefined` when the service or its
 * listing is absent, so callers keep their tool-derived fallback.
 * @param ctx - Host context whose services are probed without installation requirements.
 * @returns the face when `listServers` is a callable method.
 */
export function mcpCatalogFace(ctx: Context): McpCatalogFace | undefined {
  const face = ctx.get('mcpResources') as McpCatalogFace | undefined
  return typeof face === 'object' && face !== null && typeof face.listServers === 'function' ? face : undefined
}

/**
 * Read the sanitized server rows the face currently lists; a probe that throws
 * or returns malformed rows degrades to the rows that did validate.
 * @param ctx - Host context whose native catalog is read.
 * @returns validated rows in the face's own configured-name order, or `undefined` without a face.
 */
export function mcpCatalogServers(ctx: Context): readonly McpCatalogServerRow[] | undefined {
  const face = mcpCatalogFace(ctx)
  if (face === undefined) return undefined
  let listed: unknown
  try {
    listed = face.listServers!()
  } catch {
    return []
  }
  if (!Array.isArray(listed)) return []
  const rows: McpCatalogServerRow[] = []
  for (const entry of listed) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Record<string, unknown>
    if (typeof row['serverName'] !== 'string' || row['serverName'] === '') continue
    if (typeof row['transport'] !== 'string' || !TRANSPORTS.includes(row['transport'])) continue
    if (row['endpoint'] !== null && typeof row['endpoint'] !== 'string') continue
    if (typeof row['connection'] !== 'string' || !CONNECTIONS.includes(row['connection'])) continue
    if (typeof row['toolsVisible'] !== 'boolean') continue
    rows.push({
      serverName: row['serverName'],
      transport: row['transport'] as McpCatalogServerRow['transport'],
      endpoint: row['endpoint'] as string | null,
      connection: row['connection'] as McpCatalogServerRow['connection'],
      toolsVisible: row['toolsVisible'],
    })
  }
  return rows
}
