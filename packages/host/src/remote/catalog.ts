/** Construction-frozen MCP and session-tool catalogs projected from native schemas. @module */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'
import type { ConversationJson } from '../conversation/types.ts'
import type { MayflyMcpCatalog, MayflyMcpServer, MayflyMcpStatus, MayflyToolCatalog, MayflyToolSchema } from '../types.ts'
import { frozen, jsonSnapshot } from './json.ts'
import { resolveExactAgent } from './session.ts'

const MCP_TOOL_NAME = /^mcp__([A-Za-z0-9_-]{1,32})__(.+)$/u

function parseMcpToolName(name: string): { readonly serverName: string } | undefined {
  if (!name.startsWith('mcp__')) return undefined
  const match = MCP_TOOL_NAME.exec(name)
  return match === null ? undefined : { serverName: match[1]! }
}

function statusOf(registeredCount: number, visibleCount: number): MayflyMcpStatus {
  if (registeredCount === 0) return 'no-tools'
  return visibleCount === 0 ? 'restricted' : 'synced'
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

/** Read global and exact-Agent schema views once and join them into the current MCP panel DTO. */
export function collectMcpCatalog(ctx: Context, agent: Agent): MayflyMcpCatalog {
  const globalSchemas = ctx.tools.schemas()
  const visibleSchemas = ctx.tools.schemas(agent)
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
  const servers = [...new Set([...registered.keys(), ...visible.keys()])]
    .toSorted((left, right) => left.localeCompare(right))
    .map((serverName): MayflyMcpServer => {
      const registeredCount = registered.get(serverName) ?? 0
      const toolsVisible = schemaDtos(visible.get(serverName) ?? [])
      return {
        entryId: serverName,
        serverName,
        status: statusOf(registeredCount, toolsVisible.length),
        registeredCount,
        toolsVisible,
        config: { transport: null, endpoint: null },
      }
    })
  return frozen({ servers, orphanCount, sessionLive: true })
}

/** Read the exact Agent's visible tool schemas in stable name order. */
export function collectToolCatalog(ctx: Context, agent: Agent): MayflyToolCatalog {
  return frozen({ tools: schemaDtos(ctx.tools.schemas(agent)) })
}

/** Resolve the authorized exact Agent, then take one construction-frozen MCP snapshot. */
export async function mcpCatalog(ctx: Context, sessionId: Parameters<typeof resolveExactAgent>[1], signal: AbortSignal): Promise<MayflyMcpCatalog> {
  const agent = await resolveExactAgent(ctx, sessionId, signal)
  return collectMcpCatalog(ctx, agent)
}

/** Resolve the authorized exact Agent, then take one construction-frozen tool snapshot. */
export async function toolCatalog(ctx: Context, sessionId: Parameters<typeof resolveExactAgent>[1], signal: AbortSignal): Promise<MayflyToolCatalog> {
  const agent = await resolveExactAgent(ctx, sessionId, signal)
  return collectToolCatalog(ctx, agent)
}
