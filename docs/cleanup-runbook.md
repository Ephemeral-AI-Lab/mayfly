# Cleanup runbook (temporary)

This file exists only for the `refactor/cleanup` branch. Delete it in the final
cleanup commit, together with the temporary "Cleanup mode" section in the root
`AGENTS.md`.

## Base and worktrees

- Base: `origin/main` @ `573e46b` (the compose layer and DSH 0.2.1 alignment).
- Integration worktree: `/home/x/mayfly-cleanup`, branch `refactor/cleanup`.
- Lane worktrees: `/home/x/mayfly-agents/<lane>`, branch
  `refactor/cleanup/<lane>`; remove the worktree and branch after the lane
  merges.
- Profiles: only the integrator or the oracle lane runs
  `PROFILE=mayfly-cleanup script/install-dev.sh`. Lane worktrees never install
  into a global profile.
- Harness: `dsh 0.2.1-rc.2` (`HARNESS_LINE` in
  `packages/mayfly/src/interaction/session-commands.ts`).

## Lanes

One writer per file. The integrator assigns ownership before each wave; a lane
that needs a file outside its ownership stops and asks the integrator.

| Lane | Owns |
| --- | --- |
| `integrator` | root `package.json`, `pnpm-workspace.yaml`, `vitest.config.ts`, `tsconfig*`, `tsdown.config.ts`, `.github/`, `AGENTS.md`, merges |
| `tooling` | `script/**`, `script/tests/**` |
| `docs` | `docs/**`, package `AGENTS.md`, website docs text |
| `oracle` | `.artifacts/**` and temporary `script/cleanup/**`; no tracked source |
| `core-text` | `packages/mayfly/src/core/text/**`, the width/paint/scroll files listed in the W3 plan, their specs |
| `core-keys` | core key tables/decoder, `ui-compiler`, `ui-validator*`, `surface-renderer`, `node-slot`, `ui-scroll-region`, their specs |
| `feature` | `packages/mayfly/src/{app,conversation,transcript,interaction,components,frontend,internal}/**` except `interaction/keys.ts`, their specs |
| `ui` | `packages/ui/**`, `examples/**`, gallery, shipped skills, website text |
| `palette` | `interaction/input-plugin.ts`, `core/completion-*`, `core/ui-prompt.ts`, `packages/ui/src/compositions.ts`, palette specs/scenario |
| `qa` | no edits; reviews test-deletion lists and L2/perf reports |

## Gates

### L0: lane local

Run before every commit or handoff:

```sh
pnpm run build:changed -- --files-json "$(git diff --name-only --diff-filter=ACMR HEAD | node -e 'let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>process.stdout.write(JSON.stringify(s.split(\"\\n\").filter(Boolean))))')"
pnpm run typecheck
pnpm exec oxlint <changed files>
pnpm exec vitest run <the specs the lane owns>
```

No `dsh`, no `pnpm run scenarios`, no `pnpm run frame`, no goldens.

### L1: integration merge

The integrator runs this on `refactor/cleanup` after every lane merge:

```sh
pnpm run check
```

The command is build → typecheck → lint → full vitest, including the design
grids and `MAYFLY_UI_VERIFY_MEMO=1`.

### L2: wave gate

Only the oracle lane runs this, from the integration worktree:

```sh
rm -rf .artifacts/bench/homes .artifacts/bench/work .artifacts/scenarios .artifacts/verify/scenarios.json
pnpm run scenarios
cp .artifacts/verify/scenarios.json .artifacts/oracle/wave-<n>-scenarios.json
node script/cleanup/compare-scenarios.mjs .artifacts/oracle/baseline-scenarios.json .artifacts/oracle/wave-<n>-scenarios.json
pnpm run frame composeDemo
pnpm run check:lib
pnpm run check:examples
pnpm run perf -- --runs 3
```

Run scenarios serially. The throwaway bench profile shares its settings, and
the `/model` scenes change the default; `--parallel` reorders that state and
produces false diffs. Reset the profile before each capture so the run starts
from the same state every time.

The committed goldens are not fully green on this environment: six scenarios
(`viewItems`, `harnessAlignment`, `app-conversation`, `app-permission`,
`app-agents`, `app-sessions`) show model/timing rows because the bench profile
starts at `deepseek-flash` while the goldens were captured from
`deepseek-v4-pro`. Treat the W0 grid capture as the visual baseline: the
differential must be zero, and a scenario that matched its golden must keep
matching it. `composeDemo` is diffed against `.artifacts/oracle/composeDemo/`.
`check:lib` and `check:examples` run only when the wave touches the public
surface or examples.

### L3: final

```sh
pnpm run check
pnpm run check:lib
pnpm run check:examples
pnpm run check:pack
pnpm run check:agent-docs
pnpm run diagrams:check
pnpm run test:repo-workflow
pnpm run perf -- --runs 5
PROFILE=mayfly-cleanup script/install-dev.sh
dsh --profile mayfly-cleanup
pnpm run scenario completionPalette
```

## Oracle rules

- Only the oracle lane runs `dsh`, `pnpm run scenarios`, `pnpm run frame`,
  `script/install-dev.sh`, or the scenario runner. Scenario boots are
  serialized by the runner; concurrent lanes would corrupt profiles and
  `.artifacts`.
- `--update` is refused unless `MAYFLY_CLEANUP_ALLOW_UPDATE=1` is set and the
  scenario is `completionPalette`. Only the integrator sets it, and only after
  the owner accepts the palette.
- Never update goldens to hide a diff. Capture the diff, explain it, and let
  the owner accept it. `--update` on a whole scenario is allowed only after the
  `git diff` is reviewed to contain palette rows alone.
- The design grids stay in vitest until the final L2. Do not delete
  `packages/mayfly/tests/design/` before the last oracle pass.

## Test deletion

- Keep a case if it asserts a key, a visible string, a width, a lifecycle
  event, an error code, or a contract.
- Delete a case only if it asserts nothing throws, a branch was reached, or an
  internal call count.
- Never delete by line range. Classify each case by title.
- Every deletion commit lists the deleted test titles.
- A lane proposes the list; QA approves it; the integrator merges it. No
  unilateral test deletion.
- Do not delete guard specs (`layering`, `keyboard-boundary`,
  `architecture-boundary`, `business-rendering-drift`, `key-audit`,
  `width-scan`), except the single prototype-parity case in `key-audit`.

## Handoff

Each lane reports:

```text
lane:
branch:
commits:
owned files changed:
L0 commands and results:
oracle/API needs:
deleted test titles:
risks:
```

The integrator rebases the lane on the integration tip, merges one lane at a
time, runs L1, and tags the wave after L2.
