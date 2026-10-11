# Phase 2 pre-review audit: progress report

Report date: 2026-10-11. Baseline: `b657469`. Plan: [audit plan](2026-10-11-phase-2-audit-plan.md). Results:
[audit report](2026-10-11-phase-2-audit.md). This records the state of the audit when it was submitted and does not
define current behavior.

## Status

The agent-auditable part is finished to the depth below. Nothing has been fixed. The manual part has not started.

| Workstream | State | Done | Not done |
| --- | --- | --- | --- |
| A Logic and correctness | Mostly done | F1, F2, F3, F4, F6 and A10 reproduced with numbers. F7 traced in code. F5, F8, F9, F10, F11 read only. F12 not traced to the end | Runtime checks for F5, F7, F8, F9; a segmented-equals-whole property check; a lifecycle sweep of `terminal.ts`, `surface-manager.ts` and `ui-interaction-*.ts` (the first pass went deep only on the 2c files) |
| B Redundant and dead code | Done at counting depth | Export-usage scan (1,945 exports: 218 own-file only, 280 test-only, 1 dead); compatibility leftovers (B1, B2); manifest duplicates (B3); helper duplication counted (B5) | Per-export review of the 280 test-only exports; the duplicate-function scan beyond the named helpers; script hygiene (orphan smokes, copied PTY blocks) read from the first survey only |
| C Algorithm and performance | Partly done | Scaling repros for F1, F2, F4, F6, A10; the existing `audit-performance.mjs` (lists and transcript source healthy to 100,000) | CPU profiles with `perf --prof`; `DiffRowsSource` rebuild on resize, `UiRowCache` FIFO eviction, `scrolled` map growth, and the stacked width clamps are read only, not measured; pane and overlay refresh costs |
| D Test efficiency | Done | Fresh per-test timings (plain and MEMO), work-budget timings, selection fan-out probes; T5 refuted | Coverage-run timings to separate coverage cost; per-spec import-closure report; a deletion check for each proposed test removal |
| E Gate and workflow | Partly done | Selection reach (E1 reproduced), step ordering, input declarations | Scenario determinism under parallel runs; perf verdict statistics; golden accept path |
| M Manual acceptance | Not started | The checklist is in the plan | All of it |

## Findings by severity

| Severity | Count | IDs |
| --- | --- | --- |
| P1 | 1 | F1 |
| P2 | 5 | F2, F3, F4, F7 (to confirm), E1 |
| P3 | 8, plus a low-impact group | F6, A10, B1-B6 (B1-B3 are rule violations with a mechanical fix); the group is F5, F8-F11 |

Reproduced here: F1, F2, F3, F4, F6, A10, E1, B1, B2, B3, B4 counts. Read but not run: F5, F7, F8, F9, F10, F11, B6.

## Corrections made during the audit

Five leads from the first survey were checked and dropped or changed: the `MAYFLY_UI_VERIFY_MEMO` cost (none), the
`agentDocs` patterns (intentional), the `invariant.ts` files (probably a Harness convention), `checkOf` (not slow),
and the duplicate-key count (five manifests, not four). The A10 lead is real but milder than first reported.

## Next steps

1. Owner triage of the report's slice table.
2. Slice `audit-1` (F1, F3, F2, F4, F7 after its check, E1) on `feat/audit-1`, then `audit-2` to `audit-4`.
3. Finish the open runtime checks above while the first slice is in review.
4. Owner runs the manual list in the plan; its results update the 2d acceptance record.

## Working-tree notes

The repository has two uncommitted edits that are not part of this submission: the 2b/2c status tables in
`docs/design/implementation-roadmap.md` and a `20_000` timeout on `markdown-rows.spec.ts:188`. The timeout is a
symptom of F1 and should go when F1 is fixed.

Reproduction scripts are in the audit session's scratch directory and are not committed; the report's appendix
describes their inputs.
