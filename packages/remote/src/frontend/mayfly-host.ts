/**
 * Focused actions backed by the generated mayflyHost Remote namespace.
 * @module @ephemeral-ai/mayfly/frontend/mayfly-host
 */
import type { HostClient, HostKey, SessionRef } from '../client/types.ts'
import type {
  MayflyDefaultModelRequest, MayflyHostRemote, MayflyModelCatalogRequest,
} from './host-contract.ts'
import { mayflyHostRemote } from './host-mount.ts'
import { HostNotAttachedError, type HostRegistry } from './host-registry.ts'

/** Session-exact passthroughs for focused Host operations; no behavior is emulated locally. */
export class MayflyHostActions {
  /** @param registry - owner of the exact mounted Host Clients. */
  constructor(private readonly registry: HostRegistry) {}

  /** Read protocol, Host, and required dsh versions plus feature keys. */
  capabilities(host: HostKey): ReturnType<MayflyHostRemote['capabilities']> {
    return mayflyHostRemote(this.host(host)).capabilities()
  }

  /** Ask the Host to retract only a matching running tool-free turn. */
  retractTurn(ref: SessionRef, messageId: string, signal?: AbortSignal): ReturnType<MayflyHostRemote['retractTurn']> {
    return mayflyHostRemote(this.host(ref.host)).retractTurn({ sessionId: ref.sessionId, messageId }, signal)
  }

  /** Drain a continuable child only through its exact direct parent. */
  subagentDrain(parent: SessionRef, child: SessionRef, signal?: AbortSignal): ReturnType<MayflyHostRemote['subagentDrain']> {
    if (parent.host !== child.host) throw new Error('Subagent parent and child must belong to the same Host')
    return mayflyHostRemote(this.host(parent.host)).subagentDrain({
      parentSessionId: parent.sessionId,
      childSessionId: child.sessionId,
    }, signal)
  }

  /** Read one native per-turn workspace change summary without local reconstruction. */
  workspaceChangesSummary(ref: SessionRef, seq: number, signal?: AbortSignal): ReturnType<MayflyHostRemote['workspaceChangesSummary']> {
    return mayflyHostRemote(this.host(ref.host)).workspaceChangesSummary({ sessionId: ref.sessionId, seq }, signal)
  }

  /** Read one native per-turn file comparison with cancellation. */
  workspaceChangesDiff(ref: SessionRef, seq: number, index: number, signal?: AbortSignal): ReturnType<MayflyHostRemote['workspaceChangesDiff']> {
    return mayflyHostRemote(this.host(ref.host)).workspaceChangesDiff({ sessionId: ref.sessionId, seq, index }, signal)
  }

  /** Resolve an existing Host workspace by canonical path without creating or mutating it. */
  workspacePath(host: HostKey, path: string, signal?: AbortSignal): ReturnType<MayflyHostRemote['workspacePath']> {
    return mayflyHostRemote(this.host(host)).workspacePath({ path }, signal)
  }

  /** Read the Host's complete user-invocable skill observation for one Session. */
  skillCatalog(ref: SessionRef, signal?: AbortSignal): ReturnType<MayflyHostRemote['skillCatalog']> {
    return mayflyHostRemote(this.host(ref.host)).skillCatalog({ sessionId: ref.sessionId }, signal)
  }

  /** Read adapter-owned model context and reasoning metadata. */
  modelCatalogDetails(host: HostKey, request: MayflyModelCatalogRequest = {}, signal?: AbortSignal): ReturnType<MayflyHostRemote['modelCatalogDetails']> {
    return mayflyHostRemote(this.host(host)).modelCatalogDetails(request, signal)
  }

  /** Read or replace the Session-independent default through the native owner. */
  defaultModel(host: HostKey, request: MayflyDefaultModelRequest, signal?: AbortSignal): ReturnType<MayflyHostRemote['defaultModel']> {
    return mayflyHostRemote(this.host(host)).defaultModel(request, signal)
  }

  /** Read the construction-frozen Session-visible tool catalog. */
  toolCatalog(ref: SessionRef, signal?: AbortSignal): ReturnType<MayflyHostRemote['toolCatalog']> {
    return mayflyHostRemote(this.host(ref.host)).toolCatalog({ sessionId: ref.sessionId }, signal)
  }

  /** Read the construction-frozen, secret-free MCP catalog. */
  mcpCatalog(ref: SessionRef, signal?: AbortSignal): ReturnType<MayflyHostRemote['mcpCatalog']> {
    return mayflyHostRemote(this.host(ref.host)).mcpCatalog({ sessionId: ref.sessionId }, signal)
  }

  private host(key: HostKey): HostClient {
    const client = this.registry.get(key)
    if (client === undefined) throw new HostNotAttachedError(key)
    return client
  }
}
