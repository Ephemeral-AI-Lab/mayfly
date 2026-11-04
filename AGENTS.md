# Repository guidance

Mayfly is an out-of-tree, ESM-only TypeScript terminal frontend for DeepSeek
Harness, deployed as a native Host and independent Remote TUI. Use the Node range and pinned pnpm in `package.json`. Runtime imports
resolve built `lib/`; rebuild before testing installed profiles.

Read the owning package's instructions before editing:

| Area | Ownership |
| --- | --- |
| [packages/ui](packages/ui/AGENTS.md) | Renderer-neutral contracts, builders, UI services |
| [packages/mayfly](packages/mayfly/AGENTS.md) | Shared renderer and readonly presentation subpaths |
| [packages/host](packages/host/AGENTS.md) | Native Host composition, projections, focused Remote methods |
| [packages/remote](packages/remote/AGENTS.md) | Official Client transport, frontend state/writes, standalone TUI |
| [packages/cli](packages/cli/AGENTS.md) | Unified CLI, local services, exact Host/Remote/Harness dependencies |
| [examples](examples/AGENTS.md) | Publish-shaped external consumers and composition |

Current architecture: [docs/README.md](docs/README.md). Consult the
[Harness reference](https://deepseek-harness.github.io/deepseek-harness/reference/)
and [pi-tui docs](https://pi.dev/docs/latest/tui) rather than guessing APIs.
History and release notes do not define current behavior.

## Architecture

- Consume native dsh services directly. Mayfly UI contributions use only
  `mayflyPanes`, `mayflyStatus`, `mayflyOverlays`, and `mayflyEditorExtensions`.
- Harness owns Agent/session/domain state in the Host. Remote owns HostKey +
  SessionRef selection, startup coordination, and frontend state. Host
  Agent-scoped calls resolve the exact selected Agent. No Agent or Session
  object crosses processes; `mayflyCurrentAgent` is not a public split seam.
- The Host and TUI have separate Cordis trees. Use official Client transport
  and native Remote namespaces; focused Mayfly Host methods carry serializable
  DTOs. Remote consumes whole durable projections and overlays only transient
  current-attempt content, never a second durable history fold. The shared
  Mayfly package publishes no root plugin, Host patch, or preset payload.
- Events are facts, projections are readonly current state, actions are
  structured writes. Renderers must not fold session events into a second
  domain store. Wire models contain no Agent/Session, Promise, callback,
  renderer object, focus handle, key binding, ANSI, or terminal width.
- Only `packages/mayfly/src/core/` imports pi-tui or owns raw terminal state,
  ANSI, focus, layout, and visible-width truth.
- Cordis entries export `name`, optional `inject`, and `apply(ctx)`; ordering
  comes from injection. Effects are Fiber-owned. Registrations, listeners,
  timers, and async work need unload and stale-generation handling. No mutable
  product singletons, private realms, capability hosts, adapter facades,
  provider owners, Mayfly manifests, or compatibility exports.
- No compatibility layer. Contracts, builders, seams, and modules may change
  incompatibly; the change updates every caller (Mayfly, examples, the
  gallery, shipped skills, the Website reference) and deletes the code it
  replaces, with no alias, shim, deprecation, or fallback path.

## Parallel implementation and verification

The split-parity implementation is authorized to develop and test in parallel.
The immutable npm 0.1.4-rc.2 release defines UI, keys, themes, and workflows.
Do not rewrite reference goldens from candidate output. Only documented native
Harness API gaps may be delivered as explicitly labelled partial behavior.

The integrator owns package contracts, manifests, locks, public entries, and
runtime composition. Host, Remote, and independent validation workers use
separate worktrees and commit scoped changes. Each implementation includes
meaningful local tests; the independent verifier owns reference artifacts and
real HTTP/WebSocket plus PTY evidence. Validate the combined integration commit.

Start with `pnpm run verify:changed -- --plan`, iterate with
`pnpm run verify:changed`, and run `pnpm run verify:full` for final architectural
acceptance. These delegate to `pnpm run check -- --tier pr|full`, the existing
change-aware verification planner.
Tests and builds are permitted throughout development. Executable package
source requires per-file 100% coverage; do not lower thresholds or exclude
uncovered runtime code to pass. Type-only files have no executable coverage.

Tests import source relatively; package imports resolve built `lib/`, so fresh
worktrees need one full build. Width scans must cover every content renderer.
Use tracked temporary-directory fixtures for profiles/sessions. Every listener,
timer, registration, and continuation needs unload and stale-generation tests.

Public entry changes update exports, source entries, types and files together.
`script/package-contract.mjs` owns the release set. Run `check:lib`, `check:pack`,
`check:examples` and `check:agent-docs` for architecture/composition changes.
Keep English and Chinese READMEs synchronized. Website changes require a strict
build, LAN preview and human acceptance under the user's current instructions.

## Worktree and acceptance

Develop user-visible behavior, public seams, and Website changes in a dedicated
worktree and branch. Never link a checkout into production `mayfly`; use
`mayfly-dev` for the main checkout and `mayfly-<tag>` for worktrees.

1. Implement code and meaningful tests together, run the selected local gates,
   and complete the required full gate before requesting acceptance. README,
   `docs/**`, Website pages/assets, and AGENTS-only changes need no runtime profile.
   Executable config, manifests, scripts, preset payload, and shipped skills
   are not documentation-only.
2. Every `website/**` change requires `pnpm run website:build` and a persistent
   preview: `pnpm --dir website exec vitepress preview . --host 0.0.0.0 --port
   <port>`. Give affected routes at
   `http://<actual-lan-ip>:<port>/`, never localhost, loopback, or the bind
   address, for human visual/content acceptance.
3. Runtime behavior, public seams, composition, preset payload, and shipped
   skills require `PROFILE=mayfly-<tag> script/install-dev.sh` and relevant
   headless/PTY smoke. Give both launch commands: `dsh --profile mayfly-<tag>`
   for the Host, then `MAYFLY_DSH_STARTUP_URL='<Host URL>' script/mayfly-remote.sh`
   for the TUI. Include the primary workflow, expected result, fallback or
   narrow-width/lifecycle case, and nearby regression checks. Rebuild after source
   edits; reinstall when dependencies change. A mixed Website/runtime change
   requires both acceptance paths.
4. Wait for all applicable human acceptance before merging, stopping previews,
   or removing profiles. Never redirect acceptance to production `mayfly`.
   After acceptance and merge, rebuild main when runtime output changed, stop
   previews, remove worktree profiles, and record exercised routes/scenarios.
5. Roadmap UI phases develop one component at a time in review rounds with the
   owner on `dsh --profile mayfly-<phase>`; the live result, not the prototype,
   decides. The owner's acceptance finalizes the component, which merges to
   `main` on its own; the profile stays until the phase gate's acceptance.

## Maintenance

Match surrounding TypeScript: no semicolons, single quotes, two spaces,
`.ts` relative imports, `import type`, and factual module-level `@module` JSDoc.
Empty type imports may activate declaration merges. Oxlint covers packages and
examples; there is no formatter.

Preserve minimum-release-age exclusions and the disabled `koffi` build. Harness
line changes update all pins/exclusions and pass
`packages/mayfly/tests/transcript/version.spec.ts`; avoid broad lockfile refreshes.
Treat `cordis.patch.yml` `!!js` values as code. Do not commit secrets or enable
dependency build scripts without review.

Keep README language variants in sync. AGENTS files contain durable boundaries
and verification triggers, not change history or test-result snapshots. Update
them when ownership, lifecycle, public surfaces, or required checks change.
There is no maintainer `.agents/skills` layer. The three shipped skills in
`packages/host/presets/mayfly-cordis/skills/` teach Host extensions, Remote
source integration, and user-owned compositions against the official Harness
APIs. They are not required for ordinary repository development. The historical
`packages/mayfly/presets/` payload remains a private reference fixture; the
shared renderer does not publish presets or skills. Run `check:agent-docs`
after editing either agent guidance or the shipped Host skills.
