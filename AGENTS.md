# Repository guidance

Mayfly is an out-of-tree, ESM-only TypeScript terminal UI bundle for DeepSeek
Harness. Use the Node range and pinned pnpm in `package.json`. Runtime imports
resolve built `lib/`; rebuild before testing installed profiles.

Read the owning package's instructions before editing:

| Area | Ownership |
| --- | --- |
| [packages/ui](packages/ui/AGENTS.md) | Renderer-neutral contracts, builders, UI services |
| [packages/mayfly](packages/mayfly/AGENTS.md) | Runtime, public subpaths, composition, preset |
| [packages/cli](packages/cli/AGENTS.md) | Standalone global launcher and runtime payload |
| [examples](examples/AGENTS.md) | Publish-shaped external consumers and composition |

Current architecture: [docs/README.md](docs/README.md). Consult the
[Harness reference](https://deepseek-harness.github.io/deepseek-harness/reference/)
and [pi-tui docs](https://pi.dev/docs/latest/tui) rather than guessing APIs.
History and release notes do not define current behavior.

## Architecture

- Consume native dsh services directly. Mayfly UI contributions use only
  `mayflyPanes`, `mayflyStatus`, `mayflyOverlays`, and `mayflyEditorExtensions`.
- Harness owns Agent/session/domain state. App owns current-Agent selection
  and startup coordination. Agent-scoped calls use the exact Agent selected
  by `mayflyCurrentAgent`, not merely a matching session ID.
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

## Verification

Start with `pnpm run verify:changed -- --plan`, then `pnpm run verify:changed`.
The default comparison is `origin/main...HEAD` plus staged, unstaged, and
untracked files; use `--base <ref>` when needed. The executable selection rules
are in `script/test-impact.mjs` and `script/verify-changed.mjs`.

Use `pnpm run verify:full` for broad, release, architecture, composition, or
workflow changes. CI runs the full deterministic gate. Full verification runs
coverage once and happy smoke; do not precede it with redundant plain tests.
Run `pnpm run check:pack` for distribution changes; it is not part of the full
runner. After instruction or shipped-skill edits, run
`pnpm run check:agent-docs`.

- Vitest uses fork workers and per-file 100% executable-source coverage.
  Type-only `src/types.ts` files are excluded. Specs import the tested source
  relatively, but package-name imports resolve workspace `lib/`; fresh
  worktrees need a full build baseline.
- Every component row must fit `render(width)`. Add content renderers to the
  owning `width-scan.spec.ts`. Runtime width helpers flow through
  `mayflyComponents`; tests use `packages/mayfly/src/core/width.ts`. The frame
  clamp is a diagnostic backstop.
- Profile/session fixtures use `mkdtempTracked()` and
  `registerTempDirCleanup()` from `packages/mayfly/tests/core/temp-dir.ts`.
- `packages/mayfly/tests/e2e.spec.ts` proves whole-tree native service access,
  direct UI contributions, exact Agent scope, Fiber cleanup, and core reload.
- `script/package-contract.mjs` derives build entries from manifests and owns
  release/example package sets. Subpath changes update exports, source, types,
  and `files`; verify with `pnpm run check:lib`. Structural build changes need
  `pnpm run build`; ordinary emission can use `pnpm run build:changed`.
- Screenshot updates use `pnpm run shots:sync` after build; `pnpm run shots:check`
  checks committed screenshots for staleness.

## Worktree and acceptance

Develop user-visible behavior, public seams, and Website changes in a dedicated
worktree and branch. Never link a checkout into production `mayfly`; use
`mayfly-dev` for the main checkout and `mayfly-<tag>` for worktrees.

1. Implement and verify before requesting acceptance. README, `docs/**`,
   Website pages/assets, and AGENTS-only changes need no runtime profile.
   Executable config, manifests, scripts, preset payload, and shipped skills
   are not documentation-only.
2. Any `website/**` change requires `pnpm run website:build` and a persistent
   preview: `pnpm --dir website exec vitepress preview . --host 0.0.0.0 --port <port>`.
   Give affected routes at `http://<actual-lan-ip>:<port>/`, never localhost,
   loopback, or the bind address, for human visual/content acceptance.
3. Runtime behavior, public seams, composition, preset payload, and shipped
   skills require `PROFILE=mayfly-<tag> script/install-dev.sh` and relevant
   headless/PTY smoke. Give `dsh --profile mayfly-<tag>` with the primary
   workflow, expected result, fallback/narrow-width/lifecycle case, and nearby
   regression checks. Rebuild after source edits; reinstall when dependencies
   change. Mixed Website/runtime changes need both acceptance paths.
4. Wait for all applicable human acceptance before merging, stopping previews,
   or removing profiles. Never redirect acceptance to production `mayfly`.
   After acceptance and merge, rebuild main when runtime output changed, stop
   previews, remove worktree profiles, and record exercised routes/scenarios.

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
There is no maintainer `.agents/skills` layer; the three skills in
`packages/mayfly/presets/mayfly-cordis/skills/` are for preset users, not ordinary
repository development.
