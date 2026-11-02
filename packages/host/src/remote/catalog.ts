/** Construction-frozen MCP and session-tool catalogs projected from native schemas and public transport health. @module */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'
import type { ConversationJson } from '../conversation/types.ts'
import type { MayflyMcpCatalog, MayflyMcpServer, MayflyMcpStatus, MayflyToolCatalog, MayflyToolSchema } from '../types.ts'
import { mcpCatalogServers, type McpCatalogServerRow } from './mcp-catalog-face.ts'
import { frozen, jsonSnapshot } from './json.ts'
import { requireExactAgent, resolveExactAgent } from './session.ts'

const MCP_TOOL_NAME = /^mcp__([A-Za-z0-9_-]{1,32})__(.+)$/u

function parseMcpToolName(name: string): { readonly serverName: string } | undefined {
  if (!name.startsWith('mcp__')) return undefined
  const match = MCP_TOOL_NAME.exec(name)
  return match === null ? undefined : { serverName: match[1]! }
}

function statusOf(visibleCount: number): MayflyMcpStatus {
  return visibleCount === 0 ? 'restricted' : 'synced'
}

/**
 * Strip userinfo and query from one endpoint defensively: the native catalog
 * already redacts, but a composition must not leak credentials through this
 * DTO even when its face does not.
 */
function sanitizeEndpoint(endpoint: string | null): string | null {
  if (typeof endpoint !== 'string' || endpoint === '') return null
  try {
    const url = new URL(endpoint)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return `${url.origin}${url.pathname}`
  } catch {
    return null
  }
}

function schemaDtos(schemas: readonly ToolSchema[]): readonly MayflyToolSchema[] {
  return schemas.map((schema): MayflyToolSchema => {
    const parameters = jsonSnapshot(schema.parameters as Record<string, ConversationJson>)
    if (parameters === undefined) throw new Error(`tool "${schema.name}" parameters are not lossless JSON`)
    return frozen({
      name: schema.name,
      description: schema.description,
      parameters,
      ...schema.deferLoading === true ? { deferLoading: true } : {},
    })
  }).toSorted((left, right) => left.name.localeCompare(right.name))
}

/** Merge the registered/visible tool counts with one optional sanitized native health row. */
function serverDto(serverName: string, registeredCount: number, toolsVisible: readonly MayflyToolSchema[], health: McpCatalogServerRow | undefined): MayflyMcpServer {
  const configuredWithoutTools = health !== undefined && !health.toolsVisible
  return {
    entryId: serverName,
    serverName,
    status: health !== undefined && health.connection !== 'connected'
      ? 'unknown'
      : configuredWithoutTools || registeredCount === 0 ? 'no-tools' : statusOf(toolsVisible.length),
    registeredCount,
    toolsVisible,
    config: health === undefined
      ? { transport: null, endpoint: null }
      : { transport: health.transport, endpoint: sanitizeEndpoint(health.endpoint) },
    ...health === undefined ? {} : { connection: health.connection },
  }
}

/** Read global and exact-Agent schema views once and join them, with optional native health, into the current MCP panel DTO. */
export function collectMcpCatalog(ctx: Context, agent: Agent): MayflyMcpCatalog {
  const globalSchemas = ctx.tools.schemas()
  const visibleSchemas = ctx.tools.schemas(agent)
  const healthRows = mcpCatalogServers(ctx)
  const health = new Map<string, McpCatalogServerRow>()
  if (healthRows !== undefined) for (const row of healthRows) if (!health.has(row.serverName)) health.set(row.serverName, row)
  const registered = new Map<string, number>()
  let orphanCount = 0
  for (const name of new Set([...globalSchemas, ...visibleSchemas].map(schema => schema.name))) {
    if (!name.startsWith('mcp__')) continue
    const parsed = parseMcpToolName(name)
    if (parsed === undefined) {
      orphanCount += 1
      continue
    }
    registered.set(parsed.serverName, (registered.get(parsed.serverName) ?? 0) + 1)
  }
  const visible = new Map<string, ToolSchema[]>()
  for (const schema of visibleSchemas) {
    const parsed = parseMcpToolName(schema.name)
    if (parsed === undefined) continue
    const tools = visible.get(parsed.serverName) ?? []
    tools.push(schema)
    visible.set(parsed.serverName, tools)
  }
  const servers = [...new Set([...registered.keys(), ...visible.keys(), ...health.keys()])]
    .toSorted((left, right) => left.localeCompare(right))
    .map((serverName): MayflyMcpServer => serverDto(serverName, registered.get(serverName) ?? 0, schemaDtos(visible.get(serverName) ?? []), health.get(serverName)))
  return frozen({ servers, orphanCount, sessionLive: true })
}

/** Read the exact Agent's visible tool schemas in stable name order. */
export function collectToolCatalog(ctx: Context, agent: Agent): MayflyToolCatalog {
  return frozen({ tools: schemaDtos(ctx.tools.schemas(agent)) })
}

/** Resolve the authorized exact Agent, then take one construction-frozen MCP snapshot. */
export async function mcpCatalog(ctx: Context, sessionId: Parameters<typeof resolveExactAgent>[1], signal: AbortSignal): Promise<MayflyMcpCatalog> {
  const agent = await resolveExactAgent(ctx, sessionId, signal)
  const catalog = collectMcpCatalog(ctx, agent)
  signal.throwIfAborted()
  requireExactAgent(ctx, sessionId, agent)
  return catalog
}

/** Resolve the authorized exact Agent, then take one construction-frozen tool snapshot. */
export async function toolCatalog(ctx: Context, sessionId: Parameters<typeof resolveExactAgent>[1], signal: AbortSignal): Promise<MayflyToolCatalog> {
  const agent = await resolveExactAgent(ctx, sessionId, signal)
  const catalog = collectToolCatalog(ctx, agent)
  signal.throwIfAborted()
  requireExactAgent(ctx, sessionId, agent)
  return catalog
}
