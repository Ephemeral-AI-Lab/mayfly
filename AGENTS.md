# Repository guidance

Mayfly is an out-of-tree, ESM-only TypeScript terminal UI bundle for DeepSeek
Harness. Use the Node range and pinned pnpm in `package.json`. Runtime imports
resolve built `lib/`; rebuild before testing installed profiles.

Read the owning package's instructions before editing:

| Area | Ownership |
| --- | --- |
| [packages/ui](packages/ui/AGENTS.md) | Renderer-neutral contracts, builders, compositions, UI services |
| [packages/mayfly](packages/mayfly/AGENTS.md) | Runtime, public subpaths, composition, preset |
| [packages/cli](packages/cli/AGENTS.md) | Standalone global launcher and runtime payload |
| [examples](examples/AGENTS.md) | Publish-shaped external consumers and composition |

Current architecture: [docs/README.md](docs/README.md). Consult the
[Harness reference](https://deepseek-harness.github.io/deepseek-harness/reference/)
and [pi-tui docs](https://pi.dev/docs/latest/tui) rather than guessing APIs.
History and release notes do not define current behavior.

## Architecture

- Consume native dsh services directly; Mayfly adds only `mayflyPanes`,
  `mayflyStatus`, `mayflyOverlays`, and `mayflyEditorExtensions`.
- Harness owns Agent/session/domain state. App owns current-Agent selection and
  startup; Agent-scoped calls use the exact Agent from `mayflyCurrentAgent`.
- Events are facts, projections are readonly state, actions are structured
  writes. Renderers never fold a second domain store. Wire models contain no
  Agent/Session, Promise, callback, renderer object, focus handle, key binding,
  ANSI, or terminal width.
- Only `packages/mayfly/src/core/` imports pi-tui or owns raw terminal state,
  ANSI, focus, layout, and visible width. It groups admission, compilation,
  painting, and interaction state, with content, hosts, terminal, keys, text,
  and theme beside them.
- `@ephemeral-ai/mayfly-ui` owns the wire contracts, `ui.*` builders,
  `freezeWire`/`isWireSnapshot`, `defineMayflyComponent`, one `compose.*`
  namespace, and the four registries and provider.
- Cordis entries export `name`, optional `inject`, and `apply(ctx)`; effects are
  Fiber-owned and registrations, listeners, timers, and async work need unload
  and stale-generation handling. No mutable singletons, private realms,
  capability hosts, adapter facades, manifests, or compatibility exports.
- No compatibility layer: change every caller and delete replaced code, with no
  alias, shim, deprecation, or fallback.

## Round workflow

A round is one component or one slice of a phase:

1. **Agree the effect.** Read the package instructions, the reference, and the
   code; ask the owner about every visible or API choice before coding.
2. **Develop behind the demo.** Use the incremental build as the only mechanical
   feedback. Write one long scenario per round: a replay with `mark()`s and one
   catalog script covering the round's effects, a narrow width, and a lifecycle
   case.
3. **Owner review.** Give the owner the scenario name and command
   (`pnpm run scenario <name>` or `dsh --profile mayfly-<tag>`), the order of
   effects, and what to try. Adjust until the effect is final.
4. **Decision tests.** After finalization, add tests that record decisions and
   delete replaced code. Scenarios are a demo tool, not a test gate.
5. **Gate.** Run `pnpm run check` before handoff or merge.

Never test the Website in a round or CI: no build, preview, or screenshot
freshness. It is built and accepted once per release (`docs/package-release.md`).

## Verification

`pnpm run check` (build → typecheck → lint → vitest) is the whole gate: run it
for every merge and before a release. A fresh worktree needs one full build
baseline; ordinary edits may use the incremental build.

Distribution and public-surface changes also run, after `pnpm run check`:

- `pnpm run check:lib` — exports, build entries, public subpaths, types, `files`.
- `pnpm run check:examples` — examples and publish-shaped consumers.
- `pnpm run check:pack` — manifests, distribution, payloads, CLI runtime.
- `pnpm run check:agent-docs` — AGENTS files, instructions, preset skills.

Tests record decisions; do not add tests only to reach a line.

- Vitest uses fork workers with `MAYFLY_UI_VERIFY_MEMO=1`, so a stale retained
  row fails; `tsconfig.tests.json` typechecks test files against source.
- Every component row fits `render(width)`; content renderers join the owning
  `width-scan.spec.ts`. Fixtures use `mkdtempTracked()` and
  `registerTempDirCleanup()`.
- `packages/mayfly/tests/e2e.spec.ts` proves native service access, direct UI
  contributions, exact Agent scope, Fiber cleanup, and core reload.
- `script/package-contract.mjs` derives build entries; structural build changes
  need `pnpm run build`, ordinary emission `pnpm run build:changed`.
- Screenshots are a release task; report `pnpm run perf` with frame-path changes.

## Review workbench

`pnpm run dev --profile mayfly-<tag>` watches sources, builds incrementally, and
restarts the profile's `dsh` on the same session; a failed build is not applied.
`pnpm run scenario <name>` opens a catalog scenario with no model, tools, or
quota; `pnpm run frame <scenario>` runs it headless and writes cell grids, text,
and SVG under `.artifacts/frames/`. Code edits apply by restart; theme changes
reload in place through `reloadTheme` and keep drafts.

## Worktree and acceptance

Develop user-visible behavior, public seams, and Website changes in a dedicated
worktree and branch; never link a checkout into production `mayfly`.

1. README, `docs/**`, Website pages/assets, and AGENTS-only changes need no
   runtime profile; executable config, manifests, scripts, preset payload, and
   shipped skills do.
2. Runtime behavior, public seams, composition, preset payload, and shipped
   skills require `PROFILE=mayfly-<tag> script/install-dev.sh` and headless/PTY
   smoke, with the primary workflow, expected result, narrow/lifecycle case,
   and nearby regressions.
3. Edit `website/**` without building or previewing. A release runs
   `shots:sync`, `website:build`, and a persistent LAN preview, then gives the
   affected routes for human acceptance (never localhost or the bind address).
4. Wait for applicable acceptance before merging; never redirect it to
   production `mayfly`. After merge, rebuild main if runtime output changed,
   stop previews, remove worktree profiles, and record routes and scenarios.

## Maintenance

Match surrounding TypeScript: no semicolons, single quotes, two spaces, `.ts`
relative imports, `import type`, and factual `@module` JSDoc. Oxlint covers
packages and examples; there is no formatter.

Preserve minimum-release-age exclusions and the disabled `koffi` build. Harness
line changes update all pins and pass
`packages/mayfly/tests/transcript/version.spec.ts`. Treat
`cordis.patch.yml` `!!js` values as code; never commit secrets or enable
dependency build scripts without review.

Keep README variants in sync. AGENTS files describe durable boundaries and
verification triggers, not history or test snapshots. The three skills under
`packages/mayfly/presets/mayfly-cordis/skills/` are for preset users, not
repository development.
