# Service seam reference

## Native dsh

Plugins directly inject dsh services such as `commands`,
`sessionProjections`, `tools`, `settings`, `skills`, and `sessionController`.
A plugin composed in the same realm as `planMode` can inject it directly; a
root UI plugin reads the native `plan` projection and executes the native
`/plan` command. Mayfly does not rewrite these methods or results.

## Mayfly UI

| Service | Write | Consumer |
| --- | --- | --- |
| `mayflyPanes` | `register(MayflyPaneDefinition, MayflyUiNode)` | core surface renderer |
| `mayflyStatus` | `register(MayflyStatusDefinition, MayflyStatusNode)` | transcript footer |
| `mayflyOverlays` | `open(MayflyOverlayDefinition, MayflyUiNode)` | core overlay renderer |
| `mayflyEditorExtensions` | `register(MayflyEditorExtensionDefinition, MayflyEditorDecoration)` | interaction editor |

`@ephemeral-ai/mayfly-ui` provides the Context declaration merge and contracts;
`@ephemeral-ai/mayfly-ui` provides pure builders.

## Current Agent

`mayflyCurrentAgent.current()` returns `Agent | null`.
`subscribe(listener)` immediately replays the current selection and reports
revision changes. Pass the current Agent or `agent.session` to native dsh
services. It is null while a read-only or resumable side conversation is
displayed, so Agent-scoped writes never reach a conversation the user cannot
drive.

## Conversations

`mayflyConversations.snapshot()` / `subscribe(listener)` describe the
conversations the user can switch between: the primary plus BTW and subagent
side conversations, each a frozen descriptor with `kind`, `label`, derived
`access` (`interactive`, `resumable`, `readonly`), and `residency`, plus the
displayed id. `open({ kind: 'subagent', sessionId, parentSessionId, label,
mode })` shows a child conversation; `display(id)`, `back()`, and `close(id)`
move between them. Descriptors carry no Agent or Session: read native services
for the conversation's data.

## Lifecycle

Every registration follows the consumer Fiber. There is no special admission
stage, grant, owner token, or cross-realm proxy. If the renderer temporarily
unloads, current registry definitions remain and are read again through
`list()/subscribe()` when rendering remounts.

Static UI plugins inject only the Mayfly service they need. A plugin depending on
`mayflyCurrentAgent` unloads with app/core dependency changes under ordinary
Cordis rules.
