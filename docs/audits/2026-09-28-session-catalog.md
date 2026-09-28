# Session catalog audit, 2026-09-28

Scope: the pinned Harness `0.1.7-rc.2` persistence, query, projection, and session
controller contracts, plus Mayfly's `/sessions` loading, names, details, search,
navigation, archive admission, cancellation, and unload.

## Findings and final behavior

| Finding | Cause | Correction |
| --- | --- | --- |
| Untitled conversations all displayed `session-`. | The label truncated the shared native ID prefix. | Strip the prefix before abbreviating; retain the complete ID in filtering and details. |
| Existing titles appeared as `Untitled`, including after the first repair. | Listing hints can be absent or stale. The first repair skipped cached `null` and let it mask a recovered title. | Prefer an authoritative title read over cached hints. Retain both named and genuinely untitled results against the native storage revision. Exact detail baselines remain authoritative. |
| Cold sessions showed invented `0s` durations. | Native `updatedAt` falls back to creation when activity hints are missing. | Use known prompt/settlement times, running state, or an update later than creation. Otherwise show creation age and leave activity/duration unknown. |
| Opening blocked for seconds before showing the panel. | The overlay opened only after disk listing completed. | Paint the panel immediately with live and retained rows; refresh storage in the background. |
| Each opening scanned the catalog twice. | The controller list and the header join each enumerated persistence. | One native `sessionPersistence.list()` returns both headers and revisions. Join exact live Sessions and Agents in memory. |
| Recovery rescanned the entire catalog for every 32 titles. | `readTitleSnapshots` internally enumerates the corpus on every call. | Use Harness `readColdSessionLog` for individual changed sessions, with four workers. Its read handles close on success, failure, and cancellation. |
| Listing processed unnecessary transcript data. | The generic controller list views every cached projection, including full conversation projections. | Request only title, list metadata, conversation facts, tokens, statistics, and model selection. Never retain logs or prepared Sessions in the UI cache. |
| Reopening reread unchanged histories. | Recovery results belonged to the panel and were discarded on close. | The command Fiber retains compact headers and title results, keyed by native persistence identity and revision. Changed/deleted records are invalidated; storage replacement and unload retire the cache. |
| Progress caused repeated whole-list work. | Each batch rebuilt data, searched arrays by ID, and repeatedly copied archive membership. | Coalesce title publication to at most one scheduled update per 100 ms, index rows by ID, and snapshot archive/current state once per row build. |
| Archive/restore waited for an unnecessary rescan. | The panel rescanned all sessions after changing an archive flag. | Repaint the native archive state directly. Membership has not changed, so this path needs no listing. |
| A pending child read could navigate after close or lead replacement. | It used the catalog lifetime and did not check the exact lead Agent after awaiting. | Use the detail action signal and recheck cancellation and exact Agent identity before navigation. |
| The current badge followed the primary Agent while viewing a live child. | The row compared against `primary()`. | Compare with the actual selected Agent. |

The first acceptance failure was a concrete stale-cache case: the stored
checkpoint had `title: null` at seq 4 while the log had a title at seq 20. The
regression tests preserve this distinction. Cached nulls and older nonempty
names are hints, not authoritative absence or current names.

## Ownership and freshness

The retained data contains native header/revision snapshots and `title | null`
read results. It contains no event log, transcript, Agent, or prepared Session.
Harness owns log parsing, interrupted-turn recovery, title folding, projections,
Agent activation, and every write. Browsing never activates an Agent or asks an
LLM to regenerate a title.

Native revisions are compared only within the same persistence instance. A
concurrent append after listing can cause a conservative reread on the next
refresh; an older read is never reused for a new revision. Header compatibility
is checked before accepting a cold result. If a Session becomes live during the
read, its actual live title wins and the result is not cached as a durable cut.

Closing the panel aborts queued/in-flight title work while retaining completed
read results. Refresh cancels the previous recovery before starting another.
Reissuing `/sessions` focuses the existing panel. Live title changes arrive via
native projection notifications. Native service lifetimes and command Fiber
unload release listeners, timers, and retained data.

A reopened catalog displays retained rows while the native revision listing is
in progress; the loading label makes that refresh visible. Normal data updates
preserve form drafts, list filters, focus, and pending shared actions. Title
publication is deferred while an action is running. Details still request a
fresh native projection baseline, and archive/restore retain native admission
and explicit stop-and-archive confirmation.

## Measurements

Backend measurements on the existing 2,379-record history:

| Operation | Previous implementation | Optimized implementation |
| --- | ---: | ---: |
| First 32 title reads | 4.03 s | 2.39 s |
| Corpus enumeration | Twice at opening, again for every title batch | Once per refresh |
| Reconstruct retained catalog rows and recent titles | Discarded on close | 10 ms |
| History reads for those unchanged titles after revision validation | Repeated | 0 |

A separate real-terminal stress test seeded 2,379 isolated persisted
conversations and exercised the complete installed profile:

| Measurement | Result |
| --- | ---: |
| Initial panel frame | 51 ms |
| First cold title | 1,890 ms |
| All initial titles available | 10,276 ms |
| Reopen with retained names visible | 176 ms |

That terminal test also filtered to the oldest retained conversation, completed
background revision validation, resized from 110 to 40 columns, and exited
cleanly. A second PTY test used a temporary copy of the reported real session
and its stale-null checkpoint, confirming that its name appears in the list
before opening any detail.

The native JSONL catalog enumeration still takes roughly two seconds on the
existing history. It now runs after the panel paints. A fresh command/persistence
lifetime must validate previously unread histories; reuse is deliberately scoped
to the native revision contract, which does not promise comparable revisions
across persistence instances or process restarts. A faster first-ever cold
catalog requires an upstream durable index with a freshness contract.

## Verification and acceptance

The full deterministic gate passed: build, typecheck, lint, agent documentation,
screenshot freshness, example checks, package checks, 3,764 tests passed (seven
skipped), 100% per-file executable-source coverage, and headless happy smoke.

Regression coverage includes stale/null/empty/obsolete titles, actual cold JSONL
reads, single enumeration, four-worker bounds, immediate opening, warm reopen,
changed/deleted revisions, storage replacement, source/header incompatibility,
live title updates, close during reads, action/publication ordering, exact lead
Agent replacement, and cleanup. The existing width scan covers the rows and
detail sheets with long Unicode text and narrow terminal sizes.

The dedicated profile remains `mayfly-session-management`. Restart it to load
the rebuilt code; the isolated pinned CLI is available from this worktree:

```sh
.artifacts/session-review-cli/node_modules/.bin/dsh --profile mayfly-session-management
```

Human acceptance:

1. Open `/sessions`. The panel should appear immediately and recover cold names
   as needed. Close and reopen it: retained names should appear immediately
   while revisions refresh in the background.
2. Rename a live conversation, then check its listing. Change a saved session
   from another process and use All sessions; only changed histories should
   need new title reads.
3. Type a search draft or list filter during loading. Verify it survives title
   publication, and open a root/child detail to check full identity and current
   native facts.
4. Check a narrow terminal, close/reopen during loading, and archive/restore.
   Explicit stop-and-archive confirmation and lead-session ownership must still
   apply.

Keep the worktree and profile until acceptance. No merge is part of this audit.

## Native references

- [Session query](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/session-query)
- [Session title](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/session-title)
- [Session projection](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/session-projection)
- Installed `ApiSessionList`, `SessionProjectionCache`, `SessionPersistence`,
  JSONL persistence, `readColdSessionLog`, and `foldSessionTitle` implementations
  and their public contracts on the pinned Harness line.
