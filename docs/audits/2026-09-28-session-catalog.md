# Session catalog review, 2026-09-28

Scope: the pinned Harness `0.1.7-rc.2` persistence/query/controller contracts and
Mayfly's `/sessions` listing, filtering, content search, detail reads, root/child
navigation, archive admission, cancellation, and unload. This review does not
change Harness storage or regenerate user titles.

## Findings and changes

| Finding | Cause | Resolution |
| --- | --- | --- |
| Untitled conversations all displayed `session-`. | `sessionLabel` took the first eight characters of native `session-<uuid>` IDs. The test explicitly expected the shared prefix. | Strip the native prefix before abbreviating. Preserve the complete ID in filtering and the detail sheet. |
| Existing saved titles appeared as `Untitled`. | Native `list()` carries partial cached projection hints. Missing cells and cached values (including `null`) can precede later title events; listing deliberately does not replay cold logs. Mayfly never performed a title read. | Read missing/empty titles and every cold cached title through `sessionQuery.readTitleSnapshots`, in batches of 32. Show cached hints immediately, then prefer the logged title read; an exact detail baseline takes precedence over both. |
| Cold sessions showed an invented `0s` duration and creation time as last activity. | Native `updatedAt` falls back to `header.createdAt` when the list metadata cache is absent. | Use explicit prompt/settlement times, running state, or an `updatedAt` later than creation. Otherwise label the creation age and leave duration/last activity unknown. |
| Detail sheets repeated incomplete or stale listing hints. | The detail sheet reused the catalog's captured facts without an authoritative read. | Read `sessionController.projections` for the selected session. Missing/unreadable sessions produce feedback; reading never resolves or activates an Agent. |
| Content matches could lose identity and become unselectable. | Search rows dropped status and ID/path search metadata, and the catalog was not reconciled when a match was created after opening the panel. | Preserve status and searchable ID/path/snippet; refresh the catalog when search returns a previously unlisted session. |
| Late child reads could navigate after close or after lead replacement. | `listDescendants` used the whole catalog lifetime and did not recheck the exact lead Agent after awaiting. | Use the detail action signal, recheck cancellation and exact Agent identity, then open the child through the native descendant address. |
| The current badge pointed at the primary Agent while viewing a live child. | The catalog compared with `primary()` instead of `current()`. | Compare with the exact currently selected Agent. |

Recovery belongs to the panel lifetime. Refresh supersedes the previous title
read; close/unload abort it. Title publication waits for a pending shared action
to settle so that an asynchronous data refresh cannot cancel a content search
or replace its acknowledgement. Form drafts survive ordinary data refreshes.
Archive/restore continue to use native Workspace admission and the existing
explicit confirmation for stopping activity.

## Native contracts checked

- [`session-query`](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/session-query):
  complete live-preferred listing, bounded batch title inspection, per-session
  read failures, and cancellable observations.
- [`session-title`](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/session-title):
  logged titles, the string-or-null wire projection, and explicit title ownership.
- [`session-projection`](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/session-projection):
  readonly values, partial cached hints, and exact observations.
- The installed controller's `ApiSessionList.projectionsFor`, `updatedAt`,
  `search`, and `SessionController.projections` implementations. Cold listing
  reads cache hints only; its complete projection read uses a disposable query
  observation without Agent activation. Content search is bounded and exposes
  `hasMore`; the panel retains its instruction to narrow such a query.

## Verification and acceptance

Regression coverage includes generated IDs, cached/absent titles, unknown and
known activity times, batch sizes, draft preservation, per-session title errors,
refresh supersession, close during each async read, search publication ordering,
missing/corrupt details, and replacement of the lead Agent with the same ID.
A real JSONL persistence/query test stores a title in a cold session, recovers it
in the catalog and detail sheet, and checks that neither the live Session store
nor Agent registry grows. The existing width scan covers session rows and detail
sheets, including narrow terminals and long Unicode text.

Initial automated verification passed: `verify:full` with the pinned rc.2 CLI;
3,735 tests passed, seven skipped, and every executable source file met 100%
coverage. Build, typecheck, lint, screenshot freshness, example checks, and the
headless happy smoke passed. A PTY smoke using real cold persisted conversations
passed title recovery, distinct untitled IDs, detail projection reads, 110/40
column rendering, close/reopen, and clean exit. Human acceptance is pending.

The first human acceptance found a missed stale-null case: a saved checkpoint
contained `title: null` at seq 4 while the durable log contained a title at seq
20. The initial recovery skipped null hints, and the row model would also let a
cached null mask a recovered title. Both conditions are corrected. Regression
cases now cover absent, null, empty, and obsolete nonempty cache values against
real cold JSONL reads, asserting that the title appears before any detail read.
The follow-up `verify:changed -- --base HEAD` gate passed 3,483 tests (seven
skipped), with 100% coverage of both changed implementations. A PTY using a
temporary copy of the reported session and its unchanged stale checkpoint
confirmed the name appears in the catalog before opening any detail, at 110
and 40 columns and after close/reopen.

The system CLI was rc.1 during this review. From this worktree, the isolated
pinned CLI is available without changing the system installation:

```sh
.artifacts/session-review-cli/node_modules/.bin/dsh --profile mayfly-session-management
```

Human acceptance uses the dedicated `mayfly-session-management` profile:

1. Open `/sessions` against an existing session history. Saved titles should
   appear as recovery completes; genuinely untitled sessions should have
   distinct abbreviated IDs. Missing activity metadata must not imply `0s`.
2. Type a content-search draft while titles load, then search. The draft and
   result snippets must survive; filter by full ID/path and open a result.
3. Open a session detail and check title, times, tokens, model, and full ID.
   Resume a root; open a child under its lead; switch back to the primary.
4. Exercise a narrow terminal, close/reopen while reads are pending, and check
   archive/restore and the explicit stop-and-archive confirmation.

Keep the worktree and profile until acceptance. No merge is part of this review.
