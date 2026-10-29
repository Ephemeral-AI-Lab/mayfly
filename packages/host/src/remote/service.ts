/**
 * Mayfly-specific Host Remote service. Standard Harness capabilities remain
 * owned by their native Remote services.
 *
 * @module @ephemeral-ai/mayfly-host/remote/service
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session/types'
import { Remote, RemoteError, TypertRemoteService, type RemoteStream } from '@deepseek-ai/dsh-typert-protocol'
import type {} from 'zod'
import { MAYFLY_HOST_CAPABILITIES } from './capabilities.ts'
import type { MayflyAuthorizationAnswer, MayflyAuthorizationFrame, MayflyAuthorizationRequest, MayflyDefaultModelRequest, MayflyGitStatus, MayflyHostCapabilities, MayflyHostSessionRequest, MayflyMcpCatalog, MayflyMcpResourceBody, MayflyMcpResourceListRequest, MayflyMcpResourcePage, MayflyMcpResourceReadRequest, MayflyModelCatalogDetails, MayflyModelCatalogRequest, MayflyModelSelection, MayflyPermissionCatalogDetails, MayflyPermissionCatalogRequest, MayflyPresentToolsRequest, MayflyPresentToolsResponse, MayflyProviderBalance, MayflyRetractTurnRequest, MayflySettingsDocument, MayflySettingsDocumentWrite, MayflySkillCatalog, MayflySubagentDrainRequest, MayflyToolCatalog, MayflyWorkspace, MayflyWorkspaceChangesRequest, MayflyWorkspaceChangesSummaryResult, MayflyWorkspaceDiffRequest, MayflyWorkspaceFileDiffResult, MayflyWorkspacePathRequest, MayflyWorkflowFrame } from '../types.ts'
import { authorize, cancelAuthorization } from './authorization.ts'
import { providerBalance } from './balance.ts'
import { mcpCatalog, toolCatalog } from './catalog.ts'
import { defaultModel, modelCatalogDetails, permissionCatalogDetails, skillCatalog } from './catalog-details.ts'
import { createGitBadgeCache, type GitBadgeCache } from './git.ts'
import { listMcpResources, readMcpResource } from './mcp-resources.ts'
import { presentTools } from './presentation.ts'
import { RetractionCoordinator, retractTurn } from './retraction.ts'
import { readSettingsDocument, writeSettingsDocument } from './settings-document.ts'
import { requireExactAgent, resolveExactAgent, sessionDirectory } from './session.ts'
import { subagentDrain } from './subagent.ts'
import { followWorkflow, WorkflowLiveCatalog } from './workflow.ts'
import { workspaceChangesDiff, workspaceChangesSummary, workspacePath } from './workspace.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Mayfly Host version and feature handshake. */
    mayflyHost: MayflyHostService
  }
}

/** Host service backing the generated `ctx.remote.mayflyHost` namespace. */
export class MayflyHostService extends TypertRemoteService {
  static inject = [
    'agentDefaultModel', 'agents', 'authorization', 'credentials', 'llm', 'permissionPresets',
    'sessionController', 'sessionProjections', 'sessions', 'settings', 'skills', 'subagents',
    'tools', 'workspaceChanges', 'workspaceRegistry',
  ]

  private readonly lifetime: AbortController
  private readonly workflows: WorkflowLiveCatalog
  private readonly retractions: RetractionCoordinator
  private readonly gitCaches = new WeakMap<Agent, { readonly cwd: string, readonly cache: GitBadgeCache }>()

  /** @param ctx - owning Host context. */
  constructor(ctx: Context) {
    super(ctx, 'mayflyHost')
    this.lifetime = new AbortController()
    ctx.effect(() => () => { this.lifetime.abort() })
    this.workflows = new WorkflowLiveCatalog(ctx)
    this.retractions = new RetractionCoordinator(ctx)
  }

  private signal(signal: AbortSignal): AbortSignal {
    return AbortSignal.any([this.lifetime.signal, signal])
  }

  /**
   * Return the protocol, package, dsh versions, and implemented feature keys.
   * @returns the immutable capabilities implemented by this Host package.
   */
  @Remote('capabilities')
  capabilities(): MayflyHostCapabilities {
    return MAYFLY_HOST_CAPABILITIES
  }

  /** Present changed tool entries through each authorized exact Agent's native definitions. */
  @Remote({ resources: { session: request => request.entries.length === 0 ? undefined : [...new Set(request.entries.map(entry => entry.sessionId))] } })
  presentTools(request: MayflyPresentToolsRequest, signal: AbortSignal): Promise<MayflyPresentToolsResponse> {
    return presentTools(this.ctx, request, this.signal(signal))
  }

  /** Follow complete Workflow state with one baseline and replacement frames until cancellation or Agent loss. */
  @Remote({ mode: 'stream', resources: { session: request => request.sessionId } })
  followWorkflow(request: MayflyHostSessionRequest, signal: AbortSignal): RemoteStream<MayflyWorkflowFrame> {
    return followWorkflow(this.ctx, this.workflows, request.sessionId, this.signal(signal))
  }

  /** Read the exact Session's Host working copy with independent TTL caches and bounded Git processes. */
  @Remote({ resources: { session: request => request.sessionId } })
  async gitStatus(request: MayflyHostSessionRequest, signal: AbortSignal): Promise<MayflyGitStatus | null> {
    const lifetime = this.signal(signal)
    const agent = await resolveExactAgent(this.ctx, request.sessionId, lifetime)
    const cwd = sessionDirectory(this.ctx, agent.session)
    let entry = this.gitCaches.get(agent)
    if (entry?.cwd !== cwd) {
      entry = { cwd, cache: createGitBadgeCache(cwd) }
      this.gitCaches.set(agent, entry)
    }
    const status = await entry.cache.getStatus(lifetime)
    requireExactAgent(this.ctx, request.sessionId, agent)
    if (sessionDirectory(this.ctx, agent.session) !== cwd) {
      throw new RemoteError('mayflyHost/session-stale', `session "${request.sessionId}" changed working directory during the Git probe`, { sessionId: request.sessionId })
    }
    return status
  }

  /** Read one construction-frozen, secret-free MCP catalog for the exact Session. */
  @Remote({ resources: { session: request => request.sessionId } })
  mcpCatalog(request: MayflyHostSessionRequest, signal: AbortSignal): Promise<MayflyMcpCatalog> {
    return mcpCatalog(this.ctx, request.sessionId, this.signal(signal))
  }

  /** Read one construction-frozen schema catalog for the exact Session. */
  @Remote({ resources: { session: request => request.sessionId } })
  toolCatalog(request: MayflyHostSessionRequest, signal: AbortSignal): Promise<MayflyToolCatalog> {
    return toolCatalog(this.ctx, request.sessionId, this.signal(signal))
  }

  /** List user-invocable skills with native source/provider details. */
  @Remote({ resources: { session: request => request.sessionId } })
  skillCatalog(request: MayflyHostSessionRequest, signal: AbortSignal): Promise<MayflySkillCatalog> {
    return skillCatalog(this.ctx, request.sessionId, this.signal(signal))
  }

  /** Retract only a matching running tool-free turn, then replace its surface after close. */
  @Remote({ resources: { session: request => request.sessionId } })
  retractTurn(request: MayflyRetractTurnRequest, signal: AbortSignal): Promise<boolean> {
    return retractTurn(this.ctx, this.retractions, request.sessionId, request.messageId, this.signal(signal))
  }

  /** Resolve model context windows and reasoning details through native adapters. */
  @Remote('modelCatalogDetails')
  modelCatalogDetails(request: MayflyModelCatalogRequest, signal: AbortSignal): Promise<MayflyModelCatalogDetails> {
    return modelCatalogDetails(this.ctx, request.provider, this.signal(signal))
  }

  /** Read or save the Session-independent default through agentDefaultModel. */
  @Remote('defaultModel')
  defaultModel(request: MayflyDefaultModelRequest, signal: AbortSignal): Promise<MayflyModelSelection> {
    return defaultModel(this.ctx, request, this.signal(signal))
  }

  /** Run native authorization as a structured operation stream with addressed uplink answers. */
  @Remote({ mode: 'stream' })
  authorize(request: MayflyAuthorizationRequest, signal: AbortSignal): RemoteStream<MayflyAuthorizationFrame, MayflyAuthorizationAnswer> {
    return authorize(this.ctx, request, this.signal(signal))
  }

  /** Cancel only the named credential's native authorization attempt. */
  @Remote('cancelAuthorization')
  cancelAuthorization(request: MayflyAuthorizationRequest, signal: AbortSignal): void {
    cancelAuthorization(this.ctx, request, this.signal(signal))
  }

  /** Resolve permission row bundles and optional current yolo state. */
  @Remote('permissionCatalogDetails')
  permissionCatalogDetails(request: MayflyPermissionCatalogRequest, signal: AbortSignal): MayflyPermissionCatalogDetails {
    return permissionCatalogDetails(this.ctx, request, this.signal(signal))
  }

  /** Read the official API-key balance entirely on Host. */
  @Remote('providerBalance')
  providerBalance(signal: AbortSignal): Promise<MayflyProviderBalance> {
    return providerBalance(this.ctx, this.signal(signal))
  }

  /** Read the actual settings document and its content revision. */
  @Remote('readSettingsDocument')
  readSettingsDocument(signal: AbortSignal): Promise<MayflySettingsDocument> {
    return readSettingsDocument(this.ctx, this.signal(signal))
  }

  /** Compare-and-write only the actual settings document. */
  @Remote('writeSettingsDocument')
  writeSettingsDocument(request: MayflySettingsDocumentWrite, signal: AbortSignal): Promise<MayflySettingsDocument> {
    return writeSettingsDocument(this.ctx, request, this.signal(signal))
  }

  /** Drain one continuable child through its exact direct parent. */
  @Remote({ resources: { session: request => [request.parentSessionId, request.childSessionId] } })
  subagentDrain(request: MayflySubagentDrainRequest, signal: AbortSignal): Promise<void> {
    return subagentDrain(this.ctx, request, this.signal(signal))
  }

  /** Read a native per-turn workspace change summary. */
  @Remote({ resources: { session: request => request.sessionId } })
  workspaceChangesSummary(request: MayflyWorkspaceChangesRequest, signal: AbortSignal): MayflyWorkspaceChangesSummaryResult {
    return workspaceChangesSummary(this.ctx, request, this.signal(signal))
  }

  /** Read a native per-turn file comparison with cancellation. */
  @Remote({ resources: { session: request => request.sessionId } })
  workspaceChangesDiff(request: MayflyWorkspaceDiffRequest, signal: AbortSignal): Promise<MayflyWorkspaceFileDiffResult> {
    return workspaceChangesDiff(this.ctx, request, this.signal(signal))
  }

  /** Resolve an existing workspace by canonical path without creating or mutating it. */
  @Remote('workspacePath')
  workspacePath(request: MayflyWorkspacePathRequest, signal: AbortSignal): Promise<MayflyWorkspace | null> {
    return workspacePath(this.ctx, request, this.signal(signal))
  }

  /** List resources/templates through fixed native MCP resource operations. */
  @Remote({ resources: { session: request => request.sessionId } })
  listMcpResources(request: MayflyMcpResourceListRequest, signal: AbortSignal): Promise<MayflyMcpResourcePage> {
    return listMcpResources(this.ctx, request, this.signal(signal))
  }

  /** Read one resource body through the fixed native operation, summarizing binary content. */
  @Remote({ resources: { session: request => request.sessionId } })
  readMcpResource(request: MayflyMcpResourceReadRequest, signal: AbortSignal): Promise<MayflyMcpResourceBody> {
    return readMcpResource(this.ctx, request, this.signal(signal))
  }
}

export default MayflyHostService
