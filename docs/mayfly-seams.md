# Mayfly service seams

The supported runtime has separate Host and TUI Cordis trees. Plugins use the
services documented for their process. There is no process-local Agent facade
on the TUI, and no public `mayflyCurrentAgent`, app, interaction, or startup
entry in the shared Mayfly package.

## Host services and wire

Host plugins consume native dsh `commands`, `sessionProjections`, `tools`,
`agents`, `sessionController`, `settings`, and other services directly, using
the [Harness reference](https://deepseek-harness.github.io/deepseek-harness/reference/).
Agent-scoped operations resolve the exact selected Agent. Passive history and
projection reads do not activate an Agent or borrow a parent's tool scope.

Remote uses official `/connect`, HTTP Remotes, `/api/remote.mux`, and native
file routes. Standard settings, commands, plugin manager, jobs, goals,
presets, and Session operations remain native Remote calls. The focused
`mayflyHost` namespace supplies serializable presentation data and writes
missing from those native transport surfaces: custom tool presentation,
workflow follow, sanitized catalogs, model/permission details, settings-document
revision writes, guarded turn retraction, native descendant-tree facts and
completed descendant stops, passive statistics and traces, and workspace,
recorded-file and MCP-resource reads. It is
not a generic filesystem, arbitrary-tool, or Host lifecycle API. Its generated
DTO contract lives in `packages/host/src/types.ts` and the Host package README.

### Native gaps

Each `mayflyHost` method stands in for a missing native Remote API and retires
once that API exists. `packages/host/src/remote/native-gaps.ts` holds the
record; its spec checks one entry per `@Remote` method, the scope against the
declared resources, and this table. A `session` method declares the Session it
reads; a `host` method needs global Host authorization. `statsHistory` names a
Session but suppresses that resource on purpose.

| Method | Scope | Missing native API |
| --- | --- | --- |
| `capabilities` | host | Mayfly's own handshake: no native API describes a Mayfly Host composition, its protocol, or its features. |
| `btwFork` | session | No native Remote operation forks the exact current tail, including an unfinished first turn, for a side question. |
| `presentTools` | session | Native tool presentation runs against in-process Agent tool definitions; no Remote operation presents tool entries. |
| `followWorkflow` | session | No native Remote stream follows complete Workflow state. |
| `gitStatus` | session | No native Remote reads the Git status of a Session's working copy. |
| `mcpCatalog` | session | No public catalog of configured MCP servers and their transport health. |
| `toolCatalog` | session | No native Remote returns a Session's construction-frozen tool schema catalog. |
| `skillCatalog` | session | No native Remote lists user-invocable skills with their source and provider details. |
| `retractTurn` | session | No native Remote retracts a running tool-free turn. |
| `modelCatalogDetails` | host | Native model catalogs omit the context windows and reasoning details that provider adapters resolve. |
| `defaultModel` | host | agentDefaultModel has no Remote face for the Session-independent default. |
| `authorize` | host | Native credential authorization has no Remote stream for its prompts and addressed answers. |
| `cancelAuthorization` | host | No native Remote cancels one credential's authorization attempt. |
| `permissionCatalogDetails` | session | No native Remote resolves permission bundles with the passive Session or Host-default yolo state. |
| `deliveredFile` | session | No native Remote reads a recorded delivered file through the exact Agent's filesystem. |
| `latestWorkspaceChanges` | session | workspaceChanges has no Remote read of the latest retained summary that leaves the Agent inactive. |
| `traceCatalog` | session | No native Remote reads the canonical trace timeline passively. |
| `traceDetail` | session | No native Remote reads raw trace events with their relationship metadata. |
| `statsSession` | session | No native Remote reads a passive Session statistics digest. |
| `statsHistory` | host | No native Remote scans the global Session corpus for statistics; the scan requires global Host authorization. |
| `providerBalance` | host | No native Remote reads the official API-key balance. |
| `readSettingsDocument` | host | Native settings Remotes edit keys, not the raw settings document with its content revision. |
| `writeSettingsDocument` | host | No native compare-and-write of the raw settings document under the profile lock. |
| `subagentTree` | session | subagents has no Remote read of the complete descendant tree with live readonly metrics. |
| `subagentStop` | session | No native Remote stops a continuable cold descendant without resuming it. |
| `workspaceChangesSummary` | session | workspaceChanges has no Remote read of a per-turn change summary. |
| `workspaceChangesDiff` | session | workspaceChanges has no Remote read of a per-turn file comparison. |
| `workspacePath` | host | workspaceRegistry has no Remote lookup by canonical path that never creates a workspace. |
| `listMcpResources` | session | mcpResources has no Remote face for listing resources and templates. |
| `readMcpResource` | session | mcpResources has no Remote face for reading a resource body. |

`statsHistory` requires global Host authorization before any catalog or history
read, including requests limited to the current workspace. `statsSession`
requires only the named Session's authorization. Raw settings-document saves
share the native profile lock across Host instances and native configuration
writers; revision comparison, atomic replacement, and the returned document
read occur under that lock. This remains partial protection against external
editors that ignore the lock and can race after the final revision check.

Workspace-change reads use comparisons retained by the native Host service and
return `null` when unavailable. Host restart or Session disposal may remove
those comparisons; readonly browsing never activates a Session or restores a
separate workspace-history store.

Durable Mayfly conversation and facts projections live on the Host. Remote
reads complete latest values, then overlays only transient current-attempt
stream content. Reconnect replaces the baseline; old history must not replay
command notices. Every Session reference includes Host identity. Detach,
reconnect, selection change, cancellation, and unload fence late results.

Official alpha.2 lacks a public configured-MCP-server/transport-health catalog
and cold-child Agent controls without resumption. Frontend extension hot mounting
and an isolated Host boot check also lack an official Remote API.
The root README describes each partial behavior and its
visible feedback. These API boundaries do not excuse missing workflows when
native operations already exist. Capability additions stay in Mayfly Host
composition and its serializable Remote contract; dsh upstream is not modified
to supply them.

## TUI contribution services

| Service | Contribution | Owner |
| --- | --- | --- |
| `mayflyPanes` | `register(definition, node)` / `set(node \| null)` | core header/left/right/bottom lanes and status views |
| `mayflyStatus` | `register(definition, node)` / `set(node \| null)` | footer status row |
| `mayflyOverlays` | `open(definition, node)` / `set(node)` | core overlay stack or fixed editor host |
| `mayflyEditorExtensions` | `register(definition, decoration)` / `set(decoration)` | editor decoration |

`@ephemeral-ai/mayfly-ui` provides these four registries and pure node builders.
Nodes are readonly structured data: no Agent, Session, Promise, callback,
pi-tui object, ANSI, focus handle, key binding, or terminal width. Core validates
schema, control characters, quotas, and width. Large lists remain ordinary
readonly arrays; core admits and paints their viewport neighborhood. Plugins
own network/database fetching and never receive a renderer range or cache API.

The provider assigns monotonic revisions and publishes upsert/remove deltas.
A data update refreshes the same instance; an explicit replace establishes a
new instance boundary. Registry subscriptions replay after a renderer gap.
Fiber unload removes registrations, revokes pending replies, and retires local
interaction state. Duplicate ids and invalid definitions throw directly.

## Interaction and rendering lifetime

Observations report value, selection, tab, or focus facts. Structured actions
handle activation, acceptance, submit, and dismissal, returning `accepted`,
`invalid`, `conflict`, `failed`, `completed`, or `cancelled`. Action context
contains source, operation id, revision, AbortSignal, and progress reporting.
Acknowledgements are admitted before native requests settle. Replacement,
unload, abort, or same-name reopen revokes stale handlers and publishers.

The frontend UI interaction owner keeps drafts, validation, single-flight,
confirmation, paging, semantic focus, and feedback across core/theme reload.
Only renderer handles and compiled painters lapse. Editor theme changes
recolor the same native editor and preserve caret, undo, history, paste, and
completion state. Local custom palettes, clipboard, exports, and external
editors run on the TUI machine; workspace reads and changes remain on Host.

The shared key grammar determines both dispatch and hints. Use shared Form,
Choice, Tree, Tabs, Document, and confirmation primitives instead of private
key handlers or confirm pages. Null pane/status snapshots occupy no layout.
A views pane contributes to the footer row and opens underneath it. Bottom
panes share a dock bounded by a third of terminal height; overlays use their
configured height and restore the prior focus/editor lease on close.

Only shared core imports pi-tui or computes visible width. Components consume
facts and return nodes. No renderer folds Harness events as a second durable
store. See [architecture](./mayfly-architecture.md) and
[interaction model](./interaction-model.md) for detailed ownership and keys.
