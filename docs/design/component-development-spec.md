# Component development specification

How the Mayfly components of Phases 3 to 6 are built and shown to the owner. It was written on 2026-10-11, after Phase
2 closed, from the owner's instruction for the component phases, and it is binding for every component change from
Phase 3a on. It adds a procedure to [implementation-roadmap.md](./implementation-roadmap.md) §7; it does not change
what the roadmap decides (D21-D33), what the spec [component-library.md](./component-library.md) says, or who accepts a
component. Where the two differ on *how a component is developed and reviewed*, this document governs; where they differ
on *what is built*, the roadmap and the accepted frames govern.

The work is mostly visual alignment, so it is cut into **parts**, and every part ends in something the owner can run and
judge in a terminal. **Progress comes first**: a round designs, asks, builds, shows, and adjusts the effect, and tests
only once the effect is final (§3). The Website is never part of a round (§1 rule 10).

## 1. The rules

1. **Part by part.** A component group (roadmap 3a, 3b, …) is cut into parts (§3). A part is the smallest change that
   produces one demonstrable visual effect or one group of effects judged together. A part never ends in "the data
   layer is done" or "the types compile": if the owner cannot see it, it is not a part (it belongs to the part that
   shows it).
2. **A demo with every part, on the real product, with mock commands.** The demo is a catalog scenario
   (`script/scenarios/catalog.mjs`) that the owner opens with `pnpm run scenario <name>`: the real `dsh`, with its
   replay played into the live session, no model, no tools, no quota (root `AGENTS.md`, *Review loop*). The agent never
   asks the owner to judge a screenshot in place of running the scenario, and never shows a demo as a Claude web
   artifact, a Claude Docs page, an HTML page, or any other browser page. A demo is a terminal, like the prototype's
   `.mjs`.
3. **A brief with every demo.** Each demo comes with a brief (§5): the effects the part implemented, the effects the
   owner should concentrate on, the key walk that reaches each one, and what is *not* done yet. The brief is what tells
   the owner (and the next developer) where to look.
4. **Read the original `.mjs` first and keep it open.** Before a part is drafted the agent reads the prototype scene it
   starts from and the component functions it calls (§4), and runs the scene. The brief names the scene and states
   every deliberate difference from it. The prototype is the starting sketch (D22): a difference is allowed when review
   decides it, but it is never silent.
5. **Ask often, in the terminal, with something to look at.** Before building (rule 7), after every hand-off, and whenever a visual choice has two
   or more viable answers, the agent asks the owner (§6). Questions carry a frame the owner can see (an ASCII preview
   cut from `pnpm run frame`, or a command to run), and a recommendation.
6. **The accepted live frame decides.** What the owner accepts in the running terminal is final (D22). Nothing is
   golden, finalized, or merged before that. The agent does not argue a drawn frame with the prototype once the owner
   has accepted it.
7. **Design, ask, then build.** A round starts as a design: Claude Code analyzes the round under plan mode and writes
   the solution; the owner approves it. Claude then asks the owner every open choice with something to look at (§6),
   and the two confirm the final effect. Development begins only after that.
8. **Scenarios after the build, and no rush to test.** When development is done Claude writes the scenario code (§8),
   organizes all of the round's scenarios, and tells the owner the commands and the brief. It does not run the tests
   at this point: the owner verifies and adjusts the effect, Claude applies it, and the loop repeats until the owner
   says the effect is final.
9. **Test last, in a session of its own.** Tests, decision tests, goldens, and the round and pr tiers run only after the
   final effect is confirmed (§3 steps 7-8), and they run in a separate session on a smaller, faster model (Haiku) that
   works from a test hand-off brief (§3.1). The design and build session writes the brief and does not run the tiers.
   Nothing is golden, finalized, or merged before that.
10. **The Website waits for the release.** No round or pr-tier step builds, previews, checks, or tests the Website,
    and a round does not edit Website pages, app shots, or the `app-*` goldens unless the owner asks. The Website is
    tested once, when a new version is released.
11. **Every tool is designed at three tiers.** A tool's display is not one row: it has a verbose, a standard, and a
    compact form, and a part states all three before it is built (§7.1). The agent asks the owner what is unclear.
12. **The architecture rules still hold.** Components are pure (roadmap §1 rule 3); only `core/` knows widths, ANSI,
   and clocks; effects are Fiber-owned. The demo must not need a back door for any of them: it plays through the same
   native services and host slots the product uses.

## 2. Vocabulary

| Term | Meaning |
| --- | --- |
| **Phase, group** | The roadmap's units: Phase 3, group 3c. A group is finalized as a whole (D23). |
| **Part** | A reviewable increment inside a group, numbered `3c.2`. Its status lives in the group's status table in the roadmap, as Phase 1's slices did. |
| **Demo** | One or more catalog scenarios, the commands that open them, and the prototype scene beside them. |
| **Brief** | The text that accompanies a demo: implemented effects, focus effects, key walks, known differences, not done yet (§5). |
| **Question round** | The questions the agent puts to the owner after a demo, and the answers recorded (§6). |
| **Reference** | The prototype scene and spec section a part starts from (§4). |

## 3. The part cycle

Each step has an exit condition; a step is not skipped because the part seems small. **No test runs before step 7**:
steps 1-6 are design, build, and the owner's effect review.

| Step | Who | What | Exit condition |
| --- | --- | --- | --- |
| 1 Read | agent | The spec section, the prototype scene and its component functions (§4), the part's row in §7, and the real files it replaces. Run the scene: `node docs/design/prototypes/ui-preview.mjs <n>`. | The brief's *Reference* line can be written from what was read. |
| 2 Design | agent, owner | The round is analyzed and designed under plan mode: the effects, the files and the order of work, the risks, the scenarios that will show each effect, and whether it is one round or two. The plan is not code. | The owner approves the plan. |
| 3 Questions | agent, owner | The agent asks every open choice (§6), with something to look at and a recommendation, and records the answers; the spec's open points and the prototype's gaps are settled here, not during the build. | The owner and the agent have confirmed the final effect, in words and frames. |
| 4 Build | agent | The component in `packages/mayfly/src/components/` and the feature-plugin wiring (roadmap §4, §6), one effect at a time. Only the build the scenarios need runs (`pnpm run build:changed`, or `pnpm run dev` watching); tests, lint sweeps, and goldens do not. | The effects of the plan appear in the running product. |
| 5 Scenarios and hand-off | agent | The agent writes the scenario code (replay, catalog entry with `mark()`s and a script, brief; §8), organizes **all** the round's scenarios, and tells the owner the commands and the brief (§5, §9). It checks that each scenario runs and reaches its checkpoints, and does not run the tests. | The owner has the commands, the brief, and what is not done yet. |
| 6 Effect review | owner, agent | The owner verifies the effect on the scenarios and in the profile and asks for changes; the agent applies them and hands off a short delta; this repeats. Questions of §6 are asked here too. No tests, no goldens, no PR checks. | The owner says the effect is final. |
| 7 Test | tester session (§3.1) | Now the tests: the round tier (`pnpm run check -- --tier round`, reading `.artifacts/verify/summary.md`), the decision tests and work budgets the part needs (§10), the perf A/B for a change on the frame path, the profile smoke. Fix what fails. The Website is not tested (§1 rule 10). | The round tier is green and the decision tests record what was decided. |
| 8 Close the part | agent | Commit the part (one commit per part on the group's branch, stacked), mark it accepted in the group's status table, record the decisions of the question rounds (§6), update the PR. Goldens are not written yet. | Part status `accepted`. |

When the last part of a group is accepted, the group is **finalized** as the roadmap §7 step 3 says: the spec section
rewritten as accepted behavior and marked *Finalized*, the decision tests with the accepted checkpoints as goldens
(`pnpm run scenarios -- --update <scenario>`, never the `app-*` scenarios, which belong to the Website), the replaced
code deleted, the pr tier green except what the Website owns, then merged. The goldens are the checkpoints of the
*accepted* scenarios, so a part's scenario must already be final in shape (names, sizes, key walks) when its last round
ends.

### 3.1 Test hand-off

Step 7 is mechanical, so it does not run in the session that designed and built the part. When the owner calls the effect
final, the building session writes a **test hand-off brief** (a file under `.artifacts/handoff/`, ignored by git, and the
same text in its reply), and the owner starts a new session on a smaller model (Haiku) and gives it the brief. Development
then iterates on the next part while the tests run. The brief is self-contained, because the tester has none of the
session's context:

1. **Where and what:** the worktree, branch, base commit, and the part (`3b.1`), with `git status` and the files changed
   (source, scenarios, docs) so the tester reads the diff first.
2. **What changed in behavior,** in the terms of the tests: the new row kinds, policy fields removed or added, constants
   raised, locale keys added or deleted, scenario names added.
3. **Known stale specs and how to fix each:** the file, why it fails, and the update to make (a changed expectation, a new
   case). Fixes are limited to what the brief names; a failure it does not name is reported, not fixed.
4. **The decision tests to add,** one line each, from the question rounds (a mapping per tool kind, a tier per level, a
   cancelled call, a width scan for each new row kind).
5. **The commands, in order,** with the environment (`DSH_BIN`, a clean `pnpm run build` before `check:pack`), the tier to
   run, and where the verdict is (`.artifacts/verify/summary.md`). Goldens are accepted only with
   `pnpm run scenarios -- --update <names>` for the scenarios the brief lists, after looking at the diff with
   `pnpm run frame <name>`; never the `app-*` scenarios, never `UPDATE_WORK_BASELINE=1`.
6. **Stop conditions:** what the tester reports back instead of resolving (a golden diff that looks wrong, a budget or
   perf regression, a failure in code the part did not touch, a needed change to a contract).
7. **Close:** one commit with the question rounds' decisions in the message, the part marked accepted in the roadmap
   table, the PR updated. The tester does not touch the Website, the spec, or the design docs.

**Pacing.** The agent does not begin the next part's design questions before the owner has confirmed the current effect.
It may, meanwhile, work on what makes no visual decision: the next part's plan in plan mode, data wiring, the layering
guard. If the owner says to continue without waiting, the agent proceeds on its recommended defaults, batches the
questions of the next several parts into one round, and says so in the hand-off. Merging to `main`, phase acceptance,
and removing profiles still wait for the owner (roadmap §7, root `AGENTS.md`). Progress is the priority: the agent does
not stop to test, polish, or chase coverage while the effect is still moving.

**Size.** A part fits one scenario run of a few minutes and one owner session. If a brief needs more than about eight
focus items, the part is too large; split it.

## 4. Reading the original `.mjs`

The prototype is three modules under `docs/design/prototypes/`:

| Module | Read it for |
| --- | --- |
| `ui-preview.mjs` | The scenes: what is shown together, at which width, with which keys (the `keys:` line of each scene), and the mock data. `--list` prints the index. |
| `mayfly-components.mjs` | The Mayfly components as functions of facts: `ActivityRow`, `ToolLine`, `EditCard`, `WriteCard`, `CompactionRow`, `Banner`, `DecisionCard`, `TranscriptView`, `StreamSearch`, `Editor`, `StatusBar`, `ViewRow`, `ViewPanel`, and the panels. This is where the glyphs, spacing, priorities, and degradation ladders are. |
| `ui-kit.mjs` | The basic components, the tokens, and the key engine. Read it when a difference might come from the kit rather than the component. |

What the prototype does not draw is listed in the spec §9 (*What the prototype does not draw*): width ladders it
describes only in text, demo keys, motion, and illustrative painters (charts, markdown, highlighted code). Where a part
touches one of those, the spec text is the reference and the brief says so.

**Reference table for Phase 3.** Scene numbers are those of `node docs/design/prototypes/ui-preview.mjs --list`.

| Group | Scene | Component functions | Spec | Real scenarios that already exist |
| --- | --- | --- | --- | --- |
| 3a Stream and turns | 18 Conversation stream, 19 Prompt styles (style A) | `TranscriptView`, `PROMPT_MAX_LINES` | §5.6 | `prompts`, `thinking`, `markdown`, `history`, `wheel`, `queued` |
| 3b Tool rows | 17 Tool rows and edits | `ToolLine`, `EditCard`, `WriteCard` | §5.3 | `tour`, `toolkit`, `errors`, `content` |
| 3c Activity, notices, compaction | 14 Activity row, 16 Notices and banners, 20 Compaction | `ActivityRow`, `Banner`, `CompactionRow` | §5.2, §5.3, §5.6 | `phases`, `notices`, `context`, `compaction`, `manualCompact`, `retries` |
| 3d Decision cards | 21 Approval, plan review, permission | `DecisionCard`, `DECISION_CARDS` | §5.7 | `approvals`, `plan` |
| 3e Levels, selection, search | 18 at every level | `TranscriptView` (`level`, `toggled`, `forceVerbose`), `StreamSearch` | §5.6 | `tour`, `history` |

## 5. The brief

### 5.1 Where it lives

The brief is **data of the scenario**, so it is present wherever the scenario is run and cannot drift from it. A catalog
entry may carry a `review` field (read by `script/scenarios/brief.mjs`; `scene` is the number of the prototype scene to
run beside it):

```js
review: {
  scene: 14,
  reference: 'prototype scene 14 (Activity row) · spec §5.3 · ActivityRow in mayfly-components.mjs',
  implemented: ['…effects that now show, each as one observable sentence…'],
  focus: [{ look: '…what to judge…', how: 'key walk or checkpoint that shows it' }],
  differs: ['…each deliberate difference from the prototype, with the reason…'],
  pending: ['…what is visibly not done yet, so it is not reported as a defect…'],
}
```

`pnpm run scenario <name>` prints the brief before it opens the product and prints the equivalent
`node docs/design/prototypes/ui-preview.mjs <n>` line for the side-by-side; `pnpm run frame <name>` writes it beside the
checkpoints as `brief.md`; `pnpm run scenario --list` marks the scenarios that carry one with `*`. A scenario of an accepted
group keeps its `review` field only while the group is in review; finalization removes it (the spec section is the
record). The catalog test refuses a malformed review, one with more than eight focus items, and a focus walk that
names none of the scenario's checkpoints. The hand-off message restates the brief in the same shape (§5.3).

### 5.2 What a good brief says

- **Implemented** lists effects the owner can see, not code: a glyph, a tone, a spacing rule, a motion, a width
  behavior, a key. *"The thinking glyph blooms while the label shimmers; a running tool holds a still `●` while only
  its label shimmers."* Not *"ActivityRow is pure and memoized."*
- **Focus** is ordered by importance and each item says how to reach it. The owner should be able to run the walk and
  know in a minute whether it is right. Typical focus items: alignment and spacing against the prototype; the glyph and
  tone of each state; the shed order at narrow widths; motion cadence and reduced motion; the key and its hint; what
  happens on resize and on theme swap; behavior with `NO_COLOR=1` and ASCII glyphs.
- **Differs** is every place the live frame differs from the prototype scene, with the reason (a real library, a native
  signal, an earlier owner decision such as D3-D15, the renderer's own wrapping). An owner decision that settles it is
  cited; an open one becomes a question.
- **Pending** keeps the owner from spending a round on what the next part brings.

### 5.3 The hand-off message

The hand-off is short and has the same shape every time:

```
Part 3c.1 — activity row header   (branch feat/3c, commit <sha>)

Run it
  pnpm run scenario phases                    the real product on the replay
  pnpm run scenario phases --width 60         narrow
  node docs/design/prototypes/ui-preview.mjs 14   the sketch, in a second terminal (v / V next phase)
  pnpm run dev --profile mayfly-3 --replay phases   live edits (if you want to adjust with me)

Implemented
  · …

Look at
  1. … — <how to reach it>
  2. …

Differs from the prototype
  · …

Not done yet
  · …

Questions: (asked next, in the question tool)
```

A delta hand-off after a round lists only what changed, how to re-check it, and which earlier question it answers.

## 6. Question rounds

**When.** After every hand-off. Before building, whenever the spec leaves a visual choice open or two readings of the
prototype are plausible and the cost of guessing wrong is a rebuild. Before deleting anything the owner has seen.

**How.** With the question tool (`AskUserQuestion`), at most four questions per round, each with two to four options,
the recommended option first and marked. Where the answer depends on how it looks, the option carries a `preview`: the
text of the frame, taken from `.artifacts/frames/<scenario>-<cols>x<rows>/<checkpoint>.txt` (or the prototype's
printout), so the owner compares glyphs and spacing without leaving the terminal. Where the answer depends on motion or
a key feel, the question names the command that shows it and the moment to watch. An option that needs a second
rendering gets a temporary scenario variant (a second catalog entry that the part removes when it is answered), never
a runtime switch left in the product.

**What to ask.** Open visual choices (a tone, a glyph, a spacing, a shed order, a label); behaviors the spec leaves
open or the prototype does not draw (§4); any difference from the prototype that no decision covers; whether a
performance cost seen in the round is acceptable or must be fixed now (roadmap §1 rule 6).

**What not to ask.** What a decision row (D1-D33), the spec, or an earlier accepted frame already settles; code
structure; naming inside `components/`; anything the agent can verify in the Harness reference, the pi-tui docs, or the
code. If unsure whether something is settled, look it up before asking.

**Recording.** Each answer is a decision. The agent keeps the round's questions and answers in the part's commit message
and carries them into the group's spec section when it is finalized. A decision that changes an API is applied to every
caller in the same change (D21).

## 7. The part plan

The plan cuts each group of the roadmap into parts. It is the starting point; a part may be split, merged, or reordered
when review shows a better cut, and the group's status table records it. **Tooling part T0** comes first because every
other part needs the brief. Phase 4's parts are cut below (*Phase 4 parts*); parts of Phases 5 and 6 are cut when their phase starts, from the
same reference table (§4) and the roadmap's group text.

| Part | Effect the owner sees | Prototype | Scenarios (existing, or *new*) | Focus |
| --- | --- | --- | --- | --- |
| **T0 Demo kit** | `pnpm run scenario <name>` prints a brief and the prototype command; `pnpm run frame` writes `brief.md`; `--list` marks briefed scenarios. | — | every scenario may carry `review` | the brief reads well in a terminal; nothing prints inside the alternate screen |
| **3.0 Components area** | Nothing visible: the area, its layering guard, `AGENTS.md` entry (roadmap Phase 3). | — | — | the guard fails on a width helper, an escape, a timer, a `../core` import |
| **3a.1 Turns** | The turn rule with its start time; the prompt row in style A with `wrapMax: 4` folding; `⏎ queued` and `■ interrupted`. | 18, 19 | `prompts`, `queued`, *turns* | rule spacing and time; fold row; CJK and multi-line prompts; 60 columns |
| **3a.2 Answers and reasoning** | Answers as Markdown under a leading `●`; reasoning rows (live line, whole text under `✻ Thinking`, one-line preview); a blank row closing the welcome banner. | 18 | `thinking`, `markdown`, `idle` | wrap continuation indent; reasoning tone; blank rows between blocks |
| **3a.3 The live turn** | A streamed answer appending; follow-tail; the `↓ N new · End` pill when scrolled away. | 18 | `markdown` (timed), `wheel`, `history` | no row jumps while streaming; the pill; a 2,000-turn scroll stays smooth |
| **3a.4 Images and cutover** | Pasted images inline; the old transcript painters are gone. | 18 | `prompts` | alt text fallback; nothing regressed in `edge` |
| **3b.1 Settled tool lines** | Every tool at three tiers (§7.1): a verbose block per call with a body (lines read, matches, output tail, sources, page head), a standard block for a run of one kind, a compact merged line; Detailed collapses earlier steps. | 17 | `toollines` (+ `-compact`, `-detailed`, `-verbose`), `toolkit`, `errors` | bodies and their cap; the block of a run; the merged line; the Detailed collapse; failure, ⊘ (interrupted, not started) and outcome-unknown lines |
| **3b.2 Edit cards** | An edit is `✓ Edit(path) · +4 −2` and its diff, open at Standard (6 rows; 12 at Verbose, 40 with Ctrl+O): syntax-highlighted code, red and green bands that stop short of the right edge, `−`/`+` marks, and one quiet line-number gutter that numbers every row (a removed line by its place before the edit, any other by its place after it) from 1 in each hunk, as wide as the largest number of any hunk (the Harness gives no start line, so a hunk's numbers are relative to it); each change is its own block, never a run; the failure reason on the call's line. | 17 | `tour`, *edits* | band and gutter tones; `⋯` between hunks; `… +N rows · Ctrl+O`; multi-file |
| **3b.3 Write card** | `✓ Write(path) · N lines · size` and its highlighted code with line numbers, open like the edit (6, 12, 40 rows); Compact folds both. Command rows were finished in 3b.1. | 17 | `tour`, `toolkit`, `content` | highlight cap; a 1 MB write shows head rows only |
| **3b.4 Pending call blocks** | A call is in the stream the moment it is committed: `● Bash(cmd) · 4s` with a breathing dot and its own time, any output below, then `✓`/`✗`/`⊘` in place; at Compact too, the line alone. The activity row's second line is a tip at every level; the thinking label deepens through four named stages; the live reasoning row carries no ticking time. | 17, 14 | `toollines`, `phases`, *pending* | the stream is never empty while the row is busy; one fact in one place; the four thinking stages |
| **3b.5 Tool block base** | One descriptor per tool category (`tool-kinds.ts`) and four block states (running, done, run, fold) at the four levels (§7.1, "The tool block base"): a call in flight shows its input by level, Edit and Write code fills row by row before the commit, the activity row has one effect and names the calls in flight on the one host tick. | 17, 14 | `blocks`, `streaming`, `sync`, `fold` | the pending line at Compact; input rows per level; the code growing and holding still at the cap; the row and the stream agreeing |
| **3c.1 Activity header** | The glyph by phase (bloom, fill, breath for every wait on you, still `●` with shimmering label, static `■`); the header tail; the three-row block (a leading spacer, the header; the row under it is the notification pane's). | 14 | `phases`, `phases-off` | motion cadence; reduced motion; what hides first at 60 and 40 columns |
| **3c.2 Activity tips** | The line under the header is a rotating tip (the row has one effect at every level; the action running is the stream's pending line); the block is three rows (a leading spacer, the header, the line), with the notification pane's row under it; the wait row above the approval and question panels; the quiet-hints setting. | 14 | `sync`, `activityWait` | the editor never shifts between phases; the shed order |
| **3c.3 Notification pane** | One right-aligned row (half the width at most) above the editor for the notification lane's records and the notices the facts raise (rate limit, context nearly full, resumed); offline and low balance are deferred (no signal). | 16 | `notices`, `context`, `retries`, `notificationPane` | severity glyph and tone; the half-width cap; the signals that raise each |
| **3c.4 Compaction** | `1/2 summarizing`, `2/2 applying`, the occupancy bar with its 800 ms drain, `✓ Compacted 84 items · 91% → 9%`, the failure row; a manual `/compact` below its turn. | 20 | `compaction` (+ `-compact`, `-verbose`), `compactionFailed`, `manualCompact`, `context` | the drain; the `~` estimate; the failure state |
| **3d.1 Approval card** | The pending approval as the newest open row, and the decision card (variant B: grant first, digits, `Esc` rejects, the 300 ms arm delay, `⚠ deletes files`). | 21 | `approvals`, `approvalsRejected`, `approvalsEdit`, `approvalsQueue` | the call is the request; the stray-key case grants nothing; `1 of N waiting`; feedback line |
| **3d.2 Plan review card** | The plan as markdown of any length, `Approve and start` / `Keep planning…` / `Reject`, with the `Revise:` note under the choices. | 21 | `plan`, `planRevised`, `planLong` | a long plan; `Ctrl+G`; `c` copies |
| **3e.1 Levels** | `Ctrl+O` Verbose for the last three turns; `Enter` on a header; the four levels' policies. | 18 | `tour`, `history` | exactly one place shows detail; compact counts |
| **3e.2 Row selection** | `Alt+↑` focuses the newest row; `Enter`, `c`, `Ctrl+G`, `Esc`/`Alt+↓`. | 18 | `tour` | focus mark; hint row; copy feedback |
| **3e.3 Stream search** | `/` and `?` in conversation mode open a search line above the editor (regular expression, smart case); typing highlights, `Enter` selects, `↑`/`↓` and `n`/`N` walk the matches; the match turn opens at Verbose; matched text reversed. | 18 (`StreamSearch`) | `tour`, `history` | match count; stepping; `Esc` restores levels |

### Phase 4 parts

Phase 4 (editor and command palette) is cut ahead of its start, so the rounds can be planned while Phase 3 is in test.
It is the same cut as Phase 3's: one effect group per part, a scenario per part, a brief per part. The roadmap's Phase 4
section holds the groups (4a-4e) and the status table of rounds. A part may be split, merged, or reordered when review
shows a better cut, as for Phase 3; the status table records it. The scenario names are proposals, final at the part's
hand-off.

| Part | Effect the owner sees | Prototype | Scenarios (*new*) | Focus |
| --- | --- | --- | --- | --- |
| **4a.1 Editor frame** | The rounded frame with the conversation title in its top-right corner around the `ui.prompt` (symbol, buffer, caret), as a pure `Editor` component on the editor dock slot; the frame is the same at 96, 60, and 40 columns. | 15 | *editor*, *editorTitle* | title cut at narrow widths; the caret and wrapped lines; CJK and multi-line buffers; the frame never shifts the rows above |
| **4a.2 Shell mode** | `!` as the first character turns the prompt symbol into `!` and the border to the accent color; nothing else changes (no `! shell mode` label, no `SHELL` chip); `Esc` or `Backspace` on an empty buffer leaves it. | 15 | *editorShell* | the border tone in both themes and with `NO_COLOR`; leaving the mode; the title stays |
| **4b.1 Tokens in the buffer** | Pasted images, pasted blocks, and `@` mentions are `[label size ×]` tokens in the buffer; `Backspace` on an empty buffer selects the last token (inverse), the next one removes it. | 15 | *tokens* | the token tones; the two-key removal; a token at the wrap edge; 60 columns |
| **4b.2 Submit expansion** | What is sent is what is sent today: the submit pipeline expands each token to its content; a draft keeps its tokens through a restart of the profile and through the external editor. | 15 | *tokensSubmit* | image, paste, and mention each expand once; a removed token sends nothing; a long paste |
| **4c.1 Queue line** | One truncated line above the frame: the first three queued messages cut to 22 characters, then `+N`, then `↑ recall`; it never grows the editor; the queue pane is gone. | 15 | *queue* | the cut and the `+N`; the line at 60 and 40 columns; the editor never moves |
| **4c.2 Recall** | On an empty buffer `↑` recalls the queue first (newest), then earlier messages; the corner reads `↑ history 2/4`; `↓` walks back and ends on the draft; recalling a queued message takes it out of the queue and sending it queues it again. | 15 | *recall* | the order; the counter; the draft restored; the withdrawn message not sent twice |
| **4d.1 The `/` list** | The completion list under the buffer with scene 30's rows: the match in bold, the description, the command's key at the right; the old select-list adapter is gone. | 30 p1-p2 | *palette* | row layout at 96, 60, and 40 columns; the match highlight; no row shift above; long descriptions |
| **4d.2 Palette keys** | The list's own key line (`↑/↓ options · Tab complete · Enter insert · Esc close`) and nothing else under the frame; typing filters; `Esc` closes without losing the draft. | 30 p1-p2 | *paletteKeys*, *paletteNarrow* | the key line is the only hint; `Enter` on a half-typed command; scrolling a long list |
| **4d.3 `@` files** | `@` lists files; `Enter` or `Tab` inserts a token (4b.1); `Ctrl+G` opens the file; a directory narrows the list. | 30 | *mentions* | the path cut; the token inserted; a workspace with thousands of files stays smooth |
| **4d.4 `#` skills and extensions** | `#` lists skills and inserts text; the `complete()` results of editor extensions join the list under their own heading. | 30 | *skills*, *extensionComplete* | the source of each row; an extension that throws or is slow; one list, one key line |
| **4e.1 Placeholders** | The empty prompt teaches the typed prefixes by state: main idle or running, shell, side question, subagent live or resumable, read-only; the longest variant that fits is chosen with no width read in code; the quiet-hints setting blanks it. | 15 | *placeholders* | one ladder per state; the shed order at 60 and 40; hints off |
| **4e.2 Keys and title** | `Alt+↑` focuses the stream, `Alt+↓` or `F6` enters the views, `?` on an empty prompt opens key help, `Ctrl+S` steers, `Ctrl+G` opens the draft in `$EDITOR`; the title follows the official `title` projection. | 15 | *editorKeys* | each key from the prompt and from the stream; `?` in a non-empty buffer is text; the title when a session is renamed |
| **4e.3 Subagent replies** | In a live or resumable subagent conversation the editor sends through the addressed-subagent path: `Enter` queues, `Ctrl+S` steers; the reply form with its `Send` and `Cancel` buttons and delivery select is gone. | 15 | *subagentReply* | the delivery choice is the editor's own pair; the placeholder names the subagent; a resumable one wakes |

Phases 5 and 6 follow the same rules. Their group texts in the roadmap are the starting points: Phase 5 (the two status
rows, scenes 13 and 12, every width of 100, 72, 52, 36); Phase 6 (the panels 6a-6f, scenes 21 p4 and 22-32). Each is
cut into parts the way the table above cuts Phase 3: one effect group per part, a scenario per part, a brief per part.

### 7.1 Every tool at three tiers

Written on 2026-10-12 from the owner's instruction at the close of part 3b.1, and binding for every tool part (3b.2 and
on). The work-details levels (`compact`, `standard`, `detailed`, `verbose`) differ in how much of a tool call they draw, so
each tool is designed at three **tiers**, and the levels choose among them:

| Tier | Drawn at | A call looks like |
| --- | --- | --- |
| **Verbose** | the Verbose level; `Ctrl+O` on a turn | one block per call: the line (glyph, the tool's name in bold, its arguments in parentheses, outcome) and a body of at most 6 rows (`… +N more · Ctrl+O`); `Ctrl+O` shows every row the facts carry (40) |
| **Standard** | the Standard level (the default); a settled turn at Detailed | a run of consecutive calls of one kind is one block: a head (`✓ Read 3 files · 48 lines`) and a tree with one line per call; a single call is one line |
| **Compact** | the Compact level | the turn folds behind its header; a turn that does not fold shows one merged line per run of calls between two messages (`▸ Ran 2 commands · Read 1 file · 1.1s · 1 failed`) |
| **Detailed (live)** | the Detailed level while a turn runs | the step the model works in draws verbose blocks; the steps before it collapse to Standard blocks when the next step starts |

How a part applies it:

1. **Design all three tiers per tool before building**, as ASCII frames in the plan, with the body of the verbose block,
   what a run of the tool collapses to, and what the compact line counts. Ask the owner only what the rule leaves open.
2. **Failures and cancellations keep their reason at every tier.** A failed call is `✗` with the first line of its reason,
   a call the user stopped or that never ran (Harness codes `ABORTED`, `ABORTED_BEFORE_DISPATCH`, `TOOL_NOT_STARTED`) is `⊘`
   with a muted verb and a short reason (`interrupted`, `not started`) in place of the Harness text and no body, a call whose
   outcome is unknown (`TOOL_OUTCOME_UNKNOWN`: the session ended while it ran, so it may have had a side effect) is `✗` with
   the short reason `outcome unknown`, and an interruption is never folded away. A Standard head and the Compact title count
   `⊘` calls apart from failures (`3 calls · 4.1s · 1 failed · 2 interrupted`, the second muted), so a stopped run is not a
   failed one; a head whose calls are all `⊘` is muted and has no `failed`.
3. **A call in flight is a pending line in the stream at every level, Compact included** (component-library §5.3.1; this
   replaces the 3b.1 rule that a running call had no block): `● Bash(command) · 4s`, the dot breathing, the call's own
   time ticking, its input below it by tier (the tool block base, below). The activity row names the phase only
   (`Running commands`), with no call time and no detail at any level. A call settles into `✓`, `✗`, or `⊘` in place.
4. **A blank row separates every row of a turn** (prompt, header, each block, answer, reasoning, the interruption mark).
5. **A call is named by its tool, not by a verb of ours:** `✓ **Read**(path) · 481 lines`, `✓ **WebSearch**("query") · 2 sources`, `✓ **Bash**(command) · 4.2s`, with the output on the lines under it and no `⎿` mark. The name is the tool's own in PascalCase (`web_search` is `WebSearch`, an MCP tool is `server › tool`), the arguments are shown as given, and the row clips at the end at narrow widths.

Where the code lives (what the next tool part reuses):

- `transcript/presentation-policy.ts` maps each level to a view per turn state: `liveProcess` (`hidden`, `blocks`,
  `current`, `cards`) and `settledProcess` (`titles`, `blocks`, `cards`), plus `foldCompletedTurns` (only Compact).
  `transcript/process-groups.ts` stamps each tool entry with a `tier` (`verbose` or `standard`); `Ctrl+O` is a turn's
  `expanded` flag and lifts the body cap.
- `transcript/tool-calls.ts` reduces every call to one `Call` (id, activity, state, verb, target, label, outcome parts,
  times, and a lazy `body()`), and lays the same facts out as a verbose block (`verboseRow`) or a standard block
  (`standardRow`). A new tool gets a `Call` builder and a body; the compact tier is `processTitle` over its activity
  (`process-activity.ts`: `COUNT_PHRASE` and the zh copy beside it).
- `components/tool-line.ts` holds the pure spans of a line, a body row, a head, and a tree line. `transcript-view.ts` has
  the `tool` (verbose) and `tools` (standard) row kinds; list items of one block share the block's blank-row gap.
- Bodies are bounded by the facts the model carries: `READ_PREVIEW_LINE_LIMIT`, `SEARCH_PREVIEW_MATCH_LIMIT`,
  `SEARCH_PATH_LIMIT`, `COMMAND_PREVIEW_LINE_LIMIT` in `transcript/official-model.ts`, and `OPEN_BODY_ROWS` for text kept
  from a result. A command shows the end of its output (`… +N earlier` above), every other body its first rows.

### The tool block base (part 3b.5)

Every tool block is drawn from one base, `transcript/tool-kinds.ts`: a `ToolKind` descriptor per category
(`headed`, `count` phrase, `running` and `preparing` labels, `mergeable`, `streams`) that a category overrides on top of
the base. A `Call` (`transcript/tool-calls.ts`) carries a `phase` (`preparing`: the model still writes the arguments;
`running`: committed, no result; `settled`), a lazy `input()` (what the call was given that its line does not show) and a
lazy `body()` (what came back). Blocks have four states, each at the four levels:

| State | Compact | Standard | Detailed | Verbose (Ctrl+O) |
| --- | --- | --- | --- | --- |
| **Running** | `● Bash(first line …) · 4s`, no rows | a multi-line command is `● Bash` over its own lines (3 rows); Edit and Write 6 rows, filling from the top, then `… +N more` counts up; Thinking 3 rows, and the same 3 once settled (`✻ Thinking · 9s`) | the current step as Verbose: 6 rows (Edit and Write 12, Thinking 8) | the same; with the turn open (Ctrl+O) new rows are drawn live up to 40 |
| **Done** (one call) | in the Fold line | one line, `✓ Bash(first line …)` (Edit and Write open at 6 rows) | the current step as Verbose, earlier steps as Standard | a block, body 6 (change 12, 40 open) |
| **Run** (two or more of a kind) | in the Fold line | one group block from the first call on: `● Read · 2 files` and a branch line per call, each with its own state, in place | earlier steps | never merged: one block per call |
| **Fold** | one line per turn where the first call was, `▸ 6 tool calls · 14s · Ctrl+O to expand`, counting up as the turn works; calls in flight keep their lines under it; nothing folds away at the end | none | none | none |

Rules the base fixes for every tool:

- The **input** of a call is shown while it runs: a command's lines after the first (the line carries the first, with
  `…` when more follow), the queries of a web search, and for Edit and Write the code the model is generating. A call
  with a single-line input (Read, Search, WebFetch) is just its line. Subagent and job progress is not drawn in the
  block (the bottom bar will carry it).
- **Streaming shows the end, a finished block shows the start.** While the model writes a call's input (Edit, Write) or
  its thinking, the block shows the last rows that fit its cap, newest at the bottom, under `… +N earlier`; the line numbers
  of a code window are its own (`ui.code` `start`). When the input is committed (the thinking is done) the block shows
  its first rows above `… +N more`.
- A call that streams its input (`streams`: Edit, Write) has a stream row from the moment the model names it, in
  `preparing`, with no time of its own (the activity row counts the turn's); it keeps its identity when the call is
  committed. Arguments are read by `transcript/partial-json.ts` as they arrive; the accumulator keeps the text
  (`preparing[].arguments`).
- A level never changes what the activity row draws. At Compact the settled calls are the Fold title's and only what is
  in flight keeps its line.
- The turn fold stays a Compact behavior; it is the Fold state of the base, not a separate mechanism.

Constraints learned while building 3b.1:

- Row facts are compared by value (`sameValue` in `stream-facts.ts`) because blocks hold lists; a row that differs in any
  field is rebuilt, one that does not keeps its frozen items, so the list's row cache hits.
- Never `ellipsize` code: it collapses whitespace. Body rows keep indentation and only cut an over-long row.
- A tier is chosen in the display plan, not in the component. A component receives the facts of one tier and never
  reads the level.
- The replay must give the presenters what they read, or a tool falls back to its generic line without an outcome: a
  `read` result needs the `<path>…</path><type>file</type><content>` envelope and the `{ path, offset, lines, totalLines }`
  meta; `grep` and `glob` need `{ shape, files | paths, total, truncated }`; `web_search` takes `queries` (an array) and
  `{ sources, truncated }`; `web_fetch` takes `{ url, statusCode, truncated }`. A non-zero exit is not an error result
  (`[exit code: N]` ends the output); a call that did not settle is `unanswered` in the timeline and stores the result the Harness writes: `true` (an Esc or Ctrl+C while it ran, `ABORTED`, with a turn `outcome: 'aborted'`), `'before-dispatch'` (`ABORTED_BEFORE_DISPATCH`), or `'unknown'` (the session ended while it ran, `TOOL_OUTCOME_UNKNOWN`, with a turn `outcome: 'interrupted'`).
- The fetch size is the length of the result text (the view has no byte count) and is approximate.
- Verbs belong to summaries, names to calls: the Standard head and the Compact line use verb phrases (`Read 3 files`,
  `Ran 2 commands · 6s`), a call's own line shows the tool's name in bold with its arguments (`Bash(pnpm run lint)`).
  Command output carries no `⎿` mark; every body is indented the same.
- Show every level in the first demo. A scenario variant per level (`toollines-compact`, `-detailed`, `-verbose`, with a
  checkpoint stopped mid-turn for Detailed) let the owner judge the tiers together; one scenario at one level hid the
  design question for a round.
- A policy or fold change is a change to every stream scenario: list the scenarios whose goldens move in the test
  hand-off brief, so the tester accepts them knowingly.
- Changing a level's fold or tier changes every scenario that draws the stream: expect the goldens of all of them, and
  of the Website's `app-*` scenarios, to move at finalization.

Constraints learned while building 3d (decision cards) and 3e (levels, selection, search):

- A request that waits on the user is open at every level and never folds, even at Compact; the turn's fold line still
  counts the call.
- The arm delay of a card that opens unprompted is wall-clock time. The overlay swallows every key but `Esc` until it
  arms, so a scenario that answers a card waits for the arm before the checkpoint that follows the answer.
- A decided request's settled line follows the recorded answer (`allowed` or `rejected`, `✓ Plan approved`,
  `✗ Plan rejected`, `↩ Plan sent back`), so a replay must record the answer, not a fixed script. A note steered to the
  Agent starts a turn in a replay.
- A second request waits behind the first. The card and the request row both read `1 of N waiting`, so a queue scenario
  needs two requests in the timeline.
- `c` and `Ctrl+G` mean the card's copy and open while the card is open (it is a capturing overlay), and the row's
  copy and open while the stream holds focus. A check of one must not expect the other.
- Stream search matches the text a person reads in the frontend models, not the painted rows, so detail a level hides
  is found and the turn holding the match opens at Verbose.
- A run's row id is its first call's id, and a run is handed to the grouping without the ids of its mergeable calls, so
  opening one call never takes it out of its run.
- A one-line command is never repeated under its own line.

## 8. Writing the demo scenario

The scenario is the mock command. It follows the machinery described in root `AGENTS.md` (*Review loop*) and these
rules, which keep the demo useful to a person and usable as a golden later:

1. **It shows the part's states in one run.** Use `mark()`s so `play('<mark>')` stops at each state and a checkpoint
   names it. A person walking through it should meet every focus item of the brief without editing anything.
2. **Real data paths.** The replay appends the session events and frames the agent loop would have written; it does
   not fake the component's output. A state the Harness cannot produce is not drawn; the brief says so.
3. **Lifecycle and narrow cases are in the script.** At least one size at 60 columns (28 or 40 where the group's
   ladder reaches it), one resize step, and, where the component holds state, a core reload or theme swap.
4. **The session stays loadable.** Replay events keep a stored session resumable (`dsh --resume`); a later effect is an
   action of its own, never a timer in the driver. Check `.artifacts/replay/driver.log`.
5. **Deterministic.** Identical grids on repeated and parallel runs; motion is stopped by the scenario clock and
   reduced motion in `frame`; the live `scenario` runs at real time and `--speed N` accelerates it.
6. **Stable names.** Checkpoint and scenario names are the ones the goldens will use; rename early, not after the
   owner has learned them.
7. **Covers.** The `covers` globs name the sources the scenario can reveal, so the change-based selection runs it
   (root `AGENTS.md`, *Verification*).
8. **Modes.** The owner can run any demo with `--no-color`, `--ascii`, `--width N`, `--height N`; reduced motion is a
   saved setting (`/settings`). The brief names the ones that matter for the part.

## 9. Commands

| For | Command |
| --- | --- |
| Open a demo | `pnpm run scenario <name> [--width N] [--height N] [--no-color] [--ascii] [--speed N]` |
| List demos | `pnpm run scenario --list` |
| The sketch beside it | `node docs/design/prototypes/ui-preview.mjs <n>` (`--list` for the index; `] [` move between scenes) |
| Live editing with the owner | `pnpm run dev --profile mayfly-<phase> --replay <name> [--check]` (worktree profile, never `mayfly`) |
| A frame without a person | `pnpm run frame <name> [--width N] [--height N] [--keys enter,down] [--png]` → `.artifacts/frames/<name>-<cols>x<rows>/` (grid, `.txt`, `.svg`, `.png`) |
| Round check (step 7, after the effect is final) | `pnpm run check -- --tier round`; read `.artifacts/verify/summary.md` |
| Group close | `pnpm run check` (pr tier, without the Website); goldens with `pnpm run scenarios -- --update <name>` (not the `app-*` ones) after the owner accepts |
| Perf A/B | `pnpm run perf` for a change on the frame path (reported, not gated; roadmap §7) |

The two-terminal comparison (real product beside the prototype) is the default way to review; the agent tells the
owner which scene number and which walk to compare at.

## 10. Definition of done

A **part** is done when: its plan was approved and its questions answered (§3 steps 2-3); its scenario runs and
resumes; every effect of its brief appears at the sizes of the entry; the owner has confirmed the final effect (step
6); and only then the round tier is green, its decision tests are in, its decisions are recorded, and the part is
committed and marked accepted (steps 7-8).

A **group** is done when roadmap §7 step 3 is complete and the PR body carries the acceptance record: the rounds and
the frames that showed them, the accepted scenarios and widths, the API changed with its callers, the code deleted, and
the perf A/B table. This document adds one line to it: the part list with the question rounds' decisions.

A **phase** ends as the roadmap says: the full tier, the perf report, and the owner's acceptance of the whole phase on
its profile.

## 11. Stop and ask

The agent stops the part and asks the owner when: the prototype and the spec disagree; the Harness offers no signal for
a state the design draws (notices such as offline or rate limit are the known case, roadmap 3c); a visual choice would
change a finalized component or a public contract; a performance problem cannot be fixed locally (record it for Phase
7, but ask whether the cost is acceptable now); a replay cannot produce the state without a driver change that alters
how the product behaves. It does not stop for naming, file layout inside `components/`, or test structure.

## 12. How this specification is kept

- Root `AGENTS.md` points to this document from *Review loop*, and `docs/README.md` lists it.
- Roadmap §7 step 1 and step 2 point to §3 and §5 here; the order of design, questions, build, scenarios, effect
  review, and test is §3's.
- A change to the procedure edits this file; a change to a part's plan edits §7 here and the group's status table in
  the roadmap. Per-part status and results are never written into this file or an `AGENTS.md`.
- The agent restates the part number, the demo commands, and the brief in every hand-off, so a session that has lost its
  context can resume from the hand-off and this document.
