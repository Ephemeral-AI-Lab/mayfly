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
- No compatibility layer. Contracts, builders, seams, and modules may change
  incompatibly; the change updates every caller (Mayfly, examples, the
  gallery, shipped skills, the Website reference) and deletes the code it
  replaces, with no alias, shim, deprecation, or fallback path.

## Verification

Verify with `pnpm run check -- --tier round|pr|full` (default `pr`). Component
rounds test late: not during design, build, or the owner's effect review, only
once the owner has confirmed the final effect (see *Review loop*); and no round
tests, builds, or previews the Website (below). `round`
is the check of a finished edit (the incremental build, lint, the specs and workflow tests
the change reaches, and its scenarios at their first size), `pr` for finalizing
a change (round plus the checks it claims: agent docs, diagrams, lib exports,
shots, examples, pack, Website; scenarios at every size),
and `full` for broad, release, architecture, composition, or workflow changes
and the end of a phase. The change set is `origin/main...HEAD` plus staged,
unstaged, and untracked files (not generated `.artifacts/`); use `--base <ref>`
when needed. `--plan` prints the plan and steps without running them, and
`--why` adds the chain from a changed file to each selected test. Each step
prints one line and logs to `.artifacts/verify/steps/`; read
`.artifacts/verify/summary.md` after a run: the verdict, the first failure of
each failing spec with why it ran, owed manual acceptance, and how to rerun.
Fix and run the tier again until it passes. Selection
follows the static import graph (`script/verify/graph.mjs`: imports, literal
data reads, built entries mapped to their sources, patch rows); what it cannot
see is declared in `script/verify/inputs.mjs`, and `script/verify/select.mjs`
plans the checks. A new file must be claimed: parsed by the graph, read through
a literal path, or named in the inputs (`script/tests/claimed-files.test.mjs`).
A global input runs the full tier whatever tier was asked.

CI runs the pr tier on a pull request (with advice on changed source lines no
selected spec ran) and the full tier on `main` and nightly. The full tier
includes screenshot freshness, one vitest run (the suites with the stale-row
check on, the work budgets, and the coverage floor), the happy smoke and the
perf scenarios against their ceilings (`perf --assert`) on the tier's own build,
every scenario against its goldens, and a Website build when Website files
changed; do not precede it with redundant plain tests. `pnpm run scenarios
[-- <name>...]` compares the catalog scenarios' checkpoints with
`script/scenarios/golden/` (selected by their `covers` globs, their goldens,
the scenario machinery, and a smoke set for other product code); after
reviewing a difference with `pnpm run frame <name>`, `pnpm run scenarios --
--update <name>` accepts it, and the summary names both. Distribution changes selected by the planner also run
`check:pack`; a plain full tier does not pack. Release
publication additionally requires `pnpm release:preflight <version>`, verified
tarballs, and the human acceptance described below. Instruction and
shipped-skill changes run `check:agent-docs`.

UI component work follows the tiers of the
[roadmap](docs/design/implementation-roadmap.md) §7. Review rounds with the
owner run the round tier (`pnpm run dev --check` runs it after each rebuild);
finalizing a component runs the pr tier with its decision tests (accepted
frames, keys and writes, lifecycle, width, budgets); a phase ends with the full
tier; CI runs the full tier on `main`. Tests record
decisions; do not add tests only to reach a line.

- Vitest uses fork workers and two projects: `suite` runs every spec with
  `MAYFLY_UI_VERIFY_MEMO=1` (each retained-row hit paints again and a
  difference fails), `perf` runs the work budgets without it. Coverage is a
  report with a repository-wide floor (`vitest.config.ts`) that the full gate
  measures; a local changed run does not. Type-only `src/types.ts` files are
  excluded. Specs import the tested source relatively, but package-name
  imports resolve workspace `lib/`; fresh worktrees need a full build baseline.
  `tsconfig.tests.json` typechecks every test file against the package sources,
  and `pnpm run typecheck` runs it with `tsc -b`.
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
- Frame cost is measured where a frame is painted. `tests/perf/frame-workloads.ts`
  counts one frame through the alternate layout and the surface renderer (the
  deterministic gate), and `pnpm run perf` measures the perf scenarios of the
  catalog on the real CLI under a PTY (idle CPU, key-to-paint for keys and wheel
  notches, CPU per key, frames, memory) A/B against the merge base, each metric
  judged `regressed`, `same`, `improved`, or `inconclusive` (more `--runs`
  decide it); `--prof` lists the functions with the most self time. The pr tier
  runs it for a change the perf scenarios cover and reports without gating;
  report it with a change to the frame path. A compiled component's own render
  count is not a frame.

## Review loop

Component work (Phases 3 to 6) follows
[docs/design/component-development-spec.md](docs/design/component-development-spec.md): parts that each end in a
scenario demo with a brief (implemented effects, effects to focus on), the original prototype `.mjs` read first,
and terminal-only demos and questions to the owner.

A component round runs in this order, and nothing is tested before step 5:

1. **Design** under plan mode: Claude analyzes the round and writes the solution.
2. **Questions**: Claude asks the owner about every open choice with something to look at, and the owner and Claude
   confirm the final effect.
3. **Build**: development starts only now.
4. **Scenarios**: when the build is done, Claude writes the scenario code (replay, catalog entry, brief), organizes
   all of the round's scenarios, and tells the owner the commands. It does not rush to test.
5. **Effect review**: the owner verifies and adjusts the effect on the scenarios, and Claude applies the changes. Tests
   stay off in this loop; only the build that the scenarios need runs.
6. **Test**: once the effect is final, the building session writes a test hand-off brief and stops. The tests run in a
   separate session on a smaller model (Haiku) from that brief: the round tier (then the pr tier at the group's end),
   the decision tests and goldens, the commit, and the PR update. See the component development specification, §3.1.

Progress comes first: do not spend a round's time on tests, goldens, or checks before its effect is final.

Review rounds use the workbench instead of a gate run. `pnpm run dev --profile
mayfly-<tag>` watches `packages/*/src` and `examples/*/src`, runs the
incremental build for the changed files, and restarts the profile's `dsh` on the
same persisted session; a failed build is not applied (output in
`.artifacts/dev/build.log`), and the production `mayfly` profile is refused.
`pnpm run scenario <name>` opens the product on a scenario of the catalog
(`script/scenarios/catalog.mjs`; `--list`, `--width`, `--height`, `--no-color`,
`--ascii`, `--speed N`): most are a conversation written as a chronological
timeline (`script/scenarios/replays.mjs`, builders in `timeline.mjs`) and played
into the live session by a driver plugin loaded with `dsh --patch`. The driver appends the session events and streamed frames the
agent loop would have written, creates child sessions (continuable ones with a
live Agent) and a `/btw` side conversation with its own Agent, drives the real
goal and job services, writes compactions, failed provider attempts with their
retry records, inbox messages (the queued-message pane), and notification-pane notices, and
puts approval, question, and plan-review prompts to you, so reviewing a state
needs no model, no quota, and no tools. The replays cover tool cards of every
kind, streaming phases, subagents, plan mode, goals, jobs, modes and model
switches, context pressure, compaction (automatic and manual), errors and
interrupts, retries, queued input, side questions, notices, prompt variants,
rendering edge cases, and a 150-turn history. A finished job wakes the agent,
which answers with the stub notice at real time. Replay events must keep a
stored session loadable (for example `request/header` inside an open turn, one
`retryId` per retry chain), so check that a new replay resumes with
`dsh --resume`; a later effect (a job line, a notice cleared) is an action of
its own, never a timer in the driver. A stub model endpoint answers the
product's own requests. `pnpm run dev --replay <name>` runs the same replay in
the dev loop; a restart resumes the session, and the driver skips a session
that already has turns. A component draft adds the scenario that shows its
states: a replay with `mark()`s and a catalog script of `play`, keys, mouse,
resizes, and named checkpoints. `.artifacts/replay/driver.log` records each
action and any failure.

`pnpm run frame <scenario>` runs the scenario without a person: the runner
(`script/scenarios/runner.mjs`) boots the real `dsh` under a PTY with the
driver on a control socket, the scenario clock, reduced motion, and no generated
title, plays the script, and writes each checkpoint to
`.artifacts/frames/<scenario>-<cols>x<rows>/` as a cell grid, its text, and an
SVG (`--width`, `--height`, `--keys enter,down,ctrl+c`); `--png` also renders
the real look in xterm.js (WebGL, the pinned JetBrains Mono) in headless Chrome,
with keys and the mouse sent as browser events, and writes `<checkpoint>.png`,
which you can open as an image. `pnpm run scenarios -- --png` (the round and pr
tiers pass it) renders each checkpoint that differs or has no golden beside the
merge base's into `.artifacts/verify/shots/` with a contact sheet; pictures
gate nothing, the grid does. A step settles when
the screen content stands still with no frame open and no stub request in
flight; every run fails on a wrapped row, the overflow or crash log, a failed
driver action, or a refused exit. Runs give identical grids, also side by side
(boots take turns). Each run has a home, a session store, and storages of its
own (the workspace is `~/workspace`), and a replay `seed`s stored sessions
there. The Website's app shots are the goldens of the `app-*` scenarios painted
as SVG (`script/shots/app.mjs`): accepting such a golden repaints its shot.
Reduced motion is a saved setting: change it in `/settings`.

Code edits apply by restart. Cordis `restart()` re-runs `apply` but the loader's
plain `import()` returns Node's cached module; Node's internal loader cache
(`ctx.loader.internal.loadCache`) can be invalidated per module URL, which an
in-place reload needs but the workbench does not yet use. Theme and
presentation changes reload in place through `reloadTheme` and keep drafts.

## Worktree and acceptance

Develop user-visible behavior, public seams, and Website changes in a dedicated
worktree and branch. Never link a checkout into production `mayfly`; use
`mayfly-dev` for the main checkout and `mayfly-<tag>` for worktrees.

1. Implement before requesting acceptance; for component rounds the owner reviews the effect on the scenarios first
   and the tests follow (*Review loop*). README, `docs/**`,
   Website pages/assets, and AGENTS-only changes need no runtime profile.
   Executable config, manifests, scripts, preset payload, and shipped skills
   are not documentation-only.
2. The Website is not part of a round: no round or pr-tier step builds, previews, checks, or tests it, and the
   `app-*` goldens and app shots wait with it. The Website is tested once, when a new version is released: then
   `website/**` changes require `pnpm run website:build` and a persistent preview:
   `pnpm --dir website exec vitepress preview . --host 0.0.0.0 --port <port>`, with affected routes given at
   `http://<actual-lan-ip>:<port>/`, never localhost, loopback, or the bind address, for human visual/content
   acceptance. Do not edit Website pages inside a round unless the owner asks.
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
There is no maintainer `.agents/skills` layer; the three skills in
`packages/mayfly/presets/mayfly-cordis/skills/` are for preset users, not ordinary
repository development.
