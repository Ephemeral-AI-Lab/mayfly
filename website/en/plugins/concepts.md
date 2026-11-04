# Core concepts

## Two Cordis trees

The native Host owns Agents, Sessions, and domain services. The independent
Remote TUI owns Client connections, HostKey + SessionRef selection, interaction
state, and terminal rendering. Plugins in each process use ordinary Cordis
injection; `inject` defines activation dependencies and reload boundaries.

## Fiber is lifecycle

Command, pane, status, overlay, and editor-extension registrations belong to
the caller's Fiber. Other subscriptions, timers, external listeners, and async
work also need disposal and fences against results arriving after abort,
selection change, same-name reopen, or unload.

## Native domain, Mayfly presentation

Host plugins consume public dsh services directly. Native command handlers get
the exact invocation Agent from `invocation.agent`; Agent-scoped operations use
that Agent without borrowing a parent or global tool view.

The TUI consumes official Client whole projections and native Remote writes.
Remote retains selection identities, without cross-process Agent or Session
objects. The shared renderer exposes no current-Agent facade, and renderers
never create a second durable domain store. Additional transport methods belong
to Mayfly Host and carry serializable DTOs.

## Renderer-neutral nodes

UI contributions return readonly `MayflyUiNode` values. Plugins do not import
pi-tui, assemble ANSI, or read terminal width. Core owns validation, layout,
theme, focus, and terminal safety.

## Failure semantics

Native services keep their results and exceptions. Mayfly registries throw for
invalid ids, missing callbacks, and duplicate ids. Observations report facts;
actions return structured replies, admitting acknowledgements before native
requests settle. Registration handles expose `set()/dispose()`; overlays also
expose `close()`.
