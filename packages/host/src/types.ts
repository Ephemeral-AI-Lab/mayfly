/**
 * Client-safe DTOs and Remote errors for the Mayfly Host capability.
 *
 * @module @ephemeral-ai/mayfly-host/types
 */

import type { ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools/presentation'
import type { TypertResource } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkflowAgentOutcome, WorkflowPhase, WorkflowStopReason } from '@deepseek-ai/dsh-workflow/types'
import type { ConversationJson } from './conversation/types.ts'

export type * from './conversation/types.ts'

/** Mayfly Host features advertised by the capabilities handshake. */
export type MayflyHostFeature = 'mayflyConversation' | 'presentTools' | 'followWorkflow' | 'gitStatus' | 'mcpCatalog' | 'toolCatalog'

/** Version and feature facts a Client validates before entering its UI. */
export interface MayflyHostCapabilities {
  readonly protocolVersion: number
  readonly hostVersion: string
  readonly requiredDshVersion: string
  readonly features: readonly MayflyHostFeature[]
}

/** Details of a requested feature absent from this Host composition. */
export interface MayflyHostCapabilityUnavailableDetails {
  readonly feature: string
}

/** Session identity carried by a Host-scoped request or failure. */
export interface MayflyHostSessionRequest {
  readonly sessionId: SessionId
}

/** Mayfly Host domain failures carried by the standard Remote error union. */
export type MayflyHostErrorCode =
  | 'mayflyHost/capability-unavailable'
  | 'mayflyHost/agent-unavailable'
  | 'mayflyHost/session-stale'
  | 'mayflyHost/session-directory-unavailable'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertResourceMap {
    /** One Session addressed by a Mayfly Remote request. */
    session: TypertResource<SessionId>
  }

  interface RemoteErrorDetailsMap {
    /** A requested Mayfly feature is not available in this Host composition. */
    'mayflyHost/capability-unavailable': MayflyHostCapabilityUnavailableDetails
    /** A child Session has no live exact Agent and cannot be resumed through ordinary Session routing. */
    'mayflyHost/agent-unavailable': MayflyHostSessionRequest
    /** The exact Agent or effective directory changed before the operation completed. */
    'mayflyHost/session-stale': MayflyHostSessionRequest
    /** Neither the working-directory projection nor Session metadata names a Host directory. */
    'mayflyHost/session-directory-unavailable': MayflyHostSessionRequest
  }
}

/** Durable result fields an official tool presenter consumes. */
export interface MayflyToolResultInput {
  readonly content: readonly ContentBlock[]
  readonly isError: boolean
  readonly meta?: ConversationJson | undefined
}

/** One changed tool entry requiring presentation resolution. */
export interface MayflyToolPresentationInput extends MayflyHostSessionRequest {
  readonly callId: string
  readonly updatedSeq: number
  readonly name: string
  readonly arguments: string
  readonly result?: MayflyToolResultInput | undefined
}

/** Incremental presentation request; unchanged Transcript entries are omitted. */
export interface MayflyPresentToolsRequest {
  readonly entries: readonly MayflyToolPresentationInput[]
}

type JsonCallView<View> = View extends { readonly rawInput?: unknown }
  ? Omit<View, 'rawInput'> & { readonly rawInput?: ConversationJson | undefined }
  : View

/** Native call presentation with arbitrary presenter input constrained to lossless JSON. */
export type MayflyToolCallView = JsonCallView<ToolCallView>

/** JSON-safe presenter output for one tool entry; absent views use the generic card. */
export interface MayflyToolPresentation {
  readonly updatedSeq: number
  readonly call?: MayflyToolCallView | undefined
  readonly result?: ToolResultView | undefined
}

/** Presenter results keyed by Session identity, then tool Call identity. */
export type MayflyToolPresentationMap = Readonly<Record<string, Readonly<Record<string, MayflyToolPresentation>>>>

/** Batch response containing every requested entry. */
export interface MayflyPresentToolsResponse {
  readonly presentations: MayflyToolPresentationMap
}

/** Known working-tree facts behind the Git badge. */
export interface MayflyGitTreeStatus {
  readonly branch: string
  readonly dirty: boolean
  readonly ahead: number
  readonly behind: number
  readonly diffAdded: number
  readonly diffDeleted: number
}

/** Branch known but working-tree status unknown after a failed probe. */
export interface MayflyGitUnknownStatus {
  readonly branch: string
  readonly unknown: true
}

/** Current Host working-copy state; `null` means no repository or a failed branch probe. */
export type MayflyGitStatus = MayflyGitTreeStatus | MayflyGitUnknownStatus

/** Public connection facts available without reading raw MCP configuration. */
export interface MayflyMcpServerConfig {
  /** `null` means the native public catalog does not resolve the transport. */
  readonly transport: 'stdio' | 'streamable-http' | null
  /** `null` means the native public catalog does not resolve the endpoint. */
  readonly endpoint: string | null
}

/** Model-facing tool schema with lossless-JSON parameters and no callbacks. */
export type MayflyToolSchema = Omit<ToolSchema, 'parameters'> & {
  readonly parameters: Readonly<Record<string, ConversationJson>>
}

/** Derived MCP server status; it does not claim transport health. */
export type MayflyMcpStatus = 'synced' | 'restricted' | 'no-tools'

/** One server discovered through its registered tool namespace. */
export interface MayflyMcpServer {
  readonly entryId: string
  readonly serverName: string
  readonly status: MayflyMcpStatus
  readonly registeredCount: number
  readonly toolsVisible: readonly MayflyToolSchema[]
  readonly config: MayflyMcpServerConfig
}

/** Construction-frozen MCP tool catalog for the current panel. */
export interface MayflyMcpCatalog {
  readonly servers: readonly MayflyMcpServer[]
  readonly orphanCount: number
  readonly sessionLive: true
}

/** Construction-frozen session-visible tool schemas. */
export interface MayflyToolCatalog {
  readonly tools: readonly MayflyToolSchema[]
}

/** One workflow child call and its outcome, addressed by its child Session. */
export interface MayflyWorkflowAgent {
  readonly seq: number
  readonly label: string
  readonly phase?: string | undefined
  readonly childId: SessionId
  readonly outcome?: WorkflowAgentOutcome | undefined
  /** The Session lifecycle ended before this member settled. */
  readonly interrupted?: true | undefined
}

/** One top-level workflow run attributed to the followed parent Session. */
export interface MayflyWorkflowRun {
  readonly id: string
  readonly name: string
  readonly phases?: readonly WorkflowPhase[] | undefined
  readonly phasesSeen: readonly string[]
  readonly currentPhase?: string | undefined
  readonly agents: readonly MayflyWorkflowAgent[]
  readonly startedAt: number
  readonly stopReason?: WorkflowStopReason | undefined
  readonly endedAt?: number | undefined
  readonly agentsStarted?: number | undefined
  /** The Session lifecycle ended before this run settled; `stopReason` remains absent. */
  readonly interrupted?: true | undefined
}

/** Complete Workflow state for one parent Session. */
export interface MayflyWorkflowSnapshot {
  readonly sessionId: SessionId
  readonly runs: readonly MayflyWorkflowRun[]
}

/** Opening baseline or atomic replacement of the complete Workflow snapshot. */
export type MayflyWorkflowFrame =
  | { readonly type: 'baseline'; readonly value: MayflyWorkflowSnapshot }
  | { readonly type: 'replacement'; readonly value: MayflyWorkflowSnapshot }
