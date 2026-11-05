/**
 * Why each `mayflyHost` Remote method exists: the native Remote surface it
 * stands in for. A method retires once its native API exists. The spec keeps
 * one entry per `@Remote` method, checks each scope against the declared
 * resources, and keeps the `docs/mayfly-seams.md` table in step.
 *
 * @module @ephemeral-ai/mayfly-host/remote/native-gaps
 */

/** One `mayflyHost` method's reason to exist. */
export interface NativeGap {
  /** `session` methods declare the Session they read; `host` methods need global Host authorization. */
  readonly scope: 'session' | 'host'
  /** The native API that is missing, or why the method is Mayfly's own contract. */
  readonly missing: string
}

/** Every `mayflyHost` Remote method, by name. */
export const NATIVE_GAPS: Readonly<Record<string, NativeGap>> = Object.freeze({
  capabilities: { scope: 'host', missing: 'Mayfly\'s own handshake: no native API describes a Mayfly Host composition, its protocol, or its features.' },
  btwFork: { scope: 'session', missing: 'No native Remote operation forks the exact current tail, including an unfinished first turn, for a side question.' },
  presentTools: { scope: 'session', missing: 'Native tool presentation runs against in-process Agent tool definitions; no Remote operation presents tool entries.' },
  followWorkflow: { scope: 'session', missing: 'No native Remote stream follows complete Workflow state.' },
  gitStatus: { scope: 'session', missing: 'No native Remote reads the Git status of a Session\'s working copy.' },
  mcpCatalog: { scope: 'session', missing: 'No public catalog of configured MCP servers and their transport health.' },
  toolCatalog: { scope: 'session', missing: 'No native Remote returns a Session\'s construction-frozen tool schema catalog.' },
  skillCatalog: { scope: 'session', missing: 'No native Remote lists user-invocable skills with their source and provider details.' },
  retractTurn: { scope: 'session', missing: 'No native Remote retracts a running tool-free turn.' },
  modelCatalogDetails: { scope: 'host', missing: 'Native model catalogs omit the context windows and reasoning details that provider adapters resolve.' },
  defaultModel: { scope: 'host', missing: 'agentDefaultModel has no Remote face for the Session-independent default.' },
  authorize: { scope: 'host', missing: 'Native credential authorization has no Remote stream for its prompts and addressed answers.' },
  cancelAuthorization: { scope: 'host', missing: 'No native Remote cancels one credential\'s authorization attempt.' },
  permissionCatalogDetails: { scope: 'session', missing: 'No native Remote resolves permission bundles with the passive Session or Host-default yolo state.' },
  deliveredFile: { scope: 'session', missing: 'No native Remote reads a recorded delivered file through the exact Agent\'s filesystem.' },
  latestWorkspaceChanges: { scope: 'session', missing: 'workspaceChanges has no Remote read of the latest retained summary that leaves the Agent inactive.' },
  traceCatalog: { scope: 'session', missing: 'No native Remote reads the canonical trace timeline passively.' },
  traceDetail: { scope: 'session', missing: 'No native Remote reads raw trace events with their relationship metadata.' },
  statsSession: { scope: 'session', missing: 'No native Remote reads a passive Session statistics digest.' },
  statsHistory: { scope: 'host', missing: 'No native Remote scans the global Session corpus for statistics; the scan requires global Host authorization.' },
  providerBalance: { scope: 'host', missing: 'No native Remote reads the official API-key balance.' },
  readSettingsDocument: { scope: 'host', missing: 'Native settings Remotes edit keys, not the raw settings document with its content revision.' },
  writeSettingsDocument: { scope: 'host', missing: 'No native compare-and-write of the raw settings document under the profile lock.' },
  subagentTree: { scope: 'session', missing: 'subagents has no Remote read of the complete descendant tree with live readonly metrics.' },
  subagentStop: { scope: 'session', missing: 'No native Remote stops a continuable cold descendant without resuming it.' },
  workspaceChangesSummary: { scope: 'session', missing: 'workspaceChanges has no Remote read of a per-turn change summary.' },
  workspaceChangesDiff: { scope: 'session', missing: 'workspaceChanges has no Remote read of a per-turn file comparison.' },
  workspacePath: { scope: 'host', missing: 'workspaceRegistry has no Remote lookup by canonical path that never creates a workspace.' },
  listMcpResources: { scope: 'session', missing: 'mcpResources has no Remote face for listing resources and templates.' },
  readMcpResource: { scope: 'session', missing: 'mcpResources has no Remote face for reading a resource body.' },
})
