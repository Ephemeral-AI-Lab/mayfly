# Mayfly service seams

Mayfly no longer defines a capability facade. Plugins declare and consume the
dsh services they need directly, per the Harness reference.

## Native dsh services

Common dependencies include:

| Service | Purpose |
| --- | --- |
| `commands` | Register and execute dsh commands |
| `sessionProjections` | Register a projection, or read a snapshot of an Agent's Session |
| `tools` | Use the dsh tool registry |
| `agents`, `sessionController` | Agent/session lifecycle |
| `settings`, `skills` | Native capabilities of the corresponding dsh features |
| `plan` projection, `/plan` command | Read and modify plan state across Agent realms |

Mayfly does not wrap these interfaces or rewrite them into a different
result/error taxonomy. A plugin assembled in the same realm as `planMode` can
still inject that native service directly; a root-level Mayfly plugin does not
pierce an Agent-private realm but instead uses the projection and command that
Harness provides for this purpose.

## Mayfly UI services

| Service | Registration shape | Renderer |
| --- | --- | --- |
| `mayflyPanes` | `register(definition, node)` / `set(node \| null)` | core header/left/right/bottom lanes |
| `mayflyStatus` | `register(definition, node)` / `set(node \| null)` | transcript footer |
| `mayflyOverlays` | `open(definition, node)` / `set(node)` | core overlay stack |
| `mayflyEditorExtensions` | `register(definition, decoration)` / `set(decoration)` | interaction editor |

These services are provided by `@ephemeral-ai/mayfly-ui`. Contributions use the
renderer-neutral `MayflyUiNode`, which can be constructed from
`@ephemeral-ai/mayfly-ui`. Core validates schema, quota, control characters,
and width before rendering.

Plugins do not choose between eager and lazy modes: a large `list.items` is
still an ordinary readonly array, and core only validates, compiles, and paints
the current viewport neighborhood; hidden subtrees gated by `when` enter full
admission only when first visible. A local error in a list entry is carried by
the corresponding disabled row, and an error in a reactive branch is confined
to that branch. Other non-virtualized collections keep using typed quotas.
Mayfly does not expose range, overscan, cache, measurement, or scroll
controller APIs, and plugins remain responsible for their own network and
database fetching.

After a snapshot is frozen successfully, the provider generates a monotonic
revision for each `set()` and notifies the frontend owner and core through
upsert/remove deltas. `set(node, { reason: 'data', source })` publishes an
authoritative data refresh; `reason: 'replace'` establishes a new instance
boundary and is the only update allowed to change `scope`. The old
`eventRevision` parameter has been removed; plugins cannot fabricate their own
acks.

`onEvent` for panes, overlays, and editor extensions splits into `observe` and
`action`. `observe` only receives value, selection-toggle, and tab-change
facts, and cannot publish a snapshot, navigate, or close a surface; `action`
handles activate, selection accept, submit, and dismiss, and every handled
action must return a structured receipt of `accepted`, `invalid`, `conflict`,
`failed`, `completed`, or `cancelled`. `MayflyUiEventContext` provides the
current `source`, operation ID, revision, AbortSignal, and progress reporter.

`accepted` and partial failures carrying `acceptedFields` generate a one-shot
publisher from the registration-bound endpoint. Core admits the reply first,
then the publisher updates the original registration with the ack; a
data/replace update, unload, abort, or same-name reopen revokes handlers,
reporters, and publishers that are no longer valid. Form drafts,
single-flight, conflicts, confirmation, paging, and feedback belong to the
frontend interaction owner; plugins are not required to echo `set()` calls
inside their handlers. Keys, focus, confirmations, and per-row action
availability follow [interaction-model.md](./interaction-model.md).

A null pane/status snapshot occupies no layout; overlays provide
`focus/hide/show/close`, and `presentation: 'editor'` uses the existing editor
host. Even if the caller never disposes manually, Cordis Fiber unload cleans up
the registration.

## Current Agent

`@ephemeral-ai/mayfly/app` provides:

```ts
const agent = ctx.mayflyCurrentAgent.current()
if (agent !== null) {
  const cut = ctx.sessionProjections.snapshot(agent.session, ['myProjection'])
}
```

`current()` returns the currently displayed `Agent | null`; `primary()` retains
the primary session. `subscribe()` replays the exact Agent selection.
`view()` / `subscribeView()` expose readonly metadata for one primary session
plus one auxiliary slot, together with the currently displayed side and
`interactive | resumable | readonly` access. Only an exact Agent still alive in
the registry can enter `current()`: a live BTW/continuable child drives the
entire existing UI directly, while a one-shot child keeps the primary Agent and
is handed to the generic readonly transcript panel. `F7` toggles the displayed
side and `F8` closes the auxiliary slot; closing a BTW additionally releases
its temporary Agent, while closing an ordinary subagent only detaches. A BTW
seed is used only as model context; its `transcriptAfterSeq` cutoff makes the
stream the user sees start from the BTW's own first question, without repeating
primary-session history.

`@ephemeral-ai/mayfly/app` declares the `mayfly/request-subagent-reply` event.
An external plugin can request the shared reply form for the currently
displayed continuable child session; the event itself does not send a message
or resume an Agent. On submit the user explicitly chooses Queue or Steer; the
write still goes through the native addressed-subagent path and checks the
exact identities of the primary Agent and the online child Agent. Browsing and
draft editing of an unloaded child session stay readonly.

`ui.child(..., { tab, tabWhen })` can use tab filtering in a narrow viewport
and show pages simultaneously in a wide one, without replacing `pagePath` or
duplicating list/form state. Viewport matching and visible width remain core's
decision.

When the user interrupts the current Agent, Mayfly synchronously walks the
`parentSession` lineage of the live `agents` and issues an interrupt to every
running continuable descendant via `subagents.interrupt(..., { kind:
'ancestor', agent })`. The operation cancels only the current turn and
preserves Activations and the unclaimed inbox; it does not use the drain API
that would recursively destroy the subtree.

Plugins that need Agent identity inject `mayflyCurrentAgent`. A plugin that
only contributes static UI should not take this dependency, because Cordis
unloads consumers by dependency when app or core reloads.

## Lifecycle

All services live in the same Cordis graph. Registering a duplicate id or an
invalid definition throws directly; dsh command handlers keep dsh's own return
types. There is no grant, manifest admission, gesture token, owner generation,
or cross-realm proxy. Editor replacement uses an ordinary overlay with
`presentation: 'editor'`; the registry keeps the registration, and core
re-projects the same frontend instance and semantic focus after a theme/input
host rebuild.

Registry snapshots can still exist while the renderer is temporarily absent;
after the renderer returns, `subscribe()` replays the current upserts. When an
external plugin unloads, the provider publishes a remove delta. An overlay
registration's title provides the host frame; when the root node is already a
`chrome: 'overlay'` surface, core merges the two into a single frame. Ordinary
overlays and `presentation: 'editor'` both honor `maxHeight`. When it is
undeclared, ordinary overlays take at most one third of the terminal height and
editor presentations at most half of it, with a ten-row floor; short content
keeps its natural height.

Cold continuable children use the Harness addressed-subagent API for history
reads and explicit replies; browsing history does not activate the Agent, and
only sending a reply resumes it. `resumable` and `readonly` mean resumable and
readonly respectively.
