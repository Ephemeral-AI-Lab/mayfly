/**
 * Focused actions backed by the generated mayflyHost Remote namespace.
 * @module @ephemeral-ai/mayfly/frontend/mayfly-host
 */
import type { HostClient, HostKey, SessionRef } from '../client/types.ts'
import type {
  MayflyAuthorizationRequest, MayflyDefaultModelRequest, MayflyHostRemote, MayflyModelCatalogRequest,
  MayflyMcpResourceListRequest, MayflyMcpResourceReadRequest, MayflyPermissionCatalogRequest,
  MayflySettingsDocumentWrite,
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

  /** List one page of MCP resources or templates through fixed native operations. */
  listMcpResources(ref: SessionRef, request: Omit<MayflyMcpResourceListRequest, 'sessionId'>, signal?: AbortSignal): ReturnType<MayflyHostRemote['listMcpResources']> {
    return mayflyHostRemote(this.host(ref.host)).listMcpResources({ sessionId: ref.sessionId, ...request }, signal)
  }

  /** Read one MCP resource body, summarizing binary content. */
  readMcpResource(ref: SessionRef, request: Omit<MayflyMcpResourceReadRequest, 'sessionId'>, signal?: AbortSignal): ReturnType<MayflyHostRemote['readMcpResource']> {
    return mayflyHostRemote(this.host(ref.host)).readMcpResource({ sessionId: ref.sessionId, ...request }, signal)
  }

  /** Run native authorization as a structured operation stream with addressed uplink answers. */
  authorize(host: HostKey, request: MayflyAuthorizationRequest, signal?: AbortSignal): ReturnType<MayflyHostRemote['authorize']> {
    return mayflyHostRemote(this.host(host)).authorize(request, signal)
  }

  /** Cancel only the named credential's native authorization attempt. */
  cancelAuthorization(host: HostKey, request: MayflyAuthorizationRequest, signal?: AbortSignal): ReturnType<MayflyHostRemote['cancelAuthorization']> {
    return mayflyHostRemote(this.host(host)).cancelAuthorization(request, signal)
  }

  /** Resolve permission row bundles and optional current yolo state. */
  permissionCatalogDetails(host: HostKey, request: MayflyPermissionCatalogRequest = {}, signal?: AbortSignal): ReturnType<MayflyHostRemote['permissionCatalogDetails']> {
    return mayflyHostRemote(this.host(host)).permissionCatalogDetails(request, signal)
  }

  /** Read the official API-key balance entirely on Host. */
  providerBalance(host: HostKey, signal?: AbortSignal): ReturnType<MayflyHostRemote['providerBalance']> {
    return mayflyHostRemote(this.host(host)).providerBalance(signal)
  }

  /** Read the actual settings document and its content revision. */
  readSettingsDocument(host: HostKey, signal?: AbortSignal): ReturnType<MayflyHostRemote['readSettingsDocument']> {
    return mayflyHostRemote(this.host(host)).readSettingsDocument(signal)
  }

  /** Compare-and-write only the actual settings document. */
  writeSettingsDocument(host: HostKey, request: MayflySettingsDocumentWrite, signal?: AbortSignal): ReturnType<MayflyHostRemote['writeSettingsDocument']> {
    return mayflyHostRemote(this.host(host)).writeSettingsDocument(request, signal)
  }

  private host(key: HostKey): HostClient {
    const client = this.registry.get(key)
    if (client === undefined) throw new HostNotAttachedError(key)
    return client
  }
}
