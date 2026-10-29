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
  the footer; command results and operation failures use the editor's transient
  hint. Detach releases only Client resources and never cancels remote work.
- `src/transcript/` adapts official SessionEventSource windows and Session
  projections to the published Mayfly presentation folds. One event pass feeds
  conversation and facts; only live command completion produces a notice.
  It is a presentation adapter, not a Host projection.
- `src/remote-bin.ts` receives credentials only through the authenticated
  `MAYFLY_DSH_STARTUP_URL` environment variable; a non-secret `--host` URL is
  accepted, and a token in argv or a log is refused.
  Tokens never enter argv, logs, screenshots, or ordinary error text.

The published `@ephemeral-ai/mayfly` and `@ephemeral-ai/mayfly-ui` packages are
visual dependencies. The nested workspace lock resolves them from npm rather
than linking the parent workspace's development graph; the root postinstall
runs this nested install. After changing the remote manifest, run
`pnpm --dir packages/remote install` to update its lock. Do not link this
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

Follow the root Round workflow: development uses only the incremental build and
owner review, then finalization adds the decision tests and runs the selected
check tier. Before acceptance run `pnpm run check -- --tier pr`, `pnpm run
check:lib`, and `pnpm run check:pack`, then perform a real dsh Host
attach/detach and PTY acceptance. `pnpm run scenario remoteLifecycle` is the
manual review; supply its Host through `MAYFLY_DSH_STARTUP_URL`, never argv. All
executable source in this package is subject to the repository's per-file 100%
coverage gate.
