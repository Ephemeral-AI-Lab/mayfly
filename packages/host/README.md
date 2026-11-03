# `@ephemeral-ai/mayfly-host`

English | [中文](README.zh.md)

Mayfly Host adds the `mayflyConversation` session projection and the `mayflyHost` Remote namespace to a complete `dsh-web-app` composition. Its bundle patch disables the browser handoff and the ordinary Web URL line, then prints one authenticated `mayfly host: <url>` readiness line after Loader settlement.

The Host keeps the native Web transport and browser services, while disabling
the Web-only `harness-dev-context` system-prompt sections and the
`DSH_WEB_URL` shell context. The model is not told that a terminal user is
operating the Web GUI.

The independent frontend is `@ephemeral-ai/mayfly-remote`; the Host does not embed it.

## Mayfly creative preset

The Host bundle registers `mayfly-cordis` (`Mayfly Cordis`) through the native
`@deepseek-ai/dsh-agent-preset` registry. It preserves the pinned upstream
Cordis preset's tools and isolate groups, adds a persona describing the two
processes, and loads its own `cordis-plugin-development`,
`mayfly-plugin-development`, and `editing-cordis-compositions` skills from the
published Host payload. Select it with `/preset mayfly-cordis` where the native
Session turn-boundary guard permits a preset change. Registration and skill
loading belong to Host; the shared renderer package ships no legacy preset or
in-process composition.

Creative mode can inspect native services and author ordinary persistent Host
bundles and Agent presets. Harness `0.2.2-alpha.2` supplies only
`cordis_inspect_list` and `cordis_inspect_query` as Cordis model tools; it no
longer supplies model tools to define, mount, run, stop, or remove dynamic
packages. The Host runner retains a programmatic lifecycle, with `code.host`
running on Host and `code.client` targeting the native browser runner.

The independent TUI has no public dynamic UI hot-load or external frontend
plugin installation entry in this release. Host plugins cannot inject the
frontend-local `mayflyPanes`, `mayflyStatus`, `mayflyOverlays`, or
`mayflyEditorExtensions`; a browser client half cannot reach them either. A
terminal UI prototype currently requires source integration into the Remote
composition, a build, restart, and dedicated-profile acceptance. A Host plugin
installation alone does not render a terminal contribution. The bundled
persona and skills explain this API limit explicitly.

## Remote contract

`capabilities()` returns protocol version 1 and these base feature keys: `mayflyConversation`, `presentTools`, `followWorkflow`, `gitStatus`, `mcpCatalog`, `toolCatalog`, `mayflySettings`, `skillCatalog`, `retractTurn`, `modelCatalogDetails`, `defaultModel`, `authorization`, `permissionCatalogDetails`, `providerBalance`, `settingsDocument`, `subagentTree`, `subagentStop`, `workspaceChanges`, `workspacePath`, `mcpResources`, `stats`, `trace`, `deliveredFiles`, and `btwFork`. An optional callable native MCP server catalog adds `mcpTransportHealth`. Session-scoped methods take `{ sessionId }`; `presentTools` takes `{ entries }`, and Gateway authorizes every named Session before any Agent lookup or activation. A non-owner rejection uses `remote-access/denied`. Ordinary cold Sessions resume through the native Session Controller; a live child uses its exact registry Agent. A cold child cannot use that ordinary resume path: Agent-scoped operations fail with `mayflyHost/agent-unavailable`, while tool presentation uses generic durable content. Neither path borrows its parent or the global tool view.

- `btwFork(request, signal)` accepts `{ sessionId, atSeq?, allowMigration? }` and returns `{ sessionId, historyFloorSeq? }`. Without an explicit cut it observes the complete current native tail, including an unfinished first turn, and delegates balancing and composition to native Session Controller fork. An entirely empty source uses native create with its effective Host directory and preset, and has no inherited floor. Cancellation, exact Agent/source replacement, and service unload suppress late results without cancelling Host work.
- `presentTools(request, signal)` accepts changed `sessionId`, `callId`, `updatedSeq`, tool name, raw arguments, and optional result content. It returns `presentations[sessionId][callId] = { updatedSeq, call?, result? }`. Duplicate pairs fail with `gateway/bad-request`. Native `presentCall`/`presentResult` output is detached and JSON-validated; an unknown tool, throwing presenter, or non-JSON view degrades only that view to the generic card. No Tool Definition, callback, Agent, Session, or Cordis object crosses the boundary.
- `followWorkflow(request, signal)` returns a Remote stream. Its first frame is `{ type: 'baseline', value }`; every later frame is `{ type: 'replacement', value }` with a complete new `MayflyWorkflowSnapshot`. The `mayflyWorkflow` Session projection folds native `tool-workflow/*` records and supplies reconnect baselines; process-local `workflow/*` events add phase and live metadata without becoming a second workflow engine. Child ids remain Session ids. A new turn retires settled runs; interrupted or resumed Session lifecycles mark unfinished runs and members `interrupted: true`. Client disposal, Peer cancellation, service teardown, or exact-Agent loss closes the stream and removes its listeners; Agent loss reports `mayflyHost/session-stale`.
- `gitStatus(request, signal)` returns branch, dirty/ahead/behind, and added/deleted line counts, `{ branch, unknown: true }` when the tree probe fails, or `null` outside a repository or after a branch-probe failure. It uses only the exact Session's effective Host directory. Caches are per exact Agent and directory, with 5-second branch, 15-second status, and 5-second failure-retry TTLs. Each Git process has a 500ms timeout and 4MiB output cap. Caller cancellation stops the process rather than being converted into an empty result.
- `mcpCatalog(request, signal)` returns `servers`, `orphanCount`, and `sessionLive: true`. Each server has `entryId`, `serverName`, derived tool-visibility `status`, connection state, `registeredCount`, visible JSON tool schemas, and sanitized `config`. The published native line supplies no server catalog, so connection is `unknown` and `config` is `{ transport: null, endpoint: null }`; the optional catalog can supply those details. `toolCatalog(request, signal)` returns the exact Agent's visible schemas in stable name order. Catalogs and their parameter JSON are construction-frozen and carry no execution or presentation callbacks.
- The Loader entry `mayfly` registers the complete volatile Mayfly preference schema with official settings, so `remote.settings` reads and writes the namespace directly. Theme and locale application remains TUI-local.
- `skillCatalog` returns `{ skills, complete }` with native `source` and `provider` fields in addition to the official list data. `modelCatalogDetails` returns adapter-resolved `provider`, `id`, `name`, `providerLabel`, optional `contextWindow`, `efforts`, and `defaultEffort`. `defaultModel` accepts `{ operation: 'read' }` or `{ operation: 'select', provider, model, reasoningEffort? }` and returns the resulting selection through `agentDefaultModel`, without a Session.
- `permissionCatalogDetails` returns the official options/defaults plus a `specs` map of each row's `sandbox` and `approval`, and `yolo` for an optional `currentPreset`. `providerBalance` returns official API-key wallets or `network`/`rejected`/`no-key`; the key and Authorization header stay on Host.
- `retractTurn` accepts `{ sessionId, messageId }` and returns whether a matching running tool-free turn was accepted. It cancels through the exact Agent, then writes the Mayfly replacement marker only after the authoritative close commits. It never aliases ordinary cancel or `updateQueue`. `subagentTree` accepts `{ sessionId }` and returns the complete native descendant tree, diagnostics, and readonly live presentation metrics without activating cold children. `subagentStop` accepts `{ sessionId, childSessionId }`, rechecks that root's current native descendants and liveness guards, and waits for `drainChildren` through the exact direct parent. Cancellation retires the reply without cancelling native teardown.
- `workspaceChangesSummary` takes `{ sessionId, seq }`; `workspaceChangesDiff` adds `index`. They return retained native summaries/hunks or `null` without activating a Session. A Host restart or Session disposal may leave no comparison available; these reads do not restore a separate history store. `workspacePath` resolves an existing workspace by canonical path without creation or mutation.
- `deliveredFile` takes `{ sessionId, deliveryId, preview? }` for an authoritative recorded delivery, resolves it through the exact Agent's native filesystem, and returns metadata and an optional text preview capped at 256 KiB. Native filesystem targets never cross the wire. `latestWorkspaceChanges` reads the retained native summary without activating an Agent.
- `statsSession` reads one passive native usage digest and creation metadata. `statsHistory` takes `{ sessionId, allWorkspaces }` and streams whole progress/digest snapshots. It requires global Host authorization in both workspace modes before listing or observing any history; authorization for the anchor Session alone is insufficient. A denied request uses `remote-access/denied`. Only verified cold revisions can reuse a digest; live Sessions are recomputed. `traceCatalog` reads the canonical passive native timeline; `traceDetail` takes its selected `{ sessionId, seq, eventSeqs }` and rechecks those exact event identities before returning immutable raw JSON and native replacement/source relationships. These reads never activate an Agent.
- `listMcpResources` takes `{ sessionId, server, kind: 'resources' | 'templates', cursor? }` and returns `{ items, cursor? }` with JSON-safe metadata. `readMcpResource` takes `{ sessionId, server, uri }` and returns `{ text }`, preserving text bodies and summarizing binary content. Only the three fixed native resource tools are invoked; no arbitrary tool execution API exists.
- `authorize` is a Remote operation stream. Frames are `started`, `notice`, `prompt`, `prompt-ended`, and `settled`, each carrying a server-generated `operationId`. Uplink answers are `{ type: 'answer', operationId, promptId, value }` or `{ type: 'decline', operationId, promptId }`. `cancelAuthorization` cancels the native attempt for the credential. Closing the stream cancels the operation; secret answers pass only from uplink to the native prompt and are never logged.
- `readSettingsDocument` returns `{ writable, content, revision }`, where revision is the raw document's SHA-256 hash. `writeSettingsDocument` takes `{ content, expectedRevision }` and uses the native profile lock shared by configuration writers. It compares the revision, atomically replaces the profile settings document, and reads the returned document under that lock, coordinating independent Host instances as well as native configuration writes. A stale writer receives `mayflyHost/settings-conflict`. This is partial conflict protection: an external editor that ignores the lock can still race after the final revision check. Caller cancellation stops lock acquisition; an already admitted atomic write may finish while its cancelled reply is retired. No arbitrary file path or generic file API exists.

Domain error codes are `mayflyHost/capability-unavailable`, `mayflyHost/agent-unavailable`, `mayflyHost/session-stale`, `mayflyHost/session-directory-unavailable`, `mayflyHost/authorization-unavailable`, `mayflyHost/authorization-in-flight`, `mayflyHost/authorization-failed`, `mayflyHost/settings-conflict`, `mayflyHost/settings-read-only`, `mayflyHost/settings-document-unavailable`, `mayflyHost/subagent-tree-unavailable`, `mayflyHost/subagent-stop-unavailable`, `mayflyHost/subagent-stop-unauthorized`, `mayflyHost/mcp-resource-failed`, and `mayflyHost/delivery-unavailable`. Native resolution can also return `session/not-found`, `session/agent-busy`, or `session/writer-held`; transport and validation use the standard `gateway/*` codes. Async methods observe both caller cancellation and Host service teardown. DTOs and their nested values are frozen before emission.

### Public API limits

Cold child history and projections remain passively readable through the official Session APIs. Agent-scoped specialized presenters and controls remain unavailable without a live child Agent: `SubagentRuntime.startActivation` requires an exact live parent and an initial task, while ordinary Session routing rejects subagent-owned Sessions. `presentTools` returns `{ updatedSeq }` for those entries so the frontend uses a generic card, without failing live entries in the same batch. Other Agent-scoped operations return `mayflyHost/agent-unavailable`. No child is resumed just to browse history, and no parent/global Agent is borrowed.

Handshake package and required Harness versions come from the published manifest. An optional composition exposing a sanitized native MCP server catalog may advertise `mcpTransportHealth`; connecting, reconnecting, and disconnected servers have tool availability `unknown`, never `no-tools` or `synced`.

dsh `0.2.2-alpha.2` exposes no public configured-MCP-server or transport-health catalog: its `ServerContext` carries resources and instructions only. Mayfly therefore lists only servers discoverable through registered tool names and leaves transport/endpoint `null`; it never reads Loader entries or emits command arguments, environment, headers, credentials, or other raw MCP configuration. Its `synced`/`restricted`/`no-tools` status describes tool visibility, not connection health. Additional catalog data must come from a Mayfly Host composition extension using public APIs and sanitized DTOs for server identity, transport, redacted endpoint, and connection state. Environment and headers remain excluded. This project does not add that capability to dsh upstream or copy its private implementation.

## Development profile

Use Node `>=24.9.0`, pinned pnpm `11.7.0`, and an isolated official dsh
`0.2.2-alpha.2` executable. From the repository root:

```sh
pnpm install --frozen-lockfile
DSH_BIN=/path/to/dsh PROFILE=mayfly-host-accept script/install-dev.sh
```

The canonical installer builds the workspace, creates a dedicated profile from
the native Web template if necessary, links the Host bundle, disables optional
native build scripts, and checks the resulting `dsh-base` / `dsh-web-app` /
Mayfly Host composition. It checks the selected dsh line and does not change
the global installation. Existing dedicated profiles are reused, and shared
`mayfly` / `default` profiles are refused.

Start both processes in separate terminals:

```sh
# Host
/path/to/dsh --profile mayfly-host-accept

# TUI; copy the URL from the Host's single readiness line
MAYFLY_DSH_STARTUP_URL='<authenticated-url>' script/mayfly-remote.sh
```

Never put that URL in argv or commit it. Host settings, credentials, workspace,
and Sessions stay on Host; palettes, clipboard, exports, and external editors
run on the TUI machine. A launch without task/resume stays sessionless until
the first prompt. Closing the TUI leaves Host work running.

After source edits, rebuild with `pnpm run build` and restart the affected
process. Reinstall the dedicated profile when the dependency graph changes.
The split packages in this branch are development artifacts; published-package
installation requires a matching verified release set. The old in-process
Mayfly composition is not an alternate supported installation.
