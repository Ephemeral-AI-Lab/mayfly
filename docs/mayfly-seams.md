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
revision writes, guarded retraction/drain, and workspace/resource reads. It is
not a generic filesystem, arbitrary-tool, or Host lifecycle API. Its generated
DTO contract lives in `packages/host/src/types.ts` and the Host package README.

Durable Mayfly conversation and facts projections live on the Host. Remote
reads complete latest values, then overlays only transient current-attempt
stream content. Reconnect replaces the baseline; old history must not replay
command notices. Every Session reference includes Host identity. Detach,
reconnect, selection change, cancellation, and unload fence late results.

Official alpha.2 lacks a public configured-MCP-server/transport-health catalog,
file-upload receipts in slash-command execution, and cold-child Agent controls
without resumption. The root README describes each partial behavior and its
visible feedback. These API boundaries do not excuse missing workflows when
native operations already exist.

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
