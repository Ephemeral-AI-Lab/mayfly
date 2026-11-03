# Phase 2 pre-review audit plan

Plan date: 2026-10-11. Baseline: `b657469`. This is the plan the audit followed. Its results are in
[the audit report](2026-10-11-phase-2-audit.md) and its status is in
[the progress report](2026-10-11-phase-2-audit-progress.md). It does not define current behavior.

## Purpose

Phases 2a, 2b and 2c are merged. Phase 2d, the foundation review, is the owner's review of the running product
(`dsh --profile mayfly-<tag>`), and Phase 3 builds on what it accepts. The audit looks for redundant code, logic
flaws, algorithm and performance problems, and wasted test time before that review, so the accepted frames become
goldens on a foundation with no known defects.

## Rules

- **Audit only.** No product code changes. Output is the report, this plan and the progress report.
- **Evidence.** Each finding has a `file:line`. Each performance or logic claim has a reproduction whose output is
  quoted. A lead is marked unverified until reproduced.
- **Fixes are separate slices**, one commit each on a stacked `feat/audit-<n>` branch, verified with the gate tier
  the slice selects. The owner triages first and merges.
- The root instructions apply to every fix: no compatibility layer, tests record decisions, not lines.

## Workstreams

| ID | Workstream | Method | Who |
| --- | --- | --- | --- |
| A | Logic flaws and correctness (12 leads, F1-F12) | Read lifecycle and edge paths against the instructions; repro scripts for boundary inputs, unterminated escapes, wide characters, resize during append | Agent |
| B | Redundant and dead code | Export-usage scan over packages, examples, scripts, website and docs; grep for compatibility language; duplicate-helper counts | Agent |
| C | Algorithm and performance | Scaling repros (input size doubled, time compared); the existing `script/audit-performance.mjs`; CPU profiles where a PTY run reaches the path | Agent |
| D | Test efficiency | Per-test timings from the vitest JSON reporter, plain against `MAYFLY_UI_VERIFY_MEMO=1`; work-budget run; import-closure and selection fan-out | Agent |
| E | Gate and workflow | Read `script/verify/*`; probe `classifyChanges` with synthetic edits; check step ordering | Agent |
| M | Acceptance that needs a person | See "Manual audit" | Owner |

## Order

1. Reproduce and rank the correctness leads (A).
2. Dead-code and duplication scan (B) and performance measurements (C).
3. Test timings (D), then the gate (E).
4. Write the report with a triage table and proposed slices.
5. Stop for the owner's triage, then fix in slices.

## What the agent can audit

Everything in A to E that runs on Linux with the built `lib/`, a headless terminal and Chrome: asymptotics and
timings, unused exports, duplicated code, selection reach, test durations, lifecycle patterns in code, and the
grid and frame output of scenarios.

## Manual audit

These need a person, a real terminal or another platform:

1. Visual judgment of the basic components beside the prototype at 120 and 60 columns, with `NO_COLOR=1`, ASCII
   glyphs and reduced motion.
2. The prompt with paste, IME and the clipboard (`docs/platform-acceptance.md`) on Linux X11 and Wayland, Windows
   Terminal and macOS.
3. An inline image, and its fallback.
4. A key rebound in `/settings` with the hint row following it, and one pattern from `examples/mayfly-user-kit`.
5. A plugin view in row 2, the work report and the bench.
6. The feel of a 1 MB diff, a long plan and job output following its tail on `dsh --profile mayfly-2c`.
7. Confirming F7 on a resumed session of another workspace.
8. Decisions: the `invariant.ts` companions, merging the three row-source classes, what to cut from the gate, the
   coverage floor, and how far to go in the transcript path that Phase 3a replaces.

## Verification of the audit

- Reproduction output is quoted in the report; the appendix lists each script's input.
- Test timings come from a fresh run, not the stale vitest cache.
- A later fix runs `pnpm run check -- --tier pr` per slice and `--tier full` at the end; `pnpm run perf` for any
  frame-path change; scenario goldens must stay identical unless the change is meant to be visible.
