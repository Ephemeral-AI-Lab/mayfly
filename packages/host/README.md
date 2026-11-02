# `@ephemeral-ai/mayfly-host`

English | [中文](README.zh.md)

Mayfly Host adds the `mayflyConversation` session projection and the `mayflyHost` Remote namespace to a complete `dsh-web-app` composition. Its bundle patch disables the browser handoff and the ordinary Web URL line, then prints one authenticated `mayfly host: <url>` readiness line after Loader settlement.

The independent frontend is `@ephemeral-ai/mayfly-remote`; the Host does not embed it.

## Remote contract

`capabilities()` returns protocol version 1 and these feature keys: `mayflyConversation`, `presentTools`, `followWorkflow`, `gitStatus`, `mcpCatalog`, `toolCatalog`, `mayflySettings`, `skillCatalog`, `retractTurn`, `modelCatalogDetails`, `defaultModel`, `authorization`, `permissionCatalogDetails`, `providerBalance`, `settingsDocument`, `subagentDrain`, `workspaceChanges`, `workspacePath`, and `mcpResources`. Session-scoped methods take `{ sessionId }`; `presentTools` takes `{ entries }`, and Gateway authorizes every named Session before any Agent lookup or activation. A non-owner rejection uses `remote-access/denied`. Ordinary cold Sessions resume through the native Session Controller; a live child uses its exact registry Agent. A cold child cannot use that ordinary resume path: Agent-scoped operations fail with `mayflyHost/agent-unavailable`, while tool presentation uses generic durable content. Neither path borrows its parent or the global tool view.

- `presentTools(request, signal)` accepts changed `sessionId`, `callId`, `updatedSeq`, tool name, raw arguments, and optional result content. It returns `presentations[sessionId][callId] = { updatedSeq, call?, result? }`. Duplicate pairs fail with `gateway/bad-request`. Native `presentCall`/`presentResult` output is detached and JSON-validated; an unknown tool, throwing presenter, or non-JSON view degrades only that view to the generic card. No Tool Definition, callback, Agent, Session, or Cordis object crosses the boundary.
- `followWorkflow(request, signal)` returns a Remote stream. Its first frame is `{ type: 'baseline', value }`; every later frame is `{ type: 'replacement', value }` with a complete new `MayflyWorkflowSnapshot`. The `mayflyWorkflow` Session projection folds native `tool-workflow/*` records and supplies reconnect baselines; process-local `workflow/*` events add phase and live metadata without becoming a second workflow engine. Child ids remain Session ids. A new turn retires settled runs; interrupted or resumed Session lifecycles mark unfinished runs and members `interrupted: true`. Client disposal, Peer cancellation, service teardown, or exact-Agent loss closes the stream and removes its listeners; Agent loss reports `mayflyHost/session-stale`.
- `gitStatus(request, signal)` returns branch, dirty/ahead/behind, and added/deleted line counts, `{ branch, unknown: true }` when the tree probe fails, or `null` outside a repository or after a branch-probe failure. It uses only the exact Session's effective Host directory. Caches are per exact Agent and directory, with 5-second branch, 15-second status, and 5-second failure-retry TTLs. Each Git process has a 500ms timeout and 4MiB output cap. Caller cancellation stops the process rather than being converted into an empty result.
- `mcpCatalog(request, signal)` returns `servers`, `orphanCount`, and `sessionLive: true`. Each server has `entryId`, `serverName`, derived `status`, `registeredCount`, visible JSON tool schemas, and `config: { transport: null, endpoint: null }`. `toolCatalog(request, signal)` returns the exact Agent's visible schemas in stable name order. Catalogs and their parameter JSON are construction-frozen and carry no execution or presentation callbacks.
- The Loader entry `mayfly` registers the complete volatile Mayfly preference schema with official settings, so `remote.settings` reads and writes the namespace directly. Theme and locale application remains TUI-local.
- `skillCatalog` returns `{ skills, complete }` with native `source` and `provider` fields in addition to the official list data. `modelCatalogDetails` returns adapter-resolved `provider`, `id`, `name`, `providerLabel`, optional `contextWindow`, `efforts`, and `defaultEffort`. `defaultModel` accepts `{ operation: 'read' }` or `{ operation: 'select', provider, model, reasoningEffort? }` and returns the resulting selection through `agentDefaultModel`, without a Session.
- `permissionCatalogDetails` returns the official options/defaults plus a `specs` map of each row's `sandbox` and `approval`, and `yolo` for an optional `currentPreset`. `providerBalance` returns official API-key wallets or `network`/`rejected`/`no-key`; the key and Authorization header stay on Host.
- `retractTurn` accepts `{ sessionId, messageId }` and returns whether a matching running tool-free turn was accepted. It cancels through the exact Agent, then writes the Mayfly replacement marker only after the authoritative close commits. It never aliases ordinary cancel or `updateQueue`. `subagentDrain` accepts `{ parentSessionId, childSessionId }`, rechecks the current native catalog and liveness guards, and calls `drainChildren` only through the exact direct parent.
- `workspaceChangesSummary` takes `{ sessionId, seq }`; `workspaceChangesDiff` adds `index`. They return native summaries/hunks or `null` without activating a Session. `workspacePath` resolves an existing workspace by canonical path without creation or mutation.
- `listMcpResources` takes `{ sessionId, server, kind: 'resources' | 'templates', cursor? }` and returns `{ items, cursor? }` with JSON-safe metadata. `readMcpResource` takes `{ sessionId, server, uri }` and returns `{ text }`, preserving text bodies and summarizing binary content. Only the three fixed native resource tools are invoked; no arbitrary tool execution API exists.
- `authorize` is a Remote operation stream. Frames are `started`, `notice`, `prompt`, `prompt-ended`, and `settled`, each carrying a server-generated `operationId`. Uplink answers are `{ type: 'answer', operationId, promptId, value }` or `{ type: 'decline', operationId, promptId }`. `cancelAuthorization` cancels the native attempt for the credential. Closing the stream cancels the operation; secret answers pass only from uplink to the native prompt and are never logged.
- `readSettingsDocument` returns `{ writable, content, revision }`, where revision is the raw document's SHA-256 hash. `writeSettingsDocument` takes `{ content, expectedRevision }` and revalidates that revision immediately before writing the actual settings document. Concurrent Remote writers are serialized per Host service; a stale writer receives `mayflyHost/settings-conflict`. No arbitrary file path or generic file API exists.

Domain error codes are `mayflyHost/capability-unavailable`, `mayflyHost/agent-unavailable`, `mayflyHost/session-stale`, `mayflyHost/session-directory-unavailable`, `mayflyHost/authorization-unavailable`, `mayflyHost/authorization-in-flight`, `mayflyHost/authorization-failed`, `mayflyHost/settings-conflict`, `mayflyHost/settings-read-only`, `mayflyHost/settings-document-unavailable`, `mayflyHost/subagent-drain-unavailable`, `mayflyHost/subagent-drain-unauthorized`, and `mayflyHost/mcp-resource-failed`. Native resolution can also return `session/not-found`, `session/agent-busy`, or `session/writer-held`; transport and validation use the standard `gateway/*` codes. Async methods observe both caller cancellation and Host service teardown. DTOs and their nested values are frozen before emission.

### Public API limits

Cold child history and projections remain passively readable through the official Session APIs. Agent-scoped specialized presenters and controls remain unavailable without a live child Agent: `SubagentRuntime.startActivation` requires an exact live parent and an initial task, while ordinary Session routing rejects subagent-owned Sessions. `presentTools` returns `{ updatedSeq }` for those entries so the frontend uses a generic card, without failing live entries in the same batch. Other Agent-scoped operations return `mayflyHost/agent-unavailable`. No child is resumed just to browse history, and no parent/global Agent is borrowed.

Handshake package and required Harness versions come from the published manifest. An optional composition exposing a sanitized native MCP server catalog may advertise `mcpTransportHealth`; connecting, reconnecting, and disconnected servers have tool availability `unknown`, never `no-tools` or `synced`.

dsh `0.2.2-alpha.2` exposes no public configured-MCP-server or transport-health catalog: its `ServerContext` carries resources and instructions only. Mayfly therefore lists only servers discoverable through registered tool names and leaves transport/endpoint `null`; it never reads Loader entries or emits command arguments, environment, headers, credentials, or other raw MCP configuration. Its `synced`/`restricted`/`no-tools` status describes tool visibility, not connection health. The minimal upstream addition is a public sanitized server catalog with server identity, transport, redacted endpoint, and connection state; environment and headers must remain excluded. No private implementation is copied here.

## Development profile

Use Node `>=24.9.0` and the repository's pinned pnpm. From the repository root, install and build:

```sh
pnpm install
pnpm run build:changed
```

Initialize a fresh, ignored development profile from the shipped Web template. This replacement command is only for first-time setup; running it again resets the named profile:

```sh
export DSH_HOME="$PWD/.artifacts/dsh-host"
pnpm --dir packages/host exec dsh --profile mayfly-host-dev --from-default-profile web --dump-default-config >/dev/null
pnpm --dir packages/host exec dsh plugin --profile mayfly-host-dev add "link:$PWD/packages/host"
```

The resulting bundle order is `dsh-base`, `dsh-web-app`, then `@ephemeral-ai/mayfly-host`. The Host package's development dependency supplies the same `0.2.2-alpha.2` CLI for installation and launch, independently of the legacy in-process Mayfly package's dsh version.

Launch the external Host:

```sh
pnpm --dir packages/host exec dsh --profile mayfly-host-dev --no-open
```

Copy the authenticated URL from the single readiness line into the environment of a second terminal; never put it in argv or commit it:

```sh
MAYFLY_DSH_STARTUP_URL='<authenticated-url>' pnpm run scenario hostConversation
```

After source edits, run `pnpm run build:changed` and restart the Host. After manifest dependency edits, run `pnpm install`; the existing profile link remains in place.

## Installed profile

With `@deepseek-ai/dsh` `0.2.2-alpha.2` and a published `@ephemeral-ai/mayfly-host` available, the production route uses the same bundle mechanics without `link:` or the workspace-local CLI/home:

```sh
dsh --profile mayfly-host --from-default-profile web --dump-default-config >/dev/null
dsh plugin --profile mayfly-host add @ephemeral-ai/mayfly-host
dsh --profile mayfly-host --no-open
```

The initialization command replaces an existing custom profile, so use it only when creating or intentionally resetting that profile.
