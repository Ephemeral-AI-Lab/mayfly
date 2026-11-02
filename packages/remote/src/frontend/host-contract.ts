/**
 * Client-safe Host DTOs and the generated Mayfly namespace consumer.
 * The Host package owns all wire data definitions.
 * @module @ephemeral-ai/mayfly/frontend/host-contract
 */
import type * as Host from '@ephemeral-ai/mayfly-host/types'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol'

export type * from '@ephemeral-ai/mayfly-host/types'

/** Generated mayflyHost methods consumed by Domain. */
export interface MayflyHostRemote {
  deliveredFile(request: Host.MayflyDeliveredFileRequest, signal?: AbortSignal): Promise<RemoteResult<Host.MayflyDeliveredFileDetail>>
  latestWorkspaceChanges(request: Host.MayflyHostSessionRequest, signal?: AbortSignal): Promise<RemoteResult<Host.MayflyLatestWorkspaceChanges | null>>
  traceCatalog(request: Host.MayflyTraceCatalogRequest, signal?: AbortSignal): Promise<RemoteResult<readonly Host.MayflyTraceItem[]>>
  traceDetail(request: Host.MayflyTraceDetailRequest, signal?: AbortSignal): Promise<RemoteResult<Host.MayflyTraceDetail>>
  statsSession(request: Host.MayflyHostSessionRequest, signal?: AbortSignal): Promise<RemoteResult<Host.MayflyStatsSession>>
  statsHistory(request: Host.MayflyStatsHistoryRequest, signal?: AbortSignal): RemoteStreamHandle<Host.MayflyStatsHistory, never>
  capabilities(): Promise<RemoteResult<Host.MayflyHostCapabilities>>
  presentTools(request: Host.MayflyPresentToolsRequest, signal?: AbortSignal): Promise<RemoteResult<Host.MayflyPresentToolsResponse>>
  followWorkflow(request: Host.MayflyHostSessionRequest, signal?: AbortSignal): AsyncIterable<Host.MayflyWorkflowFrame>
  gitStatus(request: Host.MayflyHostSessionRequest, signal?: AbortSignal): Promise<RemoteResult<Host.MayflyGitStatus | null>>
  retractTurn(request: Host.MayflyRetractTurnRequest, signal?: AbortSignal): Promise<RemoteResult<boolean>>
  skillCatalog(request: Host.MayflyHostSessionRequest, signal?: AbortSignal): Promise<RemoteResult<Host.MayflySkillCatalog>>
  modelCatalogDetails(request: Host.MayflyModelCatalogRequest, signal?: AbortSignal): Promise<RemoteResult<Host.MayflyModelCatalogDetails>>
  defaultModel(request: Host.MayflyDefaultModelRequest, signal?: AbortSignal): Promise<RemoteResult<Host.MayflyModelSelection>>
  subagentDrain(request: Host.MayflySubagentDrainRequest, signal?: AbortSignal): Promise<RemoteResult<void>>
  workspaceChangesSummary(request: Host.MayflyWorkspaceChangesRequest, signal?: AbortSignal): Promise<RemoteResult<Host.MayflyWorkspaceChangesSummaryResult>>
  workspaceChangesDiff(request: Host.MayflyWorkspaceDiffRequest, signal?: AbortSignal): Promise<RemoteResult<Host.MayflyWorkspaceFileDiffResult>>
  workspacePath(request: Host.MayflyWorkspacePathRequest, signal?: AbortSignal): Promise<RemoteResult<Host.MayflyWorkspace | null>>
  toolCatalog(request: Host.MayflyHostSessionRequest, signal?: AbortSignal): Promise<RemoteResult<Host.MayflyToolCatalog>>
  mcpCatalog(request: Host.MayflyHostSessionRequest, signal?: AbortSignal): Promise<RemoteResult<Host.MayflyMcpCatalog>>
  listMcpResources(request: Host.MayflyMcpResourceListRequest, signal?: AbortSignal): Promise<RemoteResult<Host.MayflyMcpResourcePage>>
  readMcpResource(request: Host.MayflyMcpResourceReadRequest, signal?: AbortSignal): Promise<RemoteResult<Host.MayflyMcpResourceBody>>
  authorize(request: Host.MayflyAuthorizationRequest, signal?: AbortSignal): RemoteStreamHandle<Host.MayflyAuthorizationFrame, Host.MayflyAuthorizationAnswer>
  cancelAuthorization(request: Host.MayflyAuthorizationRequest, signal?: AbortSignal): Promise<RemoteResult<void>>
  permissionCatalogDetails(request: Host.MayflyPermissionCatalogRequest, signal?: AbortSignal): Promise<RemoteResult<Host.MayflyPermissionCatalogDetails>>
  providerBalance(signal?: AbortSignal): Promise<RemoteResult<Host.MayflyProviderBalance>>
  readSettingsDocument(signal?: AbortSignal): Promise<RemoteResult<Host.MayflySettingsDocument>>
  writeSettingsDocument(request: Host.MayflySettingsDocumentWrite, signal?: AbortSignal): Promise<RemoteResult<Host.MayflySettingsDocument>>
}

/** Discriminated views of the authoritative workflow wire frame. */
export type MayflyWorkflowBaselineFrame = Extract<Host.MayflyWorkflowFrame, { readonly type: 'baseline' }>
export type MayflyWorkflowReplacementFrame = Extract<Host.MayflyWorkflowFrame, { readonly type: 'replacement' }>

/** Consumer views derived from authoritative Host result payloads. */
export type MayflyAuthorizationNotice = Extract<Host.MayflyAuthorizationFrame, { readonly type: 'notice' }>['notice']
export type MayflyWorkspaceChangesSummary = NonNullable<Host.MayflyWorkspaceChangesSummaryResult>
export type MayflyWorkspaceFileDiff = NonNullable<Host.MayflyWorkspaceFileDiffResult>
