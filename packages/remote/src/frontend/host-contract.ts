/**
 * Narrow Client consumer types for the generated mayflyHost namespace.
 * These mirror the inspectable Host DTOs without importing the unpublished Host package.
 * @module @ephemeral-ai/mayfly/frontend/host-contract
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConversationJson } from '@ephemeral-ai/mayfly/conversation'
import type { ToolPresentationFacts } from '@ephemeral-ai/mayfly/transcript'

export interface MayflyHostSessionRequest { readonly sessionId: SessionId }
export type MayflyHostFeature =
  | 'mayflyConversation' | 'presentTools' | 'followWorkflow' | 'gitStatus' | 'mcpCatalog' | 'toolCatalog'
  | 'mayflySettings' | 'skillCatalog' | 'retractTurn' | 'modelCatalogDetails' | 'defaultModel'
  | 'authorization' | 'permissionCatalogDetails' | 'providerBalance' | 'settingsDocument'
  | 'subagentDrain' | 'workspaceChanges' | 'workspacePath' | 'mcpResources'
export interface MayflyHostCapabilities {
  readonly protocolVersion: number
  readonly hostVersion: string
  readonly requiredDshVersion: string
  readonly features: readonly MayflyHostFeature[]
}

export interface MayflyToolResultInput {
  readonly content: readonly ContentBlock[]
  readonly isError: boolean
  readonly meta?: ConversationJson | undefined
}
export interface MayflyToolPresentationInput extends MayflyHostSessionRequest {
  readonly callId: string
  readonly updatedSeq: number
  readonly name: string
  readonly arguments: string
  readonly result?: MayflyToolResultInput | undefined
}
export interface MayflyPresentToolsRequest { readonly entries: readonly MayflyToolPresentationInput[] }
type JsonCallView<View> = View extends { readonly rawInput?: unknown }
  ? Omit<View, 'rawInput'> & { readonly rawInput?: ConversationJson | undefined }
  : View
export type MayflyToolCallView = JsonCallView<NonNullable<ToolPresentationFacts['call']>>
export interface MayflyToolPresentation {
  readonly updatedSeq: number
  readonly call?: MayflyToolCallView
  readonly result?: ToolPresentationFacts['result']
}
export type MayflyToolPresentationMap = Readonly<Record<string, Readonly<Record<string, MayflyToolPresentation>>>>
export interface MayflyPresentToolsResponse { readonly presentations: MayflyToolPresentationMap }

export type MayflyGitStatus =
  | { readonly branch: string, readonly dirty: boolean, readonly ahead: number, readonly behind: number, readonly diffAdded: number, readonly diffDeleted: number }
  | { readonly branch: string, readonly unknown: true }

export type WorkflowAgentOutcome = 'completed' | 'failed' | 'cancelled'
export type WorkflowStopReason = 'completed' | 'cancelled' | 'error'
export interface MayflyWorkflowPhase {
  readonly title: string
  readonly detail?: string | undefined
  readonly provider?: string | undefined
  readonly model?: string | undefined
}
export interface MayflyWorkflowAgent {
  readonly seq: number
  readonly label: string
  readonly phase?: string | undefined
  readonly childId: SessionId
  readonly outcome?: WorkflowAgentOutcome | undefined
  readonly interrupted?: true | undefined
}
export interface MayflyWorkflowRun {
  readonly id: string
  readonly name: string
  readonly phases?: readonly MayflyWorkflowPhase[] | undefined
  readonly phasesSeen: readonly string[]
  readonly currentPhase?: string | undefined
  readonly agents: readonly MayflyWorkflowAgent[]
  readonly startedAt: number
  readonly stopReason?: WorkflowStopReason | undefined
  readonly endedAt?: number | undefined
  readonly agentsStarted?: number | undefined
  readonly interrupted?: true | undefined
}
export interface MayflyWorkflowSnapshot {
  readonly sessionId: SessionId
  readonly runs: readonly MayflyWorkflowRun[]
}
export type MayflyWorkflowBaselineFrame = { readonly type: 'baseline', readonly value: MayflyWorkflowSnapshot }
export type MayflyWorkflowReplacementFrame = { readonly type: 'replacement', readonly value: MayflyWorkflowSnapshot }
export type MayflyWorkflowFrame = MayflyWorkflowBaselineFrame | MayflyWorkflowReplacementFrame

export interface MayflyRetractTurnRequest extends MayflyHostSessionRequest { readonly messageId: string }
export interface MayflySubagentDrainRequest {
  readonly parentSessionId: SessionId
  readonly childSessionId: SessionId
}

export interface MayflySkillSummary {
  readonly path?: string | undefined
  readonly name: string
  readonly description: string
  readonly whenToUse?: string | undefined
  readonly source: string
  readonly provider: string
  readonly modelInvocable: boolean
}
export interface MayflySkillCatalog {
  readonly skills: readonly MayflySkillSummary[]
  readonly complete: boolean
}
export interface MayflyModelCatalogItem {
  readonly provider: string
  readonly id: string
  readonly name: string
  readonly providerLabel: string
  readonly contextWindow?: number | undefined
  readonly efforts?: readonly string[] | undefined
  readonly defaultEffort?: string | undefined
}
export interface MayflyModelCatalogRequest { readonly provider?: string | undefined }
export interface MayflyModelCatalogDetails { readonly items: readonly MayflyModelCatalogItem[] }
export interface MayflyModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string | undefined
}
export type MayflyDefaultModelRequest =
  | { readonly operation: 'read' }
  | ({ readonly operation: 'select' } & MayflyModelSelection)

export interface MayflyWorkspaceChangedFile {
  readonly path: string
  readonly display: string
  readonly added: number
  readonly deleted: number
  readonly binary?: true | undefined
  readonly oversized?: true | undefined
}
export interface MayflyWorkspaceChangesSummary {
  readonly turn: number
  readonly cwd: string
  readonly files: readonly MayflyWorkspaceChangedFile[]
  readonly total: number
  readonly added: number
  readonly deleted: number
  readonly snapshot?: { readonly before: string, readonly after: string } | undefined
}
export interface MayflyWorkspaceDiffHunk {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  readonly lines: readonly string[]
}
export type MayflyWorkspaceFileDiff =
  | {
    readonly kind: 'text'
    readonly path: string
    readonly display: string
    readonly before: boolean
    readonly after: boolean
    readonly hunks: readonly MayflyWorkspaceDiffHunk[]
    readonly coarse: boolean
  }
  | { readonly kind: 'binary' | 'oversized', readonly path: string, readonly display: string }
export interface MayflyWorkspaceChangesRequest extends MayflyHostSessionRequest { readonly seq: number }
export interface MayflyWorkspaceDiffRequest extends MayflyWorkspaceChangesRequest { readonly index: number }
export type MayflyWorkspaceChangesSummaryResult = MayflyWorkspaceChangesSummary | null
export type MayflyWorkspaceFileDiffResult = MayflyWorkspaceFileDiff | null
export interface MayflyWorkspacePathRequest { readonly path: string }
export interface MayflyWorkspace {
  readonly id: string
  readonly path: string
  readonly title: string
}

export interface MayflyToolSchema {
  readonly deferLoading?: true | undefined
  readonly name: string
  readonly description: string
  readonly parameters: Readonly<Record<string, ConversationJson>>
}
export interface MayflyToolCatalog { readonly tools: readonly MayflyToolSchema[] }
export interface MayflyMcpServerConfig {
  readonly transport: 'stdio' | 'streamable-http' | null
  readonly endpoint: string | null
}
export interface MayflyMcpServer {
  readonly entryId: string
  readonly serverName: string
  readonly status: 'synced' | 'restricted' | 'no-tools'
  readonly registeredCount: number
  readonly toolsVisible: readonly MayflyToolSchema[]
  readonly config: MayflyMcpServerConfig
}
export interface MayflyMcpCatalog {
  readonly servers: readonly MayflyMcpServer[]
  readonly orphanCount: number
  readonly sessionLive: true
}

/** Generated mayflyHost methods consumed by Domain. */
export interface MayflyHostRemote {
  capabilities(): Promise<RemoteResult<MayflyHostCapabilities>>
  presentTools(request: MayflyPresentToolsRequest, signal?: AbortSignal): Promise<RemoteResult<MayflyPresentToolsResponse>>
  followWorkflow(request: MayflyHostSessionRequest, signal?: AbortSignal): AsyncIterable<MayflyWorkflowFrame>
  gitStatus(request: MayflyHostSessionRequest, signal?: AbortSignal): Promise<RemoteResult<MayflyGitStatus | null>>
  retractTurn(request: MayflyRetractTurnRequest, signal?: AbortSignal): Promise<RemoteResult<boolean>>
  skillCatalog(request: MayflyHostSessionRequest, signal?: AbortSignal): Promise<RemoteResult<MayflySkillCatalog>>
  modelCatalogDetails(request: MayflyModelCatalogRequest, signal?: AbortSignal): Promise<RemoteResult<MayflyModelCatalogDetails>>
  defaultModel(request: MayflyDefaultModelRequest, signal?: AbortSignal): Promise<RemoteResult<MayflyModelSelection>>
  subagentDrain(request: MayflySubagentDrainRequest, signal?: AbortSignal): Promise<RemoteResult<void>>
  workspaceChangesSummary(request: MayflyWorkspaceChangesRequest, signal?: AbortSignal): Promise<RemoteResult<MayflyWorkspaceChangesSummaryResult>>
  workspaceChangesDiff(request: MayflyWorkspaceDiffRequest, signal?: AbortSignal): Promise<RemoteResult<MayflyWorkspaceFileDiffResult>>
  workspacePath(request: MayflyWorkspacePathRequest, signal?: AbortSignal): Promise<RemoteResult<MayflyWorkspace | null>>
  toolCatalog(request: MayflyHostSessionRequest, signal?: AbortSignal): Promise<RemoteResult<MayflyToolCatalog>>
  mcpCatalog(request: MayflyHostSessionRequest, signal?: AbortSignal): Promise<RemoteResult<MayflyMcpCatalog>>
}
