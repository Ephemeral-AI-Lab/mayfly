/**
 * Typed follow-up contract for the Host mcpResources capability absent from this composition.
 * @module @ephemeral-ai/mayfly/remote/features/mcp-resources
 */

import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Exact Session/server-scoped resource or template page request. */
export interface RemoteMcpResourceListRequest {
  readonly sessionId: SessionId
  readonly serverName: string
  readonly templates: boolean
  readonly cursor?: string
}

/** Browser-safe resource metadata; binary bodies are summarized rather than executed as tools. */
export interface RemoteMcpResourceItem {
  readonly uri: string
  readonly name?: string
  readonly description?: string
  readonly mimeType?: string
  readonly binary?: { readonly bytes: number, readonly mediaType?: string }
}

/** One cursor page of resource or resource-template metadata. */
export interface RemoteMcpResourcePage {
  readonly items: readonly RemoteMcpResourceItem[]
  readonly nextCursor?: string
}

/** Exact resource body read request. */
export interface RemoteMcpResourceReadRequest {
  readonly sessionId: SessionId
  readonly serverName: string
  readonly uri: string
}

/** Lossless text or bounded base64 binary content returned by a future focused Host method. */
export type RemoteMcpResourceContent =
  | { readonly kind: 'text', readonly text: string, readonly mimeType?: string }
  | { readonly kind: 'binary', readonly base64: string, readonly bytes: number, readonly mimeType?: string }

/** Body response for one resource URI. */
export interface RemoteMcpResourceBody {
  readonly uri: string
  readonly contents: readonly RemoteMcpResourceContent[]
  readonly truncated: boolean
}

/** Focused list/read seam required before claiming MCP resource browsing. */
export interface RemoteMcpResources {
  list(request: RemoteMcpResourceListRequest, signal: AbortSignal): Promise<RemoteResult<RemoteMcpResourcePage>>
  read(request: RemoteMcpResourceReadRequest, signal: AbortSignal): Promise<RemoteResult<RemoteMcpResourceBody>>
}

/** Accurate Host integration gap shown in the Resources tab. */
export const REMOTE_MCP_RESOURCES_GAP = 'Host mcpResources is required for paged resource/template listing and body reads; this build does not execute tools as a fallback'
