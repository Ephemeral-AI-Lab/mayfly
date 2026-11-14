# Mayfly UI/UX audit: redundancy and performance

Audit baseline: `27bc1885c4b59268eb5b972a30f71bbb902fb1f8`. Report date:
2026-09-28. This record covers duplicated implementations with drift risk and
hot-path performance defects in `packages/mayfly`: a dead agents-pane
duplicate, copy-pasted validation/locale/streaming/token logic, per-keystroke
filesystem work in `@`-mention completion, repeated full-tree reconciliation
in the UI compiler, the overflow telemetry sink, and unthrottled status
refresh paths. Severity indicates the order of work, not a security rating.
This is an audit record of that commit; it does not indicate fixes were
implemented.

## UX-31: AgentGroupComponent is a dead, drifted duplicate of the agents pane

- Severity: medium
- Category: redundant implementation
- Status: substantiated

### Symptom
Nothing user-visible today — that is the problem. The 422-line
`AgentGroupComponent` renders a grouped subagent run that no live surface ever
shows; the real agents pane renders its own, newer version of the same UI.
Any contributor editing "the agent group view" can land changes in the dead
copy and see tests pass while the product never changes.

### Root cause
`packages/mayfly/src/transcript/agent-group.ts:164` exports
`AgentGroupComponent`, re-exported from the public transcript barrel at
`packages/mayfly/src/transcript/index.ts:48`. Its module docstring
(`agent-group.ts:4-6`) claims `pane-agents.ts` "mounts the first member and
attaches the remaining same-step members", but `pane-agents.ts` only imports
types from it (`packages/mayfly/src/transcript/pane-agents.ts:59`, also
`child-agent-model.ts:9`); the class is instantiated only in tests
(`packages/mayfly/tests/transcript/agent-group.spec.ts:104` and throughout,
`packages/mayfly/tests/transcript/width-scan.spec.ts:405`). The two
implementations have already drifted:

- The live pane maps an unanswered spawn call from a finished turn to a
  `cancelled` phase (`pane-agents.ts:140`); the dead copy's phase unions have
  no `cancelled` state (`agent-group.ts:103`, `:48`).
- The dead copy hardcodes English: `` `Running ${total} agents` ``
  (`agent-group.ts:304`), `` `${total} agents finished` `` (`:314`),
  `'(no description)'` (`:237`), `` `Error: ${errLine}` `` (`:350`).
- It carries its own token formatter `formatTok` (`agent-group.ts:123-132`),
  explicitly documented as "the usage.ts `formatTokens` twin"
  (`agent-group.ts:123`) — a third copy of the formatter that also exists at
  `interaction/usage.ts:60-68` and `transcript/status-context.ts:68-76`.

### User impact
No direct user impact; the cost is maintenance. The dead component pins test
time, width-scan coverage, and reviewer attention, and its stale docstring
actively misdescribes how the live pane works. Any future fix applied to it
(for example the cancelled-phase handling the real pane already has) silently
does nothing.

### Suggested fix
Delete `agent-group.ts` and its two spec files, moving `AgentLiveLookup` /
`AgentMemberLive` (the only pieces `pane-agents.ts` and `child-agent-model.ts`
actually consume) into `pane-agents.ts` or a small shared types module, and
drop the export at `transcript/index.ts:48`. If the class is meant to become
the pane's renderer instead, do the opposite: make `pane-agents.ts` mount it,
port the `cancelled` phase and locale routing first, and delete
`formatTok` in favor of the shared `formatTokens`. Either way, keep exactly
one implementation.

## UX-32: Duplicated implementations with drift risk across validation, locale, streaming, and token logic

- Severity: low
- Category: redundant implementation
- Status: substantiated

### Symptom
Several single-purpose helpers and their message strings exist twice (or
three times) in the same package. They agree today, so users see nothing yet —
but two of the pairs (command descriptions, locale catalogs) have already
drifted, which is how the others will fail.

### Root cause
Five independent copies, each verified against source:

- **Selection validation, twice.** `choiceError`
  (`packages/mayfly/src/core/ui-interaction-choice.ts:362-371`) and the
  select/multiselect branch of `fieldError`
  (`packages/mayfly/src/core/ui-interaction-form.ts:256-262`) re-implement the
  same unavailable-option and min/max checks with byte-identical message
  strings: `'A selected option is unavailable'` (`ui-interaction-choice.ts:368`
  / `ui-interaction-form.ts:258`), `'Select at least {count} options'`
  (`:364` / `:260`), `'Select at most {count} options'` (`:365` / `:261`).
  A wording fix in one leaves the other stale.
- **Fallback interpolator, twice.** `untranslated`
  (`packages/mayfly/src/core/ui-interaction-locale.ts:9-11`) and
  `interpolateLocaleMessage`/`interpolate`
  (`packages/mayfly/src/frontend/locale.ts:199-208`) use the identical
  placeholder regex `/\{([A-Za-z][A-Za-z0-9_]*)\}/gu` with identical
  semantics. If placeholder syntax ever changes, one copy will be missed.
- **Streaming-window marker, twice.** `streamingTextWindow`
  (`packages/mayfly/src/transcript/thinking.ts:30-35`) and `streamingWindow`
  (`packages/mayfly/src/transcript/components.ts:117-122`) are
  character-identical bodies, including the user-visible
  `... (N earlier characters)` marker. A copy edit (e.g. translating the
  marker) must be made twice or the thinking block and the answer block
  diverge mid-stream.
- **`contextTokens`, twice.** Exported from
  `packages/mayfly/src/transcript/status-context.ts:46-48` and re-derived
  privately in `packages/mayfly/src/conversation/facts.ts:80-82` — same
  formula (`inputTokens + cacheRead + cacheWrite`). A change to what counts
  as occupied context (say, subtracting cache reads) would desynchronize the
  footer readout from the facts projection. The related `formatTokens` is
  likewise duplicated between `status-context.ts:68-76` and
  `interaction/usage.ts:60-68` (plus the third copy in UX-31).
- **Command descriptions drifted from their orphaned translations, already
  broken.** Descriptions are translated at display time
  (`commands-plugin.ts:107`, `editor-plus.ts:121`), so the catalog key must
  equal the registered string — but several registrations were reworded
  without updating the catalog: `/provider` registers
  `'Configure providers or choose their models'`
  (`provider-commands.ts:31`) while the translation sits under the old
  `'List providers, switch the route, or add one'` (`locale.ts:273`);
  `/settings` registers `'Edit user settings by namespace'`
  (`settings-command.ts:142`) while the catalog holds the long parenthetical
  variant (`locale.ts:264`); `/changelog`'s
  `"Show the release changelog (what's new)"` (`session-commands.ts:58`) and
  `/theme`'s `'Switch the color theme'` (`theme-switch.ts:148`) have no key
  at all; the settings labels `'Work details'` (`settings-model.ts:13`) and
  `'Plugin market index'` (`settings-model.ts:16`) replaced the orphaned
  `'Transcript detail'` (`locale.ts:193`) without adding their own keys.
  zh users see English here and the dead translations mislead future
  translators.

### User impact
The first four items are latent: any edit to one copy produces inconsistent
validation messages, placeholder handling, stream markers, or token math
between sibling surfaces. The fifth is live today: Chinese-locale users get
English descriptions for `/provider`, `/settings`, `/changelog`, `/theme`,
and two settings labels.

### Suggested fix
Collapse each pair to one owner: export a shared selection-validation helper
used by both `choiceError` and `fieldError`; keep one interpolator
(`frontend/locale.ts` importing or re-exporting the core one); extract the
streaming-window helper into one module imported by `thinking.ts` and
`components.ts`; import `contextTokens` in `status-context.ts` from
`conversation/facts.ts` (or vice versa) and keep a single `formatTokens`. For
the descriptions, make the registered string and the catalog key the same
constant — either register the existing catalog wording or update the keys —
and add the missing keys for `/changelog`, `/theme`, and the two settings
labels, deleting the orphaned entries.

## UX-33: @-mention completion rescans the whole directory tree per keystroke and stats symlinks synchronously

- Severity: medium
- Category: slow loading
- Status: substantiated

### Symptom
On a machine without the `fd` binary, typing an `@` file mention in a large
project makes the autocomplete dropdown lag visibly behind typing; opening a
directory full of symlinks (e.g. `~/.local/bin`) can briefly freeze the editor.

### Root cause
Two compounding defects on the per-keystroke autocomplete path
(`packages/mayfly/src/interaction/editor-plus.ts:166-198`, invoked by pi-tui
0.84.2 with only a 20 ms debounce —
`ATTACHMENT_AUTOCOMPLETE_DEBOUNCE_MS = 20` in pi-tui's
`dist/components/editor.js:169`, applied at `:1887`):

- **Uncached full-tree fallback scan.** When `fd` is absent
  (`fdPath === null`, `editor-plus.ts:180`) or the path form is unsupported,
  the editor calls `fsMentionSuggestions` (`editor-plus.ts:190`), which calls
  `collectFsMentionCandidates` fresh on every query
  (`packages/mayfly/src/interaction/file-mention.ts:243`). That function is a
  depth-first walk of the project root capped at
  `MAX_FALLBACK_SCAN = 2000` entries (`file-mention.ts:29`, loop at
  `:110-145`) with no result caching between keystrokes: each 20 ms typing
  pause restarts the entire walk and re-ranks all candidates
  (`file-mention.ts:245`).
- **`statSync` per symlink on the same input path.** The one-level listing
  behind a bare `@` or directory drill-down, `listDirectoryMentions`
  (`file-mention.ts:282-329`, called for every `@`-token at
  `editor-plus.ts:178`), resolves each symlink with a synchronous
  `statSync(join(resolved, entry.name))` (`file-mention.ts:309`) inside the
  autocomplete task chain. The sibling scanner in the same file does the same
  check asynchronously (`await stat`, `file-mention.ts:134`), so the two
  mention backends also disagree on I/O discipline.

### User impact
Anyone on a system without `fd` (fresh installs, minimal containers, Windows)
completing files in a large tree: the dropdown stutters or falls a second
behind, and a symlink-heavy directory adds a blocking syscall burst to every
drill-down keystroke. The walk is abortable and capped, so this is lag, not a
hang — but it hits exactly the least-provisioned environments.

### Suggested fix
Cache the fallback scan: memoize `collectFsMentionCandidates` per
`(root, platform)` with a short TTL or fs-event invalidation, so a query
change re-ranks the cached candidate list instead of re-walking; scope the
walk to the typed base directory (`resolveMentionBase` output) rather than the
project root when the token carries a path prefix. Replace the `statSync` at
`file-mention.ts:309` with the same `await stat` pattern used at `:134`
(the listing function is already async). Raising the debounce or adding a
minimum-query length for the fallback path would further cut walk frequency.

## UX-34: UI compiler re-walks the control tree several times per keystroke; spatial navigation costs two full renders

- Severity: medium
- Category: slow loading
- Status: substantiated

### Symptom
In heavy interaction surfaces (large forms, long pickers), every keystroke and
every arrow key does several times the tree work it needs to; on low-power
hardware this shows up as input latency in exactly the panels that already
have the most content.

### Root cause
Two mechanisms in `packages/mayfly/src/core/ui-compiler.ts`:

- **Repeated uncached reconciliation.** `reconcile(state)` (`:1269`) performs
  two full tree walks per call — `state.controls()` (`:1270`) and
  `state.allControls()` (`:1274`) — and both are defined as fresh
  `controlsForNode(...)` traversals (`:1460-1461`) with no memoization. Every
  walk rebuilds all control descriptors, whose identity keys are
  `JSON.stringify(...)` products (`:659`, `:667`, `:671`, `:675`), and each
  list node computes its window twice in one walk
  (`listWindow(current, listRowLimit(options))` at both `:964` and `:965`).
  `reconcile` then runs from `handleInput` (`:2119`), again inside `moveTo`
  (`:2143`), again on several intent paths (`:2173`, `:2223`, `:2328`), and
  from the render path (`:861`) — three to four double-walks per keystroke.
- **Arrow-key spatial navigation renders the tree twice.** When an arrow key
  falls through to directional navigation, `navigate` calls
  `controlRectangles` (`:2287`), which synchronously calls
  `this.root.render(width)` (`:2084`) and then
  `renderLayoutFrame(this.root, width, height, ...)` (`:2092`) purely to
  measure geometry — bypassing the `renderFrameOnce` memo (`:1996-2009`).
  `handleInput` has already invalidated that memo (`:2115`), so the repaint
  that follows re-renders the tree again: two full tree renders plus a layout
  pass per arrow key.

### User impact
Users with large surfaces open — settings with many fields, long plugin or
session pickers — on slower machines: per-key cost scales with total control
count rather than visible rows. Bounded by tree size and the row-limited
window, so small forms are unaffected; this is a scaling defect, not a
correctness one.

### Suggested fix
Memoize `controls()`/`allControls()` per snapshot revision so `reconcile`'s
two walks — and the repeat calls from `handleInput`/`moveTo`/intent paths —
share one descriptor array; compute `listWindow` once per list node and reuse
it for both the empty check and the row loop (`:964-965`). For spatial
navigation, cache the geometry map alongside the frame memo (invalidate on
the same key as `frameResult`) so `controlRectangles` reuses the render the
repaint will do anyway, instead of rendering off-memo.

## UX-35: Overflow log does synchronous writes on the render path and goes permanently silent after 200 entries

- Severity: low
- Category: data error
- Status: substantiated

### Symptom
`mayfly-overflow.log` — the telemetry that records width-contract violations —
stops recording anything new once 200 distinct lines have been logged, for the
rest of the process lifetime. A width regression that appears late in a long
session leaves no trace, and while a misbehaving component is on screen each
new distinct over-wide row costs two synchronous filesystem calls mid-render.

### Root cause
`createFileOverflowSink` (`packages/mayfly/src/core/frame-clamp.ts:127-144`)
keeps an in-memory `seen` set and bails out forever once it fills:
`if (seen.size >= maxEntries || seen.has(entry.line)) return`
(`frame-clamp.ts:132`), with `maxEntries` defaulting to 200
(`frame-clamp.ts:113-114`, `:128`). There is no rotation, reset, or expiry —
the cap was designed against flooding (renders repeat at 16 ms) but is
enforced on *distinct* entries, so the 201st distinct violation is silently
dropped. Each admitted entry is written with `mkdirSync` + `appendFileSync`
(`frame-clamp.ts:135-139`) directly inside `record`, which runs from
`clampFrame`/`clampFrameFrom` on the render path — wired as the default sink
at `packages/mayfly/src/core/terminal.ts:567` and invoked from the frame
seams at `terminal.ts:132`, `:325`, `:836`, `:842`. Failures are swallowed by
design (`frame-clamp.ts:140-142`).

### User impact
Two groups: end users hitting a late-appearing width bug in a long session —
the clamp still protects the frame, but the diagnostic log the team relies on
to find the offending component never records it; and anyone running with an
over-wide component on screen, who pays small synchronous I/O bursts inside
frame rendering. The sync-write cost is minor in practice (only distinct
clamped lines write); the permanent silence is the real defect.

### Suggested fix
Make the cap a window rather than a fuse: when `seen` reaches `maxEntries`,
evict (e.g. clear the set and log one "cap reached, dedupe restarted" line),
or rotate the file at a size bound, so late violations still record.
Buffer writes and flush them off the render path (append to an in-memory
queue drained by a timer or idle callback), keeping the never-throw contract
at `frame-clamp.ts:140-142`.

## UX-36: Unthrottled status hot paths re-run queries on every job output chunk and stream delta

- Severity: low
- Category: slow loading
- Status: substantiated

### Symptom
A chatty background job or a fast model stream triggers redundant service
queries behind the status footer far more often than the footer can change —
wasted work on the exact paths that fire most.

### Root cause
Two status contributions recompute on every raw event and gate only the
publish:

- `mayfly-status-jobs` subscribes to all job events including `output`
  (`packages/mayfly/src/transcript/status-jobs.ts:44-48`; the owner check at
  `:45` explicitly handles `event.type === 'output'`), and `refresh()` runs
  `ctx.jobs.list(agent.id)` (`status-jobs.ts:31`) on every matching event.
  A background job streaming output therefore triggers one full job listing
  per output chunk; only the footer publish is text-gated
  (`status-jobs.ts:36`).
- `mayfly-status-mode` subscribes to `session/event`
  (`packages/mayfly/src/interaction/mode-status.ts:44-46`) and re-reads the
  projection snapshot via `sessionModeSnapshot(ctx, agent)`
  (`mode-status.ts:20`) on every session event for the current agent —
  including every streaming delta — with only a JSON-signature gate before
  republish (`mode-status.ts:38-39`). Plan/yolo mode cannot change mid-delta,
  so virtually all of these re-reads are provably no-ops.

### User impact
No visible defect; the cost is CPU and service-call churn proportional to
stream/job volume rather than to state changes. Individually cheap, but both
fire on the hottest event streams in the app and scale with session length
and job chatter.

### Suggested fix
Narrow the triggers to state-changing events: in `status-jobs`, refresh only
on lifecycle events (queued/started/completed/killed/failed) and skip
`output` — the count cannot change there; in `mode-status`, filter
`session/event` to the event types that can alter plan or yolo state (or
subscribe to the projection's own change notification instead of the raw
stream). A trailing-edge throttle on `refresh` is a fallback if the event
taxonomy cannot express the distinction.

## Verification notes

- Every file:line citation above was re-checked against the source at the
  baseline commit during report writing; two citations from the raw findings
  were corrected (the pi-tui debounce constant lives in pi-tui's
  `dist/components/editor.js:169`, not `editor.js`; `choiceError` spans
  `ui-interaction-choice.ts:362-371`, not `:362-370`).
- The 20 ms autocomplete debounce was confirmed in the pinned pi-tui 0.84.2
  build (`packages/mayfly/package.json:209`).
- No runtime code was modified for this record; no verification gates were
  run, since the deliverable is documentation only.
