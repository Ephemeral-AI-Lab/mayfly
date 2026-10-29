/**
 * Paged MCP resource and template browsing over the generated mayflyHost
 * Remote namespace. The Host owns listing, cursors, and body reads through the
 * fixed native MCP operations; this adapter narrows the JSON rows to the
 * browser-safe fields and never executes a tool as a fallback.
 *
 * @module @ephemeral-ai/mayfly/remote/features/mcp-resources
 */

import type {
  MayflyMcpResourceBody,
  MayflyMcpResourceItem,
  MayflyMcpResourcePage,
} from '@ephemeral-ai/mayfly-host/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { HostClient } from '../../client/types.ts'

/** Browser-safe resource metadata; binary bodies stay summarized on the Host. */
export interface RemoteMcpResourceItem {
  readonly uri: string
  readonly name?: string
  readonly description?: string
  readonly mimeType?: string
}

/** One cursor page of resource or resource-template metadata. */
export interface RemoteMcpResourcePage {
  readonly items: readonly RemoteMcpResourceItem[]
  readonly nextCursor?: string
}

/** One server-scoped page request: kind, optional continuation cursor. */
export interface RemoteMcpResourcePageRequest {
  readonly serverName: string
  readonly templates: boolean
  readonly cursor?: string
}

/**
 * Page loader over `client.remote.mayflyHost.listMcpResources`; a failed page
 * rejects with the Remote failure for the owning feature to fence and show.
 */
export type RemoteMcpResourcePageLoader = (
  client: HostClient,
  sessionId: SessionId,
  request: RemoteMcpResourcePageRequest,
  signal: AbortSignal,
) => Promise<RemoteMcpResourcePage>

/**
 * Body reader over `client.remote.mayflyHost.readMcpResource`; text and binary
 * summaries arrive as one Host-summarized document.
 */
export type RemoteMcpResourceReader = (
  client: HostClient,
  sessionId: SessionId,
  serverName: string,
  uri: string,
  signal: AbortSignal,
) => Promise<MayflyMcpResourceBody>

function textOf(row: MayflyMcpResourceItem, key: string): string | undefined {
  const value = row[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Narrow one JSON-safe Host row to the browser-safe fields the panel renders. */
export function remoteMcpResourceItem(row: MayflyMcpResourceItem): RemoteMcpResourceItem {
  const name = textOf(row, 'name')
  const description = textOf(row, 'description')
  const mimeType = textOf(row, 'mimeType')
  return {
    uri: textOf(row, 'uri') ?? '',
    ...name === undefined ? {} : { name },
    ...description === undefined ? {} : { description },
    ...mimeType === undefined ? {} : { mimeType },
  }
}

function pageOf(page: MayflyMcpResourcePage): RemoteMcpResourcePage {
  return {
    items: page.items.filter(row => textOf(row, 'uri') !== undefined).map(remoteMcpResourceItem),
    ...page.cursor === undefined ? {} : { nextCursor: page.cursor },
  }
}

/** Load one page through the generated Host namespace with exact Session scope. */
export const loadRemoteMcpResources: RemoteMcpResourcePageLoader = async (client, sessionId, request, signal) => {
  const result = await client.remote.mayflyHost.listMcpResources({
    sessionId,
    server: request.serverName,
    kind: request.templates ? 'templates' : 'resources',
    ...request.cursor === undefined ? {} : { cursor: request.cursor },
  }, signal)
  signal.throwIfAborted()
  if (!result.ok) throw result.error
  return pageOf(result.value)
}

/** Read one resource body through the generated Host namespace with exact Session scope. */
export const readRemoteMcpResource: RemoteMcpResourceReader = async (client, sessionId, serverName, uri, signal) => {
  const result = await client.remote.mayflyHost.readMcpResource({ sessionId, server: serverName, uri }, signal)
  signal.throwIfAborted()
  if (!result.ok) throw result.error
  return result.value
}
