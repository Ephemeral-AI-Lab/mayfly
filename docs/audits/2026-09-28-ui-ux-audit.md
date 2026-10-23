# Mayfly UI/UX audit report

Audit baseline: `27bc1885c4b59268eb5b972a30f71bbb902fb1f8`. Report date:
2026-09-28. This report is an audit record of that commit; it does not define
the current API and does not indicate fixes were implemented.

## Conclusion

Mayfly's core interaction machinery is sound — key hints are generated from the
same binding list that dispatches input, width handling goes through
grapheme-aware helpers, confirmations default to a focused No, and async flows
fence stale results consistently. The problems concentrate at the edges:
user-facing flows that dead-end (plugin market, provider setup), a large and
actively drifting localization gap for zh users, and a set of small but visible
data/layout defects in panes and the status footer.

Fix the high-severity items first: two plugin-market dead ends (UX-01, UX-02),
the locale registration race that errors on every startup and can silently
revert the whole UI to English (UX-03), a stale catalog reported as refreshed
(UX-04), and the localization coverage gap (UX-05, UX-06). Then the CJK
ghost-hint overflow and panel clipping that corrupt the frame (UX-15, UX-16),
the pane data errors (UX-09 – UX-13), and the interaction inconsistencies
(UX-20 – UX-25). The redundancy and performance items (UX-31 – UX-36) are
drift traps and hot-path costs that grow with session length.

This record lists 36 issues: 6 high, 17 medium, 13 low. Severity indicates the
order of work, not a security rating. Issues marked "suspected" are proven at
the code level but depend on runtime conditions the audit could not execute.

## Method

Eight parallel read-only auditors covered: status bar and panes; key grammar;
copy and localization; layout and width; overlays, forms, and choice dialogs;
loading performance; transcript and conversation display; commands, onboarding,
and provider flows. Every finding was required to cite exact file:line evidence
from source; a second pass re-verified all citations against the baseline
commit before inclusion. No verification gates were run — this is a
documentation-only deliverable.

## Issue index

### [Flows and localization](2026-09-28-ui-ux-audit-flows-and-localization.md)

| # | Title | Severity | Status |
| --- | --- | --- | --- |
| UX-01 | Plugin "Update / repair" action always fails | high | substantiated |
| UX-02 | `/plugin info <id>` panel has dead Install/Remove/Update actions treated as silent success | high | substantiated |
| UX-03 | Locale namespace registration race — 11 plugins register `interaction`, 10 throw on every startup | high | substantiated |
| UX-04 | Stale plugin catalog reported as "refreshed", with no staleness indication | high | substantiated |
| UX-05 | ~80 zh catalog keys missing — entire surfaces fall back to English | high | substantiated |
| UX-06 | Many user-visible strings bypass `t()` entirely (hardcoded English) | high | substantiated |
| UX-07 | Dead and drifted locale catalog entries (~146 unused keys) | medium | substantiated |
| UX-08 | Inconsistent zh terminology; duplicated hint vocabulary across two catalogs | medium | substantiated |

### [Data and layout](2026-09-28-ui-ux-audit-data-and-layout.md)

| # | Title | Severity | Status |
| --- | --- | --- | --- |
| UX-09 | Agents pane miscounts members and paints failures as success | medium | substantiated |
| UX-10 | A cut turn leaks the agents pane's 250 ms tick; cancelled member's clock keeps counting | medium | substantiated |
| UX-11 | Slow/failing git status probe renders a dirty repo as a clean synced branch | medium | substantiated |
| UX-12 | Settings selects leak raw JSON ids; multiselects hide stale values that still fail validation | medium | substantiated |
| UX-13 | Goal status leaks internal enums, unit-less fractions, and conflicting tones | medium | substantiated |
| UX-14 | Miscellaneous formatting and display errors (pluralization, durations, `[image]` duplication, stale provider list, wrong clear-key message) | low | mixed (2 sub-items suspected/dormant) |
| UX-15 | Subagent panel's title rule clipped with a 2-row status footer or open lanes | medium | substantiated |
| UX-16 | Ghost-hint width math uses UTF-16 code units, not display columns (CJK overflow) | medium | substantiated |
| UX-17 | Todo rows wrap while siblings truncate; expanded list unbounded | low | substantiated |
| UX-18 | Inconsistent overflow indicators across lanes and chrome | low | substantiated |
| UX-19 | ScrollablePanel has no scroll affordance and vanishes below width 5 | low | partial suspected |

### [Interaction and usability](2026-09-28-ui-ux-audit-interaction-and-usability.md)

| # | Title | Severity | Status |
| --- | --- | --- | --- |
| UX-20 | Ctrl+C is dead in the Ctrl+E expanded view and the readonly subagent transcript panel | medium | substantiated |
| UX-21 | Esc labeled "close" loops forever over a dirty-form confirmation | medium | substantiated |
| UX-22 | Filter queries cannot start with a digit; the 1-N hint counts inert digits | low | substantiated |
| UX-23 | Same action named two ways on visible surfaces; stale and malformed key labels | low | substantiated |
| UX-24 | Selection semantics diverge across marker styles, Other text, and confirmation lifetime | low | substantiated |
| UX-25 | Same-class destructive confirmations carry three warning levels | low | substantiated |
| UX-26 | Silent dead ends in read-only settings, `/permission`, and DeepSeek key rotation | medium | substantiated |
| UX-27 | First-run onboarding is a bare env-var secret field; custom endpoints require an API key | medium | substantiated |
| UX-28 | Autocomplete has no loading indication for `#` skills or `@`-mention scans | low | substantiated |
| UX-29 | Provider wizard Save fails validation on a hidden tab | low | substantiated |
| UX-30 | Confusing chrome and jargon: Refresh on static panels, raw namespace ids, cryptic badges | low | substantiated |

### [Redundancy and performance](2026-09-28-ui-ux-audit-redundancy-and-performance.md)

| # | Title | Severity | Status |
| --- | --- | --- | --- |
| UX-31 | `AgentGroupComponent` is a dead, drifted duplicate of the agents pane | medium | substantiated |
| UX-32 | Duplicated implementations with drift risk (validation, locale, streaming, tokens) | low | substantiated |
| UX-33 | `@`-mention completion rescans the whole directory tree per keystroke; sync `statSync` per symlink | medium | substantiated |
| UX-34 | UI compiler re-walks the control tree 3–4× per keystroke; spatial navigation costs two full renders | medium | substantiated |
| UX-35 | Overflow log does synchronous writes on the render path and goes silent after 200 entries | low | substantiated |
| UX-36 | Unthrottled status hot paths re-run queries on every job output chunk and stream delta | low | substantiated |

## Verified healthy (no action needed)

Key hint/dispatch unity (hints and dispatch share one binding list), Escape
ladder ordering, reserved-key validation, grapheme-aware width handling via
pi-tui, footer band layout and caching, render scheduling, streaming batching
and backpressure, confirmation defaults (No-focused, danger intent),
generation/abort fencing on async flows, plugin installer transactional
rollback, and the `/update` panel lifecycle.
