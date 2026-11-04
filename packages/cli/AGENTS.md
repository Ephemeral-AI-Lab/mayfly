# `@ephemeral-ai/mayfly-cli`

The unified `mayfly` command owns terminal dispatch and local background Host management. Its normal runtime dependencies are the exact matching Remote and Host packages and the Host-pinned official dsh and atomic file writer. It ships one bundled `lib/bin.js`, not extracted archives or a copied Harness runtime.

## Boundaries

- `src/options.ts` reserves the first `server` argument, owns local profile and management options, and preserves Remote argv. Help/version must not initialize profiles. `mayfly -- server ...` submits a task.
- `src/profiles.ts` uses the packaged official CLI and native plugin manager, with dedicated `MAYFLY_HOME/harness` state. Initialization is serialized and retryable; ordinary startup refuses release mismatches. Explicit `server upgrade` uses the current native installer on a stopped managed profile and preserves profile-owned data; require the original Host to stop and the owner to back up first. Never change global dsh or production profiles during development.
- `src/platform.ts` owns systemd user units, launchd agents, and Windows current-user Run entries. Login enablement is independent of current activation. Windows uses Mayfly's detached supervisor, never Task Scheduler or Windows Services.
- `src/supervisor.ts` owns exactly one native child, authenticated local control, bounded native shutdown, Windows crash recovery and generation-safe records. Native readiness/stop uses parent-child IPC through the Host startup plugin. Never stop a process based solely on a persisted PID. Timers, sockets, listeners and queued continuations must retire on shutdown.
- `src/state.ts` owns private records and management serialization. Local credentials may live only in current-user restricted discovery records; remote input remains `MAYFLY_DSH_STARTUP_URL`. Reject credential arguments and redact diagnostics/logs. Only explicit `--print-startup-url` may print the authenticated URL.
- TUI startup awaits an authenticated Host handshake. Remote alone owns terminal restoration, Client detachment, Agent and Session selection; exiting TUI must not stop Host. Management never becomes a public Host lifecycle RPC.

## Verification

Keep exact dependencies, exports/files, the single executable shebang bin and package budget synchronized with `script/check-pack.mjs`. Structural changes require a full build. All executable source requires per-file 100% coverage, including platform commands, stale-generation cleanup and failure paths. Use tracked temporary fixtures and mock management in source bin tests; never let tests auto-initialize a default user profile.

Before acceptance run the full architecture gate, pack/lib/examples/agent-docs checks, real HTTP/WebSocket and PTY smoke in a dedicated profile. Windows/macOS command-contract tests do not replace native desktop lifecycle acceptance; record platform limitations in [platform acceptance](../../docs/platform-acceptance.md).
