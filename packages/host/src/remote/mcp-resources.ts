/** Fixed-name native MCP resource/template operations with exact Session scope. @module */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { ConversationJson } from '../conversation/types.ts'
import type { MayflyMcpResourceBody, MayflyMcpResourceItem, MayflyMcpResourceListRequest, MayflyMcpResourcePage, MayflyMcpResourceReadRequest } from '../types.ts'
import { frozen, jsonSnapshot } from './json.ts'
import { requireExactAgent, resolveExactAgent } from './session.ts'

async function invoke(ctx: Context, agent: Agent, name: string, args: Record<string, string>, signal: AbortSignal, server: string): Promise<unknown> {
  const batch = await ctx.tools.execute({ calls: [{ type: 'tool-call', id: randomUUID() as ToolCallId, name, arguments: JSON.stringify(args) }], agent, signal })
  signal.throwIfAborted()
  requireExactAgent(ctx, agent.id, agent)
  const outcome = batch.results[0]?.result
  if (outcome === undefined) throw new RemoteError('mayflyHost/mcp-resource-failed', `MCP resource operation returned no result for "${server}"`, { server, message: 'no result' })
  if (outcome.isError) {
    const message = outcome.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    throw new RemoteError('mayflyHost/mcp-resource-failed', `MCP resource operation failed for "${server}": ${message}`, { server, message })
  }
  return outcome.value
}

function record(value: unknown, server: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RemoteError('mayflyHost/mcp-resource-failed', `MCP returned an invalid result for "${server}"`, { server, message: 'invalid result' })
  }
  return value as Record<string, unknown>
}

/** List one page through only the native list_mcp_resources/list_mcp_resource_templates operations. */
export async function listMcpResources(ctx: Context, request: MayflyMcpResourceListRequest, signal: AbortSignal): Promise<MayflyMcpResourcePage> {
  const agent = await resolveExactAgent(ctx, request.sessionId, signal)
  const templates = request.kind === 'templates'
  const result = await invoke(ctx, agent, templates ? 'list_mcp_resource_templates' : 'list_mcp_resources', {
    server: request.server,
    ...request.cursor === undefined ? {} : { cursor: request.cursor },
  }, signal, request.server)
  const value = record(result, request.server)
  const rows = value[templates ? 'resourceTemplates' : 'resources']
  if (!Array.isArray(rows)) {
    throw new RemoteError('mayflyHost/mcp-resource-failed', `MCP returned an invalid catalog for "${request.server}"`, { server: request.server, message: 'invalid catalog' })
  }
  const items = rows.map((row): MayflyMcpResourceItem => {
    const snapshot = jsonSnapshot(record(row, request.server)) as MayflyMcpResourceItem | undefined
    if (snapshot === undefined) {
      throw new RemoteError('mayflyHost/mcp-resource-failed', `MCP returned a non-JSON resource row for "${request.server}"`, { server: request.server, message: 'invalid resource row' })
    }
    return snapshot
  })
  const nextCursor = value.nextCursor
  return frozen({ items, ...typeof nextCursor === 'string' ? { cursor: nextCursor } : {} })
}

/** Read through only native read_mcp_resource; binary bodies become summaries, never raw bytes. */
export async function readMcpResource(ctx: Context, request: MayflyMcpResourceReadRequest, signal: AbortSignal): Promise<MayflyMcpResourceBody> {
  const agent = await resolveExactAgent(ctx, request.sessionId, signal)
  const result = await invoke(ctx, agent, 'read_mcp_resource', { server: request.server, uri: request.uri }, signal, request.server)
  const value = record(result, request.server)
  const contents = Array.isArray(value.contents) ? value.contents : []
  const text = contents.map(content => {
    if (content === null || typeof content !== 'object' || Array.isArray(content)) return `Binary resource: ${request.uri} (unknown media type)`
    const row = content as Record<string, ConversationJson>
    return typeof row.text === 'string'
      ? row.text
      : `Binary resource: ${String(row.uri ?? request.uri)} (${String(row.mimeType ?? 'unknown media type')})`
  }).join('\n\n')
  return frozen({ text })
}
