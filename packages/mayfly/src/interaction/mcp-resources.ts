/** On-demand MCP resource metadata, explicit body reads, and their display rows.
 * @module @ephemeral-ai/mayfly/interaction/mcp-resources
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { MayflyListItem } from '@ephemeral-ai/mayfly-ui'

/** One page of an MCP resource or resource-template catalog. */
export interface McpResourceCatalog {
  readonly items: readonly Record<string, unknown>[]
  readonly cursor: string | undefined
}

/* The resource tools are the native `mcpResources` contribution to the exact
   Agent's tool pipeline; call them by their public names and let the registry
   resolve the caller's scope. No client or fallback path exists. */
async function invoke(ctx: Context, agent: Agent, name: string, args: Record<string, string>, signal: AbortSignal): Promise<unknown> {
  const outcome = await ctx.tools.execute({ callId: randomUUID() as ToolCallId, agent, signal, name, arguments: args })
  if (outcome.isError) throw new Error(outcome.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
  return outcome.value
}

/**
 * Read one page of a server's resources or resource templates.
 * @param ctx - context providing the exact Agent's native tools.
 * @param agent - the Agent whose scope resolves the resource tool.
 * @param server - the MCP server namespace.
 * @param templates - list resource templates instead of concrete resources.
 * @param signal - ends the native call.
 * @param cursor - the next-page cursor from an earlier read.
 * @returns the page's metadata rows and cursor.
 */
export async function listMcpResources(ctx: Context, agent: Agent, server: string, templates: boolean, signal: AbortSignal, cursor?: string): Promise<McpResourceCatalog> {
  const result = await invoke(ctx, agent, templates ? 'list_mcp_resource_templates' : 'list_mcp_resources', { server, ...cursor === undefined ? {} : { cursor } }, signal)
  if (typeof result !== 'object' || result === null) throw new Error('MCP returned no resource catalog')
  const value = result as Record<string, unknown>
  const rows = value[templates ? 'resourceTemplates' : 'resources']
  if (!Array.isArray(rows)) throw new Error('MCP returned an invalid resource catalog')
  return {
    items: rows.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null),
    cursor: typeof value.nextCursor === 'string' ? value.nextCursor : undefined,
  }
}

/**
 * Read one explicit resource URI. Binary contents are described, never decoded.
 * @param ctx - context providing the exact Agent's native tools.
 * @param agent - the Agent whose scope resolves the read.
 * @param server - the MCP server namespace.
 * @param uri - the resource or expanded template URI.
 * @param signal - ends the native call.
 * @returns the resource body text.
 */
export async function readMcpResource(ctx: Context, agent: Agent, server: string, uri: string, signal: AbortSignal): Promise<string> {
  const result = await invoke(ctx, agent, 'read_mcp_resource', { server, uri }, signal)
  const value = typeof result === 'object' && result !== null ? result as Record<string, unknown> : {}
  const contents = Array.isArray(value.contents) ? value.contents as Record<string, unknown>[] : []
  return contents.map(content => typeof content.text === 'string' ? content.text : `Binary resource: ${String(content.uri ?? uri)} (${String(content.mimeType ?? 'unknown media type')})`).join('\n\n')
}

/** The rows of one resource or template page: the name, with the URI as the row's description. */
export function resourceItems(items: readonly Record<string, unknown>[]): readonly MayflyListItem[] {
  return items.map((item, index) => ({
    id: String(index),
    label: String(item.name ?? item.uri ?? item.uriTemplate ?? index),
    detail: String(item.description ?? item.uri ?? item.uriTemplate ?? ''),
    searchText: [item.name, item.uri, item.uriTemplate, item.description].filter(value => typeof value === 'string').join(' '),
  }))
}
