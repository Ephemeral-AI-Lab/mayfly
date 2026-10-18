# Release readiness audit — 0.1.4-rc.1

Audit baseline: `4701538f` (`main`, 2026-10-18). Report date: 2026-10-18. This
record describes that commit and the release branch built from it; it does not
define current behavior. The target release was `0.1.4-rc.1`; npm already serves
`0.1.3-rc.2` for all three packages.

## Conclusion

**NO-GO at the baseline.** No P0 security defect was found, and the product
builds, typechecks, lints, packages its examples, and passes the happy/PTY
smoke. The release is blocked by the state of the tree, not by an unreviewed
red build:

1. **Coverage is below the repository floor.** The complete suite passes, but
   `pnpm exec vitest run --coverage` reports 97.03% statements / 95.95%
   branches / 97.24% functions / 97.66% lines against the 99% floor. The
   release workflow runs this command, so it will fail before packing.
2. **Scenario goldens are broadly stale.** 18 scenario runs across 15
   scenarios differ from their goldens; `livePrompts` has no goldens yet. The
   differences group into the default model label (`deepseek-flash` to
   `deepseek-v4-pro`), the banner/blank-row layout shift, the sent-prompt/live
   stream rows, and the `app-*` Website shots. These are the visual record of
   the component rounds still pending owner acceptance.
3. **One real performance regression.** `perf-focus nav /settings` measures
   26.25 ms CPU per key against a ceiling of 12; it reproduces in isolation.
   The `perf-swarm` breaches in the full run do not reproduce in isolation and
   are treated as load amplification until re-measured.
4. **The component screenshots are stale.** 24 component SVGs fail
   `pnpm run shots:check`, and the release workflow runs that check.
5. **The release line has not advanced.** The manifests still say
   `0.1.3-rc.2`, which is already on npm. A release requires the next version,
   a matching changelog entry, and the release preflight.

The test fixes in the "Already fixed" section make the complete suite pass;
they do not close the 99% coverage, scenario, performance, or screenshot gates.

## Owner decision and RC scope (2026-10-18)

The owner chose to ship **`0.1.4-rc.1` as an RC-only preview** without adding
the missing decision tests or waiting for the scenario/perf rounds to finish.
This record therefore separates the **stable/latest** verdict from the **RC**
decision:

- The coverage floor is lowered to 95% on this release branch (owner decision);
  the repository's 99% target is a follow-up, not a claim that coverage is
  complete.
- RC promotion writes the `rc` dist-tag only. `latest` stays on
  `0.1.3-rc.2`; RC users must ask for `@rc` or the exact version.
- The scenario goldens and the `/settings` performance regression remain known
  RC debt. The release workflow's candidate gate does not run the scenario
  harness or the real-terminal perf ceilings, so it can publish the preview;
  the full-tier CI remains red until that debt is closed.
- The changelog carries the RC caveat and the Windows sign-in fallback.

This is a **preview release**, not a stable/latest approval. The stable
release still requires the 99% floor, the owner-accepted scenario frames, and
the perf fix.

## What held up

- `pnpm run build`, `typecheck`, `lint` (31 warnings, 0 errors),
  `check:lib`, `check:examples`, `check:agent-docs`, and `diagrams:check` pass.
- `pnpm run website:build` passes.
- The complete Vitest suite passes after the test-isolation fixes:
  344 files passed, 1 skipped; 6,369 tests passed, 1 skipped.
- The happy smoke and the PTY output-recovery smoke pass.
- The published `0.1.3-rc.2` packages carry SLSA provenance attestations.
- The release workflow, package contract, tarball budgets, and external UI-kit
  fixture were reviewed and are sound in design.
- Only `packages/mayfly/src/core/` imports `@earendil-works/pi-tui`; the
  architecture boundary holds.
- No secrets were found in the tracked tree or in the packed artifacts by the
  pattern scan.

## Release blockers

### B1. Coverage below the 99% floor

**RC mitigation:** the release branch lowers the floor to 95% (owner decision,
2026-10-18); the full suite then passes. The 99% target remains a follow-up.
The numbers below are the baseline evidence.

Evidence: `pnpm exec vitest run --coverage` at the release branch after the
test fixes. Results: 6,369 passed, 1 skipped; exit 1 only because of the
coverage thresholds.

| Metric | Covered | Total | Percent | Floor |
| --- | ---: | ---: | ---: | ---: |
| Statements | 32,667 | 33,664 | 97.03% | 99% |
| Branches | 26,128 | 27,230 | 95.95% | 99% |
| Functions | 6,628 | 6,816 | 97.24% | 99% |
| Lines | 26,152 | 26,778 | 97.66% | 99% |

89 source files are below 99%. The largest gaps are in code from the native
alignment and compose work:

| File | Missing statements |
| --- | ---: |
| `interaction/deliverables-command.ts` | 248 |
| `interaction/jobs.ts` | 196 |
| `interaction/tools-commands.ts` | 125 |
| `interaction/trace-command.ts` | 94 |
| `interaction/skills-command.ts` | 79 |
| `core/ui-compiler.ts` | 38 |
| `interaction/mcp-commands.ts` | 28 |
| `transcript/transcript-model.ts` | 19 |
| `interaction/session-workspace-panel.ts` | 18 |
| `interaction/plugin-commands.ts` | 13 |
| `app/inbox-wake.ts` | 12 |

The remaining files have single-digit gaps. Closing this needs decision tests
for the new native/compose paths, not a threshold change: the coverage floor
is a repository invariant, and the release workflow runs the command.

### B2. Scenario goldens differ

The full tier reported 18 failing runs across 15 scenarios:

`mergeDock`, `mergeConversations`, `mergePanels`, `mergeHeights`, `mergeEsc`,
`newMessages`, `brandThemes`, `startSplash`, `harnessAlignment`, `liveQueue`
(two sizes), `livePrompts`, `app-conversation`, `app-permission`,
`app-agents`, and `app-sessions`.

Representative causes from the diff output:

- `deepseek-flash` became `deepseek-v4-pro` in the banner and status row
  (`mergeDock` `items`, `palette`, `token`, `hint-*`, `view`);
- the transcript sits two rows lower in `hint-*`/`history` after the banner and
  sent-prompt changes;
- `livePrompts` has no goldens at all (every checkpoint is new);
- the four `app-*` scenarios carry the same shifted frames.

This is owner-owned visual acceptance, not a mechanical `--update`. The
catalog still marks `startSplash`, `brandThemes`, `mergePanels`, `mergeHeights`,
and `newMessages` as pending review. A release must not accept frames the owner
has not seen.

### B3. `perf-focus nav /settings` regression

Isolated `pnpm run perf -- --assert perf-focus perf-swarm` reports:

- `perf-focus nav /settings` 26.25 ms CPU per key (ceiling 12);
- `perf-swarm btw` 57.34 ms p50 (ceiling 100) and `scroll` 7.5 ms CPU per key
  (ceiling 25), both inside their ceilings when measured alone.

The settings path needs profiling and a fix. The ceilings are decisions and
must not be raised to make the gate pass; the work budgets only ratchet down.

### B4. Stale component shots

`pnpm run shots:check` failed 24 component shots at the baseline. **Resolved on
the release branch:** `pnpm run shots:sync` regenerated them, and
`pnpm run shots:check` now reports all 60 component and 6 app shots current.

### B5. Version and changelog

All three release manifests and the Website still advertised `0.1.3-rc.2` at
the baseline; `npm view` shows that version published on 2026-09-29.
**Resolved on the release branch:** the manifests and markers are
`0.1.4-rc.1`, the changelog has a first entry, and
`pnpm release:preflight 0.1.4-rc.1` passes.

### B6. The release commit must have a green CI run

The first GitHub sync pushed the baseline `4701538f`. Its `ci` full tier is red
for B2/B3. The release workflow's candidate gate is narrower (it does not run
the scenario harness or the PTY perf ceilings), so the RC preview can publish
after its own gates pass; the full-tier CI stays red as recorded debt.

## Non-blocking findings

These are recorded but were not fixed, per the owner's "release blockers only"
choice.

- **Windows browser opener (high, static).** `interaction/provider-account.ts`
  opens the sign-in URL with `cmd /c start "" <url>`. A URL query containing
  `&` is split by cmd's parser; the browser can receive a truncated URL and the
  command remainder can run. The copy-link/paste-back fallback exists. This was
  not reproduced on Windows in this audit.
- **Upstream dependency advisories.** `pnpm audit --prod
  --registry=https://registry.npmjs.org` reports 6 high and 1 moderate
  advisories in the pinned Harness closure: `fast-uri@3.1.5` (patched
  >=3.1.8 via ajv/dsh) and `compression@1.8.1` (patched >=1.8.2 via
  `dsh-host-webserver`). Triage: ajv resolves local schema references and the
  webserver binds loopback, so neither is reachable from Mayfly's own
  untrusted-input paths in this audit; a narrow override or a Harness re-pin is
  the follow-up. The configured Huawei mirror answers the audit endpoint with
  405; use the npmjs registry explicitly.
- **Release configuration.** The `npm` GitHub environment has no required
  reviewers; `NPM_TOKEN` is a repository secret rather than an environment
  secret; `main` has no branch protection and no tag protection. The release
  workflow still uses a human tag push and `--provenance`, and the last release
  succeeded with the token.
- **Archive extraction hardening.** `packages/cli/src/internals.ts` validates
  the archive entry path but not symlink/linkpath entries. npm integrity is the
  primary control; rejecting link entries would be defense in depth.
- **Lint debt.** 31 oxlint warnings, 0 errors; several are intentional
  snapshot-before-mutation loops. No action needed for release.
- **Root manifest drift.** The private root `package.json` still says
  `0.1.0-alpha.1`; the release line is validated only for the publishable
  packages and the Website.
- **GitHub mirror drift.** GitHub `main` was 338 commits behind the Gitea
  remote used for development. This audit pushed the current main; future
  releases still depend on keeping the GitHub `main` current.

## Already fixed on the release branch

- `conversation-feed.spec.ts` now follows the feed's value-identity contract:
  the registry memoizes unchanged projection values, so the test sends new
  objects for new committed values instead of expecting a wake for the same
  object.
- `TranscriptControllerOptions.publishCost` makes the adaptive publish window
  testable; the fake-clock specs inject `() => 0`, so coverage timing no longer
  changes their verdict. `publish-window`, `transcript-model`, and
  `transcript-controller` pass under coverage.
- The two source-scan guard tests and the diff depth-limit test carry a 15 s
  budget; they take 2.2-3.4 s under coverage and no longer collide with the
  default 5 s timeout. The assertions are unchanged.

## Verification state

| Check | Result |
| --- | --- |
| `pnpm exec vitest run --coverage` (95% floor) | PASS: 6,369 tests, 1 skipped; 97.03/95.95/97.24/97.66 |
| `pnpm run check -- --tier full` at baseline | FAIL: suites, scenarios, perf |
| `pnpm run perf -- --assert perf-focus perf-swarm` | FAIL: `perf-focus /settings`; swarm passes |
| `pnpm run shots:sync` / `shots:check` | PASS: 60 component + 6 app shots current |
| `pnpm run check:pack` | PASS: 3 tarballs, publint, attw, external UI kit |
| `pnpm release:preflight 0.1.4-rc.1` / `--artifact` | PASS |
| `pnpm run website:build` | PASS |
| packed CLI `mayfly -V` / `plugin --help` | PASS (`0.1.4-rc.1`, harness 0.2.1-rc.2) |
| `pnpm run typecheck`, `lint`, `check:lib`, `check:agent-docs`, `check:examples` | PASS |

## Not audited

- A real macOS/Windows TUI session; only the CI platform matrix covers those.
- The full Git history for secrets; the scanned tracked tree and tarballs only.
- Website visual/content acceptance; the build passes, no preview was served.
- Dependency exploitability beyond the path triage above.
- A registry-install matrix before publication; that runs after the tag.

## Release decision

**RC-only preview approved** (`0.1.4-rc.1`, `rc` tag, `latest` untouched) on
the owner's decision of 2026-10-18. The release workflow's candidate gate is
the release gate; the full-tier CI is expected to stay red for the scenario
and perf debt recorded above.

A **stable/latest** release remains NO-GO until the 99% coverage floor, the
owner-accepted scenario frames, and the `perf-focus /settings` regression are
closed.
