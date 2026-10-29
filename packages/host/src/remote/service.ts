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
import type { MayflyGitStatus, MayflyHostCapabilities, MayflyHostSessionRequest, MayflyMcpCatalog, MayflyPresentToolsRequest, MayflyPresentToolsResponse, MayflyToolCatalog, MayflyWorkflowFrame } from '../types.ts'
import { MAYFLY_HOST_CAPABILITIES } from './capabilities.ts'
import { mcpCatalog, toolCatalog } from './catalog.ts'
import { createGitBadgeCache, type GitBadgeCache } from './git.ts'
import { presentTools } from './presentation.ts'
import { requireExactAgent, resolveExactAgent, sessionDirectory } from './session.ts'
import { followWorkflow, WorkflowLiveCatalog } from './workflow.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Mayfly Host version and feature handshake. */
    mayflyHost: MayflyHostService
  }
}

/** Host service backing the generated `ctx.remote.mayflyHost` namespace. */
export class MayflyHostService extends TypertRemoteService {
  static inject = ['agents', 'sessions', 'sessionController', 'sessionProjections', 'tools']

  private readonly lifetime: AbortController
  private readonly workflows: WorkflowLiveCatalog
  private readonly gitCaches = new WeakMap<Agent, { readonly cwd: string, readonly cache: GitBadgeCache }>()

  /** @param ctx - owning Host context. */
  constructor(ctx: Context) {
    super(ctx, 'mayflyHost')
    this.lifetime = new AbortController()
    ctx.effect(() => () => { this.lifetime.abort() })
    this.workflows = new WorkflowLiveCatalog(ctx)
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
}

export default MayflyHostService
