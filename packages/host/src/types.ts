/**
 * Client-safe DTOs and Remote errors for the Mayfly Host capability.
 *
 * @module @ephemeral-ai/mayfly-host/types
 */

import type { ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm/types'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials/types'
import type { AuthorizationNotice } from '@deepseek-ai/dsh-authorization/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionProjectionSummaryExcluded } from '@deepseek-ai/dsh-session-projection/types'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools/presentation'
import type { TypertResource } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceChangesSummary, WorkspaceFileDiff } from '@deepseek-ai/dsh-workspace-changes/types'
import type { WorkflowAgentOutcome, WorkflowPhase, WorkflowStopReason } from '@deepseek-ai/dsh-workflow/types'
import type { ConversationJson } from './conversation/types.ts'

export type * from './conversation/types.ts'
export type * from './remote/stats-contract.ts'
export type * from './remote/trace-contract.ts'

/** Settled native Job rows; current resident rows still come from job.list. */
export interface MayflyJobHistoryEntry {
  readonly id: string
  readonly owner: string
  readonly kind: string
  readonly label: string
  readonly startedAt: number
  readonly finishedAt: number
  readonly status: 'completed' | 'killed' | 'failed'
  readonly detail?: string | undefined
  readonly output: { readonly total: 0, readonly earliest: 0 }
}

/** Whole immutable history snapshot; wire identities are serialized native brands. */
export type MayflyJobHistory = readonly MayflyJobHistoryEntry[]

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Durable history only: unfinished registrations never become invented live jobs. */
    mayflyJobs: SessionProjectionSummaryExcluded<MayflyJobHistory>
  }
}

/** Mayfly Host features advertised by the capabilities handshake. */
export type MayflyHostFeature =
  | 'mayflyConversation'
  | 'presentTools'
  | 'followWorkflow'
  | 'gitStatus'
  | 'mcpCatalog'
  | 'toolCatalog'
  | 'mayflySettings'
  | 'skillCatalog'
  | 'retractTurn'
  | 'modelCatalogDetails'
  | 'defaultModel'
  | 'authorization'
  | 'permissionCatalogDetails'
  | 'providerBalance'
  | 'settingsDocument'
  | 'subagentDrain'
  | 'workspaceChanges'
  | 'workspacePath'
  | 'mcpResources'
  | 'mcpTransportHealth'
  | 'stats'
  | 'trace'
  | 'deliveredFiles'
  | 'btwFork'

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

/** Capture the source's complete current tail unless an exact inclusive cut is supplied. */
export interface MayflyBtwForkRequest extends MayflyHostSessionRequest {
  readonly atSeq?: number
  readonly allowMigration?: boolean
}

/** Native ordinary child identity and its exact inherited prefix; an empty source has no floor. */
export interface MayflyBtwForkValue {
  readonly sessionId: SessionId
  readonly historyFloorSeq?: number
}

/** Mayfly Host domain failures carried by the standard Remote error union. */
export type MayflyHostErrorCode =
  | 'mayflyHost/capability-unavailable'
  | 'mayflyHost/agent-unavailable'
  | 'mayflyHost/session-stale'
  | 'mayflyHost/session-directory-unavailable'
  | 'mayflyHost/authorization-unavailable'
  | 'mayflyHost/authorization-in-flight'
  | 'mayflyHost/authorization-failed'
  | 'mayflyHost/settings-conflict'
  | 'mayflyHost/settings-read-only'
  | 'mayflyHost/settings-document-unavailable'
  | 'mayflyHost/subagent-drain-unavailable'
  | 'mayflyHost/subagent-drain-unauthorized'
  | 'mayflyHost/mcp-resource-failed'
  | 'mayflyHost/delivery-unavailable'

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
    /** No native authorization flow or requested method exists for this key. */
    'mayflyHost/authorization-unavailable': { readonly key: string }
    /** This credential already has an active authorization operation. */
    'mayflyHost/authorization-in-flight': { readonly key: string }
    /** The native authorization flow failed without a public outcome. */
    'mayflyHost/authorization-failed': { readonly key: string }
    /** The settings document changed since the caller's content revision. */
    'mayflyHost/settings-conflict': { readonly expectedRevision: string, readonly actualRevision: string }
    /** The settings document is not writable. */
    'mayflyHost/settings-read-only': Record<string, never>
    /** The settings document could not be read or prepared. */
    'mayflyHost/settings-document-unavailable': Record<string, never>
    /** A requested subagent drain failed its current native catalog/liveness guards. */
    'mayflyHost/subagent-drain-unavailable': { readonly childId: string, readonly reason: string }
    /** The exact direct parent no longer owns the resident child activation. */
    'mayflyHost/subagent-drain-unauthorized': { readonly childId: string }
    /** A requested delivery is absent from the exact Session's recorded projection. */
    'mayflyHost/delivery-unavailable': MayflyDeliveredFileRequest
    /** A native MCP resource operation returned an error result. */
    'mayflyHost/mcp-resource-failed': { readonly server: string, readonly message: string }
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

/** Tool availability is unknown until a configured server is connected. */
export type MayflyMcpStatus = 'synced' | 'restricted' | 'no-tools' | 'unknown'

/** One server discovered through its registered tool namespace. */
export interface MayflyMcpServer {
  readonly entryId: string
  readonly serverName: string
  readonly status: MayflyMcpStatus
  readonly registeredCount: number
  readonly toolsVisible: readonly MayflyToolSchema[]
  readonly config: MayflyMcpServerConfig
  /** Sanitized native connection phase; absent when the Host cannot resolve transport health. */
  readonly connection?: 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | undefined
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

/** Exact running human message retraction request. */
export interface MayflyRetractTurnRequest extends MayflyHostSessionRequest {
  readonly messageId: string
}

/** One user-invocable skill with the source/provider detail current panels display. */
export interface MayflySkillSummary {
  readonly path?: string | undefined
  readonly name: string
  readonly description: string
  readonly whenToUse?: string | undefined
  readonly source: string
  readonly provider: string
  readonly modelInvocable: boolean
}

/** One complete skill discovery observation. */
export interface MayflySkillCatalog {
  readonly skills: readonly MayflySkillSummary[]
  readonly complete: boolean
}

/** One picker row with exact adapter-owned context and reasoning metadata. */
export interface MayflyModelCatalogItem {
  readonly provider: string
  readonly id: string
  readonly name: string
  readonly providerLabel: string
  readonly contextWindow?: number | undefined
  readonly efforts?: readonly string[] | undefined
  readonly defaultEffort?: string | undefined
}

/** Optional provider filter for model detail discovery. */
export interface MayflyModelCatalogRequest {
  readonly provider?: string | undefined
}

/** Provider rows whose listings loaded, with failures omitted as advisory catalogs permit. */
export interface MayflyModelCatalogDetails {
  readonly items: readonly MayflyModelCatalogItem[]
}

/** Provider/model/reasoning selection independent of a Session. */
export interface MayflyModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string | undefined
}

/** Read the saved default or replace it through the native default-model owner. */
export type MayflyDefaultModelRequest =
  | { readonly operation: 'read' }
  | ({ readonly operation: 'select' } & MayflyModelSelection)

/** One credential authorization attempt. */
export interface MayflyAuthorizationRequest {
  readonly key: CredentialKey
  readonly method?: string | undefined
}

/** Presentation-safe prompt data with native AbortSignals removed. */
export type MayflyAuthorizationPrompt =
  | { readonly kind: 'text' | 'secret', readonly message: string, readonly placeholder?: string | undefined }
  | {
    readonly kind: 'select'
    readonly message: string
    readonly options: readonly { readonly id: string, readonly label: string, readonly description?: string | undefined }[]
  }

/** Structured authorization operation events. */
export type MayflyAuthorizationFrame =
  | { readonly type: 'started', readonly operationId: string }
  | { readonly type: 'notice', readonly operationId: string, readonly notice: AuthorizationNotice }
  | { readonly type: 'prompt', readonly operationId: string, readonly promptId: string, readonly prompt: MayflyAuthorizationPrompt }
  | { readonly type: 'prompt-ended', readonly operationId: string, readonly promptId: string }
  | { readonly type: 'settled', readonly operationId: string, readonly status: 'authorized' | 'cancelled' }

/** Client answers addressed to one exact operation and prompt. */
export type MayflyAuthorizationAnswer =
  | { readonly type: 'answer', readonly operationId: string, readonly promptId: string, readonly value: string }
  | { readonly type: 'decline', readonly operationId: string, readonly promptId: string }

/** Native knob bundle behind one selectable permission row. */
export interface MayflyPermissionSpec {
  readonly sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'
  readonly approval: 'ask' | 'never'
}

/** Permission rows and their resolved bundles, plus yolo state for an optional current value. */
export interface MayflyPermissionCatalogDetails {
  readonly options: readonly { readonly value: string, readonly name: string, readonly description?: string | undefined }[]
  readonly defaultOptions: readonly { readonly value: string, readonly name: string, readonly description?: string | undefined }[]
  readonly defaultPreset: string
  readonly specs: Readonly<Record<string, MayflyPermissionSpec>>
  readonly yolo: boolean
}

/** Optional current-preset input for yolo evaluation. */
export interface MayflyPermissionCatalogRequest {
  readonly currentPreset?: string | undefined
}

/** One API wallet, preserving decimal strings exactly as the provider returned them. */
export interface MayflyWallet {
  readonly currency: 'CNY' | 'USD'
  readonly total: string
  readonly toppedUp?: string | undefined
  readonly granted?: string | undefined
}

/** Balance of the official API-key route, without its credential or endpoint internals. */
export type MayflyProviderBalance =
  | { readonly status: 'ready', readonly wallets: readonly MayflyWallet[], readonly available?: boolean | undefined }
  | { readonly status: 'unavailable', readonly reason: 'network' | 'rejected' | 'no-key' }

/** Raw settings text and its SHA-256 content revision. */
export interface MayflySettingsDocument {
  readonly writable: boolean
  readonly content: string
  readonly revision: string
}

/** Compare-and-write input for the actual settings document. */
export interface MayflySettingsDocumentWrite {
  readonly content: string
  readonly expectedRevision: string
}

/** Exact direct-parent child drain request. */
export interface MayflySubagentDrainRequest {
  readonly parentSessionId: SessionId
  readonly childSessionId: SessionId
}

/** One recorded per-turn summary identity. */
export interface MayflyWorkspaceChangesRequest extends MayflyHostSessionRequest {
  readonly seq: number
}

/** One changed-file comparison identity within that summary. */
export interface MayflyWorkspaceDiffRequest extends MayflyWorkspaceChangesRequest {
  readonly index: number
}

/** Native summary values are returned directly; `null` replaces an unavailable record. */
export type MayflyWorkspaceChangesSummaryResult = WorkspaceChangesSummary | null
/** Native diff values are returned directly; `null` replaces an unavailable record. */
export type MayflyWorkspaceFileDiffResult = WorkspaceFileDiff | null

/** Canonical existing-workspace lookup by path, without creation or mutation. */
export interface MayflyWorkspacePathRequest {
  readonly path: string
}

/** Client-safe workspace identity used by placement code. */
export interface MayflyWorkspace {
  readonly id: string
  readonly path: string
  readonly title: string
}

/** Page of resources or resource templates from one exact Agent's MCP scope. */
export interface MayflyMcpResourceListRequest extends MayflyHostSessionRequest {
  readonly server: string
  readonly kind: 'resources' | 'templates'
  readonly cursor?: string | undefined
}

/** JSON-safe MCP metadata row with provider-specific fields preserved. */
export type MayflyMcpResourceItem = Readonly<Record<string, ConversationJson>>

/** One resource/template page and its server-owned continuation cursor. */
export interface MayflyMcpResourcePage {
  readonly items: readonly MayflyMcpResourceItem[]
  readonly cursor?: string | undefined
}

/** Explicit resource body read from one exact Agent's MCP scope. */
export interface MayflyMcpResourceReadRequest extends MayflyHostSessionRequest {
  readonly server: string
  readonly uri: string
}

/** Text and binary summaries; raw binary bytes never cross Remote. */
export interface MayflyMcpResourceBody {
  readonly text: string
}

/** Read only a recorded delivery identity; callers cannot supply arbitrary paths. */
export interface MayflyDeliveredFileRequest extends MayflyHostSessionRequest {
  readonly deliveryId: string
  readonly preview?: boolean
}

/** Host-native filesystem facts and an optional bounded text preview. */
export interface MayflyDeliveredFileDetail {
  readonly path: string
  readonly displayPath: string
  readonly fileType?: 'file' | 'directory' | 'other'
  readonly size?: number
  readonly preview?: string
}

/** Latest native workspace comparison retained by a resident Session. */
export interface MayflyLatestWorkspaceChanges {
  readonly seq: number
  readonly summary: WorkspaceChangesSummary
}
