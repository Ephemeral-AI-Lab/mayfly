# Mayfly UI/UX audit: interaction and usability

Audit baseline: `27bc1885c4b59268eb5b972a30f71bbb902fb1f8`. Report date:
2026-09-28. This section covers UX-20 through UX-30: key dispatch and hints,
choice and confirmation semantics, onboarding and provider setup, and command
chrome in `packages/mayfly`. Severity indicates the order of work, not a
security rating. This record is an audit of that commit; it does not indicate
fixes were implemented. Every file:line citation below was re-verified against
the source at the baseline.

## UX-20: Ctrl+C is dead in the Ctrl+E expanded view and in the readonly subagent transcript panel

- Severity: medium
- Category: inconsistent interaction
- Status: substantiated

### Symptom
In the Ctrl+E full-screen expanded view of a surface, pressing Ctrl+C does
nothing — no close, no collapse, no feedback — even though
`docs/interaction-model.md:37` states that inside a surface Ctrl+C requests
the same close as the outermost Escape. While viewing the readonly subagent
transcript panel, Ctrl+C is equally inert: it does not clear a draft, request
an interrupt, or arm the double-press exit, although it does all three
everywhere else in the app.

### Root cause
Two separate dispatch gaps.

1. `keyGrammar()` early-returns the expanded-state binding list at
   `packages/mayfly/src/core/ui-key-grammar.ts:255-261`: collapse bindings for
   Ctrl+E/Esc, scroll keys, and a terminal `{ kind: 'any' } → swallow` at
   `:259`. The function returns before the `closable` branch pushes the
   Ctrl+C→close binding at `:265`, so in an expanded closable overlay Ctrl+C
   hits the catch-all swallow and is discarded. The doc's own binding-order
   summary (`docs/interaction-model.md:50-51`) lists only "collapse, scroll,
   swallow everything else" for this state, so code and the prose contract at
   `:37` disagree.
2. The readonly panel is mounted as an editor replacement in the
   `conversation` layer (`packages/mayfly/src/interaction/session-transcript-panel.ts:213`
   via `packages/mayfly/src/core/screen.ts:210-214`), which swaps out the host
   editor whose `onKey` chain implements Ctrl+C clear/interrupt/double-press
   exit (`packages/mayfly/src/interaction/input-plugin.ts:582-595`). The
   panel's own `handleInput` matches only cancel and scroll keys
   (`packages/mayfly/src/core/scrollable-panel.ts:40-53`). The conversation
   layer deliberately does not capture input (`screen.ts:198-200`), so the key
   falls through to the global dispatcher
   (`packages/mayfly/src/core/index.ts:157-159`) — but
   `MayflyKeymapService.dispatch` only invokes actions registered with a
   handler (`packages/mayfly/src/core/keymap.ts:136-145`), and
   `ACTION_INTERRUPT` is registered handlerless in the interaction batch
   (`packages/mayfly/src/interaction/keys.ts:43-70`, entry at `:53`). No
   remaining path handles the key.

### User impact
Anyone who reaches for Ctrl+C out of habit — to interrupt a running turn, or
to exit via double-press — while reading expanded content or a subagent
transcript gets no response and no hint why. The expanded-view half also
contradicts the published interaction spec, so it reads as a bug even to
users who know the contract.

### Suggested fix
In the expanded branch of `keyGrammar()` (`ui-key-grammar.ts:255-261`), push a
binding for `ACTION_INTERRUPT` before the swallow — preferably the same
`close` intent as the outermost Escape, at minimum `collapse`. For the panel,
either give `ScrollablePanel` an opt-in interrupt binding or register a
handler-carrying `ACTION_INTERRUPT` while the readonly panel is shown, so the
key keeps its global semantics. If the expanded-state divergence is kept,
amend `docs/interaction-model.md:37` instead.

## UX-21: Esc labeled "close" loops forever over a dirty-form confirmation

- Severity: medium
- Category: inconsistent interaction
- Status: substantiated

### Symptom
On a dirty form, Esc opens "Discard unsaved changes?". The hint row then
reads "Esc close", but pressing Esc answers No and returns to the form;
pressing Esc again re-opens the same dialog. The key labeled "close" never
closes — only choosing Yes does. Ctrl+C follows the same loop.

### Root cause
Capturing overlays compile with `escapeHint: 'close'`
(`packages/mayfly/src/core/surface-renderer.ts:363` and `:404`). While a
decision is open, `backTarget()` returns undefined
(`packages/mayfly/src/core/ui-interaction-surface.ts:442-443`), so the escape
step in `grammarStateFor` falls through to the surface's `escapeLabel` —
`close` (`packages/mayfly/src/core/ui-compiler.ts:769-774`) — and the grammar
advertises "Esc close" (`packages/mayfly/src/core/ui-key-grammar.ts:262-264`
with `ESCAPE_LABEL` at `:124-126`). But `emit('dismiss')` with an open
decision calls `answerDecision(false)`
(`ui-interaction-surface.ts:455-458`), and the next dismissal of the still-
dirty form re-arms the same decision in `requestClose()`
(`ui-interaction-surface.ts:613-618`). The Ctrl+C close intent
(`ui-key-grammar.ts:265` → `ui-compiler.ts:2307` → the same `onEscape` →
`dismiss`) takes the identical path, so both keys cancel-then-rearm forever.

### User impact
Keyboard users backing out of an edited form (settings, provider editor, any
dirty surface) are trapped in a dialog that advertises an exit it never
takes. The only escape is reading the dialog and choosing Yes — the opposite
of what the hint promises.

### Suggested fix
Make the escape layer decision-aware: add a decision-open case ahead of the
`escapeLabel` fallback in `grammarStateFor` (`ui-compiler.ts:769-774`) that
emits a truthful hint (e.g. "Esc cancel", with a matching `ESCAPE_LABEL`
entry in `ui-key-grammar.ts:124-126`). Do not change the No-answer semantics
— relabeling is the safe fix.

## UX-22: Filter queries cannot start with a digit in numbered lists; the 1-N hint counts inert digits

- Severity: low
- Category: unfriendly interface
- Status: substantiated

### Symptom
In a numbered, filterable list, typing a query that begins with a digit
selects a row instead of filtering: typing "2024" picks row 2 and never
starts a search. The visible hints ("1-9 choose", "Type filter") never
mention that `/` starts a literal search that accepts leading digits.
Separately, the "1-N" hint counts visible disabled rows, yet pressing a
digit that lands on one silently does nothing.

### Root cause
`keyGrammar()` pushes the digit→numbered binding at
`packages/mayfly/src/core/ui-key-grammar.ts:278-280` ahead of the `listText`
search matcher (`:219-224`, invoked for row controls at `:300`), and dispatch
walks bindings in order, so a leading digit is always claimed by row
selection while the list is not already searching. The `/` search-start
binding exists (`:273`) but carries no hint, leaving the escape hatch
invisible. For the second half, the hint's N is
`Math.min(9, choiceVisibleCount(choice))`
(`packages/mayfly/src/core/ui-compiler.ts:788`), and `choiceVisibleCount`
counts all visible rows — visibility is filter/tree-based, not enabled-based
(`packages/mayfly/src/core/ui-interaction-choice.ts:211-213`) — while
`numbered()` returns silently when the digit resolves to a disabled item
(`ui-compiler.ts:2260-2267`).

### User impact
Anyone filtering a numbered list by a year, version, or id (sessions,
plugins, providers) gets an unintended row jump instead of a query. Users of
lists with disabled rows are promised keys that are inert, with no feedback.

### Suggested fix
Give the `/` search-start binding (`ui-key-grammar.ts:273`) a hint whenever
the list is numbered, so the literal-search path is discoverable. Compute the
advertised numbered count from enabled visible items at `ui-compiler.ts:788`,
matching what `numbered()` can actually accept.

## UX-23: The same action is named two ways on simultaneously visible surfaces; stale and malformed key labels

- Severity: low
- Category: inconsistent interaction
- Status: substantiated

### Symptom
While the readonly subagent panel is open, the status bar reads
"F7 switch · F8 close" but the panel footer reads
"F7 toggle · F8 close · Esc close": one F7 action, two names, on surfaces
visible at the same time, plus two adjacent footer fragments both labeled
"close". The todo pane footer hardcodes "ctrl+t to expand/collapse" while
sibling surfaces resolve hints from the keymap. `/help` renders "F6" next to
"Shift+f6" for the surface-focus pair.

### Root cause
Three independent label paths. (1) The status bar builds its hint through
`interactionKeyHint` with the verb "switch"
(`packages/mayfly/src/interaction/agent-view-status.ts:23`), while the panel
footer interpolates its own string with "toggle" and appends both F8 and Esc
"close" (`packages/mayfly/src/interaction/session-transcript-panel.ts:94`);
nothing shares the verb. (2) The todo pane bakes the literal `ctrl+t` into
its copy (`packages/mayfly/src/transcript/pane-todo.ts:256` and `:262`)
instead of calling `interactionKeyHint`
(`packages/mayfly/src/interaction/keys.ts:37-40`); the agent-view status also
rebuilds its node only on view changes (`agent-view-status.ts:46`), so
rebinding F7/F8 leaves stale hints there until the next switch. (3)
`displayKey` uppercases a bare function key via its `/^f\d+$/` branch but,
inside a modifier chord, a part like `f6` falls through to the length-1
fallback and stays lowercase (`packages/mayfly/src/core/key-actions.ts:62-73`);
the two actions registered at
`packages/mayfly/src/core/surface-renderer.ts:559-562` therefore render as
"F6" and "Shift+f6" in `/help`.

### User impact
Users see divergent names for one action and must infer they are identical;
a rebound Ctrl+T leaves the todo footer lying; "Shift+f6" reads like a
different key from "F6".

### Suggested fix
Centralize the agent-view hint fragments in one builder consumed by both
`agent-view-status.ts` and `session-transcript-panel.ts`, and drop or rename
the duplicate Esc "close" fragment. Route the todo footer through
`interactionKeyHint` and refresh status nodes on keymap changes. In
`displayKey`, apply the function-key uppercase to chord parts as well
(`key-actions.ts:66-72`).

## UX-24: Selection semantics diverge across marker styles, Other text, and confirmation lifetime

- Severity: low
- Category: inconsistent interaction
- Status: substantiated

### Symptom
(a) A single-select shows radio dots (● selected, blank unselected) in lists
but checkboxes ([x]/[ ]) in expanded form pickers; multi-select shows ●/○ in
lists and the same [x]/[ ] in pickers. (b) In a questionnaire, picking an
option and also typing Other text silently discards the picked option on a
single-select question; multi-select keeps both. (c) An open Yes/No
confirmation vanishes with no message when the underlying source data
changes.

### Root cause
(a) `renderList` picks the glyph per mode — selected `●`, unselected `○` only
for multiple, blank otherwise (`packages/mayfly/src/core/ui-patterns.ts:274`)
— while `renderFormField`'s expanded branch renders `[x]`/`[ ]` for select
and multiselect alike (`ui-patterns.ts:371-373`); the two painters never
agree on a single-select metaphor. (b) `questionnaireAnswer` maps a
single-select question with non-empty custom text to `selected: []`
unconditionally (`packages/mayfly/src/interaction/questionnaire.ts:56`); the
discard happens at answer construction, and the page gives no hint that
typing text voids the pick. (c) `receive()` drops `this.decision` with no
notification when a new snapshot arrives with a different source stamp
(`packages/mayfly/src/core/ui-interaction-surface.ts:249-254`); fencing the
stale answer is correct, but nothing tells the user the question went away.

### User impact
Users learn one marker vocabulary and meet another on the next surface.
Questionnaire respondents lose a selection they believe is recorded. A user
about to answer a confirmation finds it gone and cannot tell whether an
answer registered.

### Suggested fix
Pick one single-select metaphor (radio dots) and use it in both `renderList`
and the expanded-picker branch of `renderFormField`. In `questionnaireAnswer`
(`questionnaire.ts:56`), keep the explicit pick when one exists and treat
custom text as supplementary, as multi-select does — or surface the discard
in the UI before submit. When `receive()` clears an open decision on a source
change (`ui-interaction-surface.ts:254`), report a neutral notification that
the confirmation was withdrawn because the underlying data changed.

## UX-25: Same-class destructive confirmations carry three warning levels

- Severity: low
- Category: inconsistent interaction
- Status: substantiated

### Symptom
Removing the same class of entity asks for confirmation with three different
levels of warning: the marketplace browse list's Remove shows a titled
dialog with a restart caveat, a confirm label, and a danger tone; the plugin
detail panel's Remove shows only the bare question; the provider editor's
Delete shows only a bare question, even though a detail string spelling out
the consequence exists in the locale catalog, unused.

### Root cause
The browse-list action declares a rich confirm object
`{ title, detail, confirmLabel, tone }`
(`packages/mayfly/src/interaction/plugin-commands.ts:371`); the shared detail
node declares the same action with a plain string confirm
(`plugin-commands.ts:313`); the provider editor's delete does the same with
`Delete provider "{route}"?`
(`packages/mayfly/src/interaction/provider-edit.ts:162`), while the zh
catalog carries "Remove the provider configuration and its stored API key."
(`packages/mayfly/src/interaction/locale.ts:67`) with no consumer anywhere in
`src` (grep-verified). The shared decision renderer supports every one of
these fields; each call site simply opts into a different subset. (The
sibling clear-key confirm at `provider-edit.ts:157` is likewise a bare
string.)

### User impact
The severity signal users learn from one Remove does not transfer to the
next, and the least-warned path (provider Delete) is the one whose
consequence — credential loss — the orphaned copy was written to explain.

### Suggested fix
Define the confirmation copy per destructive action once and reuse it across
entry paths: lift the structured confirm at `plugin-commands.ts:371` into the
detail node (`:313`), and attach the orphaned `locale.ts:67` detail to the
provider delete at `provider-edit.ts:162`.

## UX-26: Silent dead ends in read-only settings, /permission, and DeepSeek key rotation

- Severity: medium
- Category: unfriendly interface
- Status: substantiated

### Symptom
(a) When the settings file is read-only, `/settings` renders an all-muted
form with a disabled Save and no explanation; "Open settings.yaml in $EDITOR"
is likewise silently disabled. (b) A bare `/permission` with no live agent
(or a bundle without the presets service) shows nothing at all. (c) Rotating
the DeepSeek API key is refused with "The provider has no editable
configuration", with no pointer to where it can be rotated.

### Root cause
(a) `settingsProjection` disables every field via `!writable`
(`packages/mayfly/src/interaction/settings-model.ts:52`) and disables Save
with `disabled: !writable || bindings.size === 0`
(`settings-model.ts:107`) but passes no `disabledReason`, even though the
action renderer displays one when present
(`packages/mayfly/src/core/ui-patterns.ts:384`) and the provider editor
already uses that exact pattern ("Settings are read-only",
`packages/mayfly/src/interaction/provider-edit.ts:128`); same omission for
the open-file action at
`packages/mayfly/src/interaction/settings-command.ts:146`. (b)
`openPermissionPanel` returns silently when `permissionPresets` or
`mayflyCurrentAgent` are missing or the current agent is null
(`packages/mayfly/src/interaction/permission-panel.ts:78`, `:85`, `:87`),
while the analogous missing-overlays branch two checks earlier reports an
error (`:80-82`); the caller intercepts the upstream `/permission` text
listing, so the user gets neither panel nor text. (c) `openProviderEditor`
refuses routes owned by another settings namespace — the DeepSeek account
adapter is the named example in the code comment
(`provider-edit.ts:47-51`) — and both entry paths end at the same bare
error (`packages/mayfly/src/interaction/provider-commands.ts:41-44` and
`:67-69`); onboarding only re-offers itself when no credential is configured
at all (`packages/mayfly/src/interaction/provider-onboarding.ts:44`), so the
configured-but-needs-rotation case has no guided path.

### User impact
Users on read-only installs, users who run `/permission` before an agent
exists, and — most commonly — anyone rotating the DeepSeek key all hit
silent or unexplained refusals and must guess the recovery path.

### Suggested fix
Pass a `disabledReason` ("Settings are read-only") to the Save action at
`settings-model.ts:107` and the open-file action at
`settings-command.ts:146`, mirroring `provider-edit.ts:128`. Report a
notification from the three early returns in `permission-panel.ts:78-87`,
matching the overlays-missing branch. Extend the refusal at
`provider-commands.ts:43`/`:69` with where the DeepSeek credential is
managed, or route to the owning adapter's surface.

## UX-27: First-run onboarding is a bare env-var secret field; custom endpoints require an API key

- Severity: medium
- Category: unfriendly interface
- Status: substantiated

### Symptom
First run opens a dialog titled "Connect to DeepSeek" containing a single
secret field labeled with the raw environment variable name
`DEEPSEEK_API_KEY` — no hint where to obtain a key, no format guidance, and
the only validation is non-empty. A mistyped key is accepted with a success
message and only surfaces later as API failures. The custom-endpoint wizard
also marks the API key required, blocking keyless local gateways unless the
user invents a dummy value.

### Root cause
The onboarding node builds one secret field with `label: DEEPSEEK_KEY`
(`packages/mayfly/src/interaction/provider-onboarding.ts:48`; the constant is
the literal `'DEEPSEEK_API_KEY'`, `:15`), and the submit handler rejects only
the empty string (`:59-60`) before `credentials.set` (`:69`) — no format
check, no verification call, and no guidance text anywhere in the node
(`:47-53`). In the setup wizard the same field is `required: true` with no
escape hatch (`packages/mayfly/src/interaction/provider-add.ts:76`), so a
base URL that needs no key cannot pass validation.

### User impact
First-run users — the least equipped to recover — must already know what a
`DEEPSEEK_API_KEY` is and where to get one; a typo is discovered only when
the first request fails; users of local proxies (a common custom-endpoint
case) are forced to enter a fake key with no explanation.

### Suggested fix
Extend the onboarding node (`provider-onboarding.ts:47-53`) with guidance
text (where to create a key) and add a light format pre-check in the submit
handler (`:59-60`). Make the wizard key field optional for custom URLs
(`provider-add.ts:76`), or add explicit copy stating that keyless gateways
may enter any placeholder.

## UX-28: Autocomplete has no loading indication for # skills or @-mention scans

- Severity: low
- Category: unfriendly interface
- Status: substantiated

### Symptom
Typing `#` in a fresh session (or right after an agent switch) opens no skill
autocomplete — the trigger reads as dead until the catalog settles and later
keystrokes succeed. Typing `@` during a slow first filesystem scan shows no
"searching" indication: the dropdown simply appears late, or never, with
only the no-results flash after the fact.

### Root cause
(a) The `#` branch returns null whenever `userInvocableSkills` is empty
(`packages/mayfly/src/interaction/editor-plus.ts:213-220`) — exactly the
unsettled window, since `invalidate` clears `settled`
(`packages/mayfly/src/interaction/skills-catalog.ts:133-137`); the code
comment itself notes the settle "can lag the first keystrokes". A null result
closes the dropdown, so nothing renders. The neighboring `@` path at least
flashes `no matching files under the session cwd` on an empty result
(`editor-plus.ts:192-197`), so the two triggers degrade differently. (b) For
`@`, the provider awaits the mention backends before returning anything
(`editor-plus.ts:178-191`), and pi-tui 0.84.2's `runAutocompleteRequest`
(verified in `dist/components/editor.js`) has no pending state — it awaits
`getSuggestions` and only then renders or cancels the dropdown — so a slow
scan produces zero feedback in between. Whether the gap is felt depends on
scan latency; the missing-indicator mechanism itself is proven.

### User impact
Users conclude `#` is broken on first use and may never retry; on large trees
without `fd`, `@` feels unresponsive with no signal that work is happening.

### Suggested fix
Return a synthetic single-item "loading skills…" suggestion, or reuse the
empty-state flash, from the `#` branch while the catalog is unsettled
(`editor-plus.ts:213-220`), and give the `@` path the same treatment for
in-flight scans; since pi-tui cannot render a pending row, flash the hint
line when a scan starts rather than only on empty results.

## UX-29: Provider wizard Save fails validation on a hidden tab

- Severity: low
- Category: unfriendly interface
- Status: substantiated

### Symptom
In the provider setup wizard for a custom endpoint, if model discovery failed
and no model was added by id, pressing Save reports a "Select at least …"
error and claims to focus the offending control — but the control lives on
the Models tab, which is never activated, so the user is told to fix a
control they cannot see.

### Root cause
The advertised-models list declares `minSelected: 1`
(`packages/mayfly/src/interaction/provider-add.ts:86`), and Save submits the
connection and models forms plus that list's selection
(`provider-add.ts:101-103`, `selections` at `:102`). On validation, the
selection-error branch calls `focusControl(selection.address)` and reports
the error (`packages/mayfly/src/core/ui-interaction-surface.ts:523-526`), but
`focusControl` only sets `selectedControl` — it never activates the tabs
along the page path (`ui-interaction-surface.ts:215-221`). Field-validation
errors do the opposite: `showValidationErrors` walks `first.pagePath` and
calls `activateTab` per segment (`ui-interaction-surface.ts:555-566`, tab
activation at `:562-565`), so form errors reveal their tab while selection
errors do not. The message text comes from `choiceError`
(`packages/mayfly/src/core/ui-interaction-choice.ts:362-365`).

### User impact
Users with a failed discovery — precisely those who most need the Models tab
— are blocked by an invisible requirement and cannot tell why Save keeps
failing.

### Suggested fix
Align the selection-error branch with `showValidationErrors`: after
`focusControl` at `ui-interaction-surface.ts:525`, walk
`selection.address.pagePath` and activate the containing tabs (or extract and
reuse the same helper), so any error that names a hidden control also reveals
it.

## UX-30: Confusing chrome and jargon: Refresh on static panels, raw namespace ids, cryptic badges, validator paths

- Severity: low
- Category: unclear prompts
- Status: substantiated

### Symptom
`/version` and `/changelog` show a Refresh button that provably repaints
identical, immutable content. The `/settings` browser lists raw namespace ids
like `llm-pi-ai` with no friendly label or description, while a set of
friendly group names sits unused in the locale catalog. The plugin
marketplace shows cryptic badges — `up 1.2.3` for an available update — and
the detail panel's Engines row prints bare version ranges like
`>=0.1.7-rc.1 >=0.1.1 >=22` with no indication which constraint belongs to
dsh, mayfly, or node. When a plugin surface fails admission, the user sees
developer paths like `$.child.children[2].id is required` as the surface
content.

### Root cause
(a) The shared `frame()` attaches Refresh+Close to both commands
(`packages/mayfly/src/interaction/session-commands.ts:53-56`), and the
refresh handler re-sets a view rebuilt from the constants `versionNode` /
`changelogNode(CHANGELOG_ENTRIES)` (`:62-67`) — nothing can change between
paints. (b) The namespace list maps items to `label: String(item.ns)` only
(`packages/mayfly/src/interaction/settings-command.ts:145`); the catalog's
friendly names ("Mayfly UI preferences", "bash tool limits", …) and the
`{count} settings` variants (`packages/mayfly/src/interaction/locale.ts:237-246`)
have no consumer (grep-verified). (c) `badgeOf` pushes ``up ${version}``
(`packages/mayfly/src/interaction/plugin-commands.ts:129`) beside spelled-out
"installed"/"partial", and the Engines row maps `engines.dsh/mayfly/node` to
unlabeled segments (`plugin-commands.ts:283-288`). (d) A rejected snapshot
becomes the surface content: `receive()` stores the validator's message as
`admissionError`
(`packages/mayfly/src/core/ui-interaction-surface.ts:242-245`) and `get
node()` renders it in place of the surface (`:134`); the validator builds
those messages from machine paths seeded at `$`
(`packages/mayfly/src/core/ui-validator.ts:1206-1209`) with
`${path}.children[i]` segments (`:928`) and `required()` producing
`$….id is required` (`:149-152`).

### User impact
A Refresh that cannot change anything invites doubt that the panel works.
Users must memorize namespace ids to find a setting. Version badges and
engine constraints read as noise. A broken plugin surface confronts end users
with internal node paths instead of an actionable message.

### Suggested fix
Omit the Refresh action for the immutable `/version` and `/changelog` frames
(`session-commands.ts:53-56`). Resolve namespace labels through a
friendly-name map with the ns id as fallback, consuming the orphaned catalog
entries (`settings-command.ts:145`, `locale.ts:237-246`). Spell the badge out
("update to 1.2.3") and label each Engines segment with its engine name
(`plugin-commands.ts:129`, `:283-288`). On admission failure, render a
user-facing "this surface could not be displayed" wrapper and keep the
validator path in a detail line for plugin authors
(`ui-interaction-surface.ts:243`).
