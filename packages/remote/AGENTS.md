# `@ephemeral-ai/mayfly-remote`

This package is the independent HTTP/WebSocket Mayfly Frontend. It is not a
Cordis bundle installed into a dsh Host. Host processes run the native
`dsh-web-app`; this package runs a separate Node process that can attach and
detach multiple Hosts without owning their Agent or Session lifetimes.

## Boundaries

- Cross-process communication uses only the native dsh `/connect`, HTTP Remote,
  `/api/remote.mux` WebSocket, and existing file routes. Do not import Host
  Agent, Session, persistence, or Host Cordis services into this package.
- `src/client/` owns token exchange, cookies, Node transport, and the official
  React-free Client object layer, including the typed `ClientRemote` command
  catalog. A lexical module loader may execute official Client handoffs, but
  must not install a process-global `window` or DOM shim.
- `src/frontend/` owns multi-Host registration, generation-safe selection, and
  typed actions. Every Session identity includes `HostKey`; do not create a
  second Session, Connection, or projection state machine.
- `src/remote/` owns the standalone application, editor, local commands,
  banner, footer, plain panels, and terminal lifecycle. Session facts stay in
  the footer; command results and operation failures use the reference
  notification pane above the editor. Detach releases only Client resources and never cancels remote work.
  Attaching stays Session-independent: the first submitted prompt creates a
  Session, while `/new` and `/clear` release only the primary view. Concurrent
  initial prompts share creation; clearing or detaching fences its late result.
  The editor uses shared readonly `Editor` and placeholder models. Theme swaps
  call its `retheme` handle around the same native editor, preserving its draft,
  caret, undo, history, paste, and completion state. Notification clocks and core
  focus/tail/prompt listeners belong to that mount and stop on unload.
- `/plugin` consumes the shared rc.2 marketplace presentation and calls the
  official selected Host plugin manager for every install, remove, and enable.
  Its catalog, installed rows, notifications, and restart chip belong to one
  feature generation. A Host/selection/reconnection change retires that owner;
  late writes are never retried or presented under another Host.
- `/sessions` consumes the shared reference workspace/session browser and the
  native Client catalog, workspace membership, projection reads, search, and
  archive actions. Listing and detail reads never retain a Session. Child
  conversations use the operations composition's shared presented-view slot;
  readonly native access metadata and BTW history floors accompany bindings.
- Theme/language pickers, settings rail, and permission decision lane use the
  shared reference wire builders. The settings rail submits both native
  descriptor and field-projection revisions; a conflict never refreshes and
  retries a write. Native redacted secrets stay blank in forms; only explicit
  fresh secret edits become native path operations. Permission danger
  confirmations derive from the Host's resolved sandbox/approval spec, never
  from a preset name. Host preference synchronization applies only to the
  currently selected/active Host; background settings or reconnect events cannot
  replace its renderer settings.
- Raw settings editing uses `createRemoteSettingsEditor` with core-owned
  `screen.suspend`. Editing happens locally; writes use the original Host
  document revision and reject results after cancellation or selection change.
- `src/transcript/` adapts official SessionEventSource windows and Session
  projections to the published Mayfly presentation folds. One event pass feeds
  conversation and facts; only live command completion produces a notice.
  It is a presentation adapter, not a Host projection.
- `src/remote-bin.ts` receives credentials only through the authenticated
  `MAYFLY_DSH_STARTUP_URL` environment variable; a non-secret `--host` URL is
  accepted, and a token in argv or a log is refused.
  Tokens never enter argv, logs, screenshots, or ordinary error text.

The candidate `@ephemeral-ai/mayfly` and `@ephemeral-ai/mayfly-ui` packages are
visual dependencies built from the same release set. The published rc.2
artifact is an isolated immutable verification reference. Do not link this
package back into the legacy in-process TUI composition or restore the old
`mayflyCurrentAgent` path.

## Verification

Client transport changes require authentication, reconnect, stale-generation,
and detach tests plus real-Host list/create/open evidence. Registry and command
changes require same-SessionId multi-Host isolation and late-result tests.
Transcript changes require replace/prepend/append/settlement fixtures, live
projection facts, and proof that historical commands do not replay notices.
Command routing changes require Host catalog, alias, failure, and exact
Host/Session coverage. Banner, footer, editor, and panel changes require narrow
and wide rendering plus focus restoration tests. Runtime changes require the
built PTY smoke, proving the banner, footer, command surfaces, Session creation,
and clean teardown.

Develop behavior and regression tests together under the root change-aware
workflow. Before acceptance run the full architecture gate, `pnpm run
check:lib`, and `pnpm run check:pack`, then perform a real dsh Host
attach/detach and PTY acceptance. `pnpm run scenario remoteLifecycle` is the
manual review; supply its Host through `MAYFLY_DSH_STARTUP_URL`, never argv. All
executable source in this package is subject to the repository's per-file 100%
coverage gate.
