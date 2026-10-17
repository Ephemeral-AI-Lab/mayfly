/**
 * Read-only MCP facts from the native tool registry.
 *
 * There is no native connection-status or configured-server catalog: an MCP
 * client's identity is only observable through the `mcp__<server>__<tool>`
 * names it registers. This module therefore shows one row per server that has
 * registered tools (global view: everything the registry holds, including
 * tools restricted away from the session; exact-Agent view: what that session
 * may call) and counts `mcp__`-prefixed names that do not fit that public
 * naming contract as unknown. It never reads loader entries, Fiber state, or
 * client configuration, so transport/policy rows stay explicitly unavailable
 * rather than guessed.
 *
 * @module @ephemeral-ai/mayfly/interaction/mcp-servers
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type {} from '../app/index.ts'

/** The public prefix of MCP-served tool names (`mcp__<server>__<raw>`). */
const MCP_PREFIX = 'mcp__'

/** The public naming contract: server segment plus raw tool name. */
const MCP_TOOL_NAME = /^mcp__([A-Za-z0-9_-]{1,32})__(.+)$/u

/** The derived display status of one MCP server row. */
export type McpStatus = 'synced' | 'restricted' | 'no-tools' | 'starting' | 'failed' | 'reloading' | 'disabled'

/** The resolved reconnect policy fields the panel shows. */
interface McpReconnectView {
  readonly enabled: boolean
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly maxAttempts: number
}

/** One MCP server's tool-registry read. */
export interface McpServerView {
  /** Stable row identity: the server namespace (no loader entry id is read). */
  readonly entryId: string
  /** The declared namespace of the public tool names. */
  readonly serverName: string
  /** Not exposed by the native tool registry. */
  readonly transport: string
  /** Not exposed by the native tool registry. */
  readonly endpoint: string
  /** Not exposed by the native tool registry. */
  readonly cwd: string | undefined
  /** Not exposed by the native tool registry. */
  readonly envKeys: readonly string[]
  /** Not exposed by the native tool registry. */
  readonly headerKeys: readonly string[]
  readonly toolCallTimeoutMs: number | undefined
  readonly failOnStartupError: boolean | undefined
  readonly reconnect: McpReconnectView | undefined
  /** No disabled-entry fact is available without loader internals; always false. */
  readonly disabled: boolean
  /** The derived status. */
  readonly status: McpStatus
  /** Distinct tool names in the global and selected-Agent views, including restricted globals. */
  readonly registeredCount: number
  /** The session-visible tools of this server (equals the global view when no session is live). */
  readonly toolsVisible: readonly ToolSchema[]
}

/** The whole `/mcp` read: servers plus the join's honest leftovers. */
export interface McpCatalog {
  readonly servers: readonly McpServerView[]
  /** `mcp__`-prefixed tools whose name does not fit the public server/tool contract. */
  readonly orphanCount: number
  /** False when no agent session is live — counts then read the global registry view only. */
  readonly sessionLive: boolean
}

/** One registered MCP tool name split into its public server and raw tool segments. */
export function parseMcpToolName(name: string): { readonly serverName: string, readonly toolName: string } | undefined {
  if (!name.startsWith(MCP_PREFIX)) return undefined
  const match = MCP_TOOL_NAME.exec(name)
  return match === null ? undefined : { serverName: match[1]!, toolName: match[2]! }
}

/**
 * Derive one server's display status from tool-registry facts only. A server
 * with registered tools but none visible to the exact Agent is restricted;
 * registered and visible is synced. The remaining states belong to facts no
 * native service exposes and are never invented here.
 * @param input - the row's registered and visible counts.
 * @returns the status.
 */
export function deriveMcpStatus(input: { readonly registeredCount: number, readonly visibleCount: number }): McpStatus {
  if (input.registeredCount === 0) return 'no-tools'
  return input.visibleCount === 0 ? 'restricted' : 'synced'
}

/**
 * Collect the MCP server catalog from the native tool registry.
 * @param ctx - native tools consumer context.
 * @param agent - exact native Agent whose visible tools are read; null uses globals.
 * @returns the joined catalog.
 * @throws when the tools service is absent or native schema projection fails.
 */
export async function collectMcpServers(ctx: Context, agent: Agent | null = ctx.mayflyCurrentAgent.current()): Promise<McpCatalog> {
  const tools = ctx.get('tools')
  if (tools === undefined) throw new Error('the host composes no tools service')

  /* The global view retains restricted tools; the exact-Agent view is what
     that session may call. */
  const globalSchemas = tools.schemas()
  const sessionLive = agent !== null
  const visibleSchemas = agent === null ? globalSchemas : tools.schemas(agent)

  const registered = new Map<string, number>()
  let orphanCount = 0
  for (const name of new Set(globalSchemas.map(schema => schema.name))) {
    if (!name.startsWith(MCP_PREFIX)) continue
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
    const list = visible.get(parsed.serverName) ?? []
    list.push(schema)
    visible.set(parsed.serverName, list)
  }

  const servers = [...new Set([...registered.keys(), ...visible.keys()])]
    .toSorted((left, right) => left.localeCompare(right))
    .map((serverName): McpServerView => {
      const registeredCount = registered.get(serverName) ?? 0
      const toolsVisible = visible.get(serverName) ?? []
      return {
        entryId: serverName,
        serverName,
        /* No native API exposes connection configuration or health. */
        transport: 'unknown',
        endpoint: '(not exposed by the native registry)',
        cwd: undefined,
        envKeys: [],
        headerKeys: [],
        toolCallTimeoutMs: undefined,
        failOnStartupError: undefined,
        reconnect: undefined,
        disabled: false,
        status: deriveMcpStatus({ registeredCount, visibleCount: toolsVisible.length }),
        registeredCount,
        toolsVisible,
      }
    })
  return { servers, orphanCount, sessionLive }
}
