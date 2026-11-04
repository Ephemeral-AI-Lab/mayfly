# Audit records

Each file is a dated record of one investigation or acceptance round. A record states the commit it audited and does not
define current behavior; the code and the [architecture docs](../README.md) do. Read a record's closeout or status note
first, when it has one.

## 0.1.5 release preparation (2026-11-04)

Record: [2026-11-04-release-0.1.5.md](2026-11-04-release-0.1.5.md).
Runtime `adca84c0`, aligned with the newest published Harness `0.2.2-alpha.3`.
Records release tooling, native platform fixes, explicit managed-profile upgrade,
real attachment and theme regressions, 9,233 passing tests with 100% per-file
coverage, and the dedicated candidate/Website review resources. NO-GO: raw
strict-reference failures, pending human acceptance and unverified npm publishing
permissions remain; the first local registry timeout and its successful retry
are both retained. A clean-CI temporary-directory fixture defect was reproduced
and fixed in `7e9e2cbb`; all tests and coverage pass under a fresh temporary
parent locally, with a new CI run still pending when the record was written.

## Unified CLI and background Host merge (2026-11-04)

Record: [2026-11-04-server-manager-merge.md](2026-11-04-server-manager-merge.md).
Implementation `59297aa9`, main merge `0239d5da`. Records the owner's merge
authorization, native Linux and packed TUI checks, full coverage, main rebuild
and acceptance-resource cleanup. Existing published-reference failures and
pending Windows/macOS native acceptance remain explicitly recorded.

## Split remediation tasks (2026-11-04)

Record: [2026-11-04-split-remediation-tasks.md](2026-11-04-split-remediation-tasks.md).
Baseline `5a834609`. This is a Codex-ready remediation task list for the split
Host + Remote runtime: two P0 authorization/Host-isolation defects, three P1
data-integrity/readonly defects, and the lower-priority capability, rendering,
and architecture findings. It also separates unverified hypotheses and known
upstream limitations from confirmed work.

## Release readiness audit (2026-10-18)

Record: [2026-10-18-release-readiness-audit.md](2026-10-18-release-readiness-audit.md). Baseline `4701538f`, target
`0.1.4-rc.1`. NO-GO at the baseline: coverage below the 99% floor, 18 scenario runs with stale or missing goldens, a
`perf-focus /settings` regression, and 24 stale component shots. The owner approved an **RC-only preview** on
2026-10-18 with a temporary 95% coverage floor and `rc`-only promotion; `latest` stays on `0.1.3-rc.2`, and the
scenario/perf debt remains. The record also carries the fixed test-isolation changes, the upstream advisory triage,
and the Windows browser-opener finding.

## Phase 7 performance audit (2026-10-17)

Folder: [phase-7/](phase-7/). Round 0 measured the 2,000-turn session, the flowing stream, the tools/change
burst, and the combined `perf-long` scene; it changed no product behavior. The fix rounds P1-P7 are listed in the
record and are being implemented on `perf/phase-7`.

| Record | What it is | Read it for |
| --- | --- | --- |
| [Performance audit](phase-7/2026-10-17-performance-audit.md) | The L/J/R findings, work budgets W28-W35, `perf-long` spans, and the proposed renderer algorithm | The measurements, the fix order, and the target counter of each round |

## Phase 3 closeout audit (2026-10-13)

Folder: [phase-3/](phase-3/). Closed with PR #15; fixed items are in the PR, the rest are carried to Phases 5, 7 and 8 (see the Resolution section).

| Record | What it is | Read it for |
| --- | --- | --- |
| [Closeout audit](phase-3/2026-10-13-phase-3-closeout-audit.md) | Docs, decision tests, the `phase3` integration scenario, and a check of how the Phase 3 components fit together | The findings (D, O, P, C), the owner decisions, the verification state, and the next steps |

## Phase 2 pre-review audit (2026-10-11)

Folder: [phase-2/](phase-2/). Closed; every dispatched fix is on `main`.

| Record | What it is | Read it for |
| --- | --- | --- |
| [Progress report](phase-2/2026-10-11-phase-2-audit-progress.md) | Status and closeout | The results on main, the deferred items, and what is still open. Start here. |
| [Audit report](phase-2/2026-10-11-phase-2-audit.md) | The findings (F, P, B, T, E) and the fix slices | What was found, what each finding is, and the owner decisions |
| [Plan](phase-2/2026-10-11-phase-2-audit-plan.md) | The workstreams and the manual list | How the audit was run |
| [Part 1](phase-2/2026-10-11-phase-2-audit-part1.md) | Runtime and measurement | Timings, profiles, and the perf-tool finding (P1-01 to P1-03) |
| [Part 2](phase-2/2026-10-11-phase-2-audit-part2.md) | Static reading and dead code | Lifecycle and dead-code findings (P2-1 to P2-12) |
| [Fix B design](phase-2/2026-10-11-fix-b-lifecycle-design.md) | The design for the lifecycle, sanitizer, notification, and locale fixes | Why each fix is shaped as it is (implemented in PR #14) |

## Earlier records

| Record | Date | What it is |
| --- | --- | --- |
| [Code audit](2026-09-06-code-audit.md) | 2026-09-06 | Code review of Mayfly at `f9e41c4` |
| [Interaction UX](2026-09-06-interaction-ux.md) | 2026-09-06 | Confirmation, forms, and selection in the interaction layer |
| [Notifications](2026-09-06-notifications.md) | 2026-09-06 | Notification and queue behavior |
| [Interaction implementation](2026-09-08-interaction-implementation-audit.md) | 2026-09-08 | Interaction layer at `f51c40d` |
| [Session catalog](2026-09-28-session-catalog.md) | 2026-09-28 | `/sessions` against the pinned Harness persistence contracts |

These are historical and are not updated. Read them for the state they describe, not for the current code.
