# Component development specification

How the Mayfly components of Phases 3 to 6 are built and shown to the owner. It was written on 2026-10-11, after Phase
2 closed, from the owner's instruction for the component phases, and it is binding for every component change from
Phase 3a on. It adds a procedure to [implementation-roadmap.md](./implementation-roadmap.md) §7; it does not change
what the roadmap decides (D21-D33), what the spec [component-library.md](./component-library.md) says, or who accepts a
component. Where the two differ on *how a component is developed and reviewed*, this document governs; where they differ
on *what is built*, the roadmap and the accepted frames govern.

The work is mostly visual alignment, so it is cut into **parts**, and every part ends in something the owner can run and
judge in a terminal.

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
5. **Ask often, in the terminal, with something to look at.** After every part, and whenever a visual choice has two
   or more viable answers, the agent asks the owner (§6). Questions carry a frame the owner can see (an ASCII preview
   cut from `pnpm run frame`, or a command to run), and a recommendation.
6. **The accepted live frame decides.** What the owner accepts in the running terminal is final (D22). Nothing is
   golden, finalized, or merged before that. The agent does not argue a drawn frame with the prototype once the owner
   has accepted it.
7. **The architecture rules still hold.** Components are pure (roadmap §1 rule 3); only `core/` knows widths, ANSI,
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

Each step has an exit condition; a step is not skipped because the part seems small.

| Step | Who | What | Exit condition |
| --- | --- | --- | --- |
| 1 Read | agent | The spec section, the prototype scene and its component functions (§4), the part's row in §7, and the real files it replaces. Run the scene: `node docs/design/prototypes/ui-preview.mjs <n>`. | The brief's *Reference* line can be written from what was read. |
| 2 Plan | agent | Name the effects of the part and the scenario that shows each. Check the catalog (`pnpm run scenario --list`) for a replay that already has them. If a state is missing, the scenario is part of the part. | Every effect has a scenario, a checkpoint, and a width. |
| 3 Scenario first | agent | Add or extend the replay (`replays.mjs`, builders in `timeline.mjs`) and the catalog entry: `mark()`s, a script of `play`, keys, resizes, and named checkpoints (§8). Run `pnpm run frame <name>` once on the *old* renderer to see the starting point. | The scenario runs, resumes, and reaches every state with the old code. |
| 4 Build | agent | The component in `packages/mayfly/src/components/` and the feature-plugin wiring (roadmap §4, §6). One effect at a time, `pnpm run dev --profile mayfly-<phase> --replay <name> --check` running. | The effects of the plan appear in the running terminal. |
| 5 Self-review | agent | `pnpm run frame <name>` at every size of the entry and `--png` for the real look; compare with the prototype scene cell by cell for the rows the part draws; read `.artifacts/verify/summary.md` of the round tier. Fix what is wrong before the owner sees it. | No wrapped row, no overflow, no unexplained difference from the prototype. |
| 6 Hand off | agent | Send the brief with the commands (§5, §9). | The owner has what they need to run it. |
| 7 Question round | owner, agent | The agent asks (§6); the owner runs the demo and answers. | Every question is answered or deferred by the owner. |
| 8 Apply | agent | Change what the owner asked, re-run step 5, and hand off again with a short delta brief (what changed, what to re-check). Repeat 7-8. | The owner accepts the part. |
| 9 Close the part | agent | Commit the part (one commit per part on the group's branch, stacked), mark it accepted in the group's status table, and record the decisions of the question rounds (§6) for the group's spec section. Goldens are not written yet. | Part status `accepted`. |

When the last part of a group is accepted, the group is **finalized** as the roadmap §7 step 3 says: the spec section
rewritten as accepted behavior and marked *Finalized*, the decision tests with the accepted checkpoints as goldens
(`pnpm run scenarios -- --update <scenario>`), the replaced code deleted, the Website reference updated, the pr tier
green, then merged. The goldens are the checkpoints of the *accepted* scenarios, so a part's scenario must already be
final in shape (names, sizes, key walks) when its last round ends.

**Pacing.** The agent does not begin the next part's visual decisions before the owner has answered the current part's
questions. It may, meanwhile, work on what makes no visual decision: the next part's scenario (step 3), data wiring,
the layering guard, tests of already-accepted behavior. If the owner says to continue without waiting, the agent
proceeds on its recommended defaults, batches the questions of the next several parts into one round, and says so in
the hand-off. Merging to `main`, phase acceptance, and removing profiles still wait for the owner (roadmap §7, root
`AGENTS.md`).

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
entry gains a `review` field (tooling part T0, §7):

```js
review: {
  reference: 'prototype scene 14 (Activity row) · spec §5.3 · ActivityRow in mayfly-components.mjs',
  implemented: ['…effects that now show, each as one observable sentence…'],
  focus: [{ look: '…what to judge…', how: 'key walk or checkpoint that shows it' }],
  differs: ['…each deliberate difference from the prototype, with the reason…'],
  pending: ['…what is visibly not done yet, so it is not reported as a defect…'],
}
```

`pnpm run scenario <name>` prints the brief before it opens the product and prints the equivalent
`node docs/design/prototypes/ui-preview.mjs <n>` line for the side-by-side; `pnpm run frame <name>` writes it beside the
checkpoints as `brief.md`; `pnpm run scenario --list` marks the scenarios that carry one. A scenario of an accepted
group keeps its `review` field only while the group is in review; finalization removes it (the spec section is the
record). Until T0 lands, the brief is the text of the hand-off message, in the same shape.

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
other part needs the brief. Parts of Phases 4 to 6 are cut when their phase starts, from the same reference table
(§4) and the roadmap's group text.

| Part | Effect the owner sees | Prototype | Scenarios (existing, or *new*) | Focus |
| --- | --- | --- | --- | --- |
| **T0 Demo kit** | `pnpm run scenario <name>` prints a brief and the prototype command; `pnpm run frame` writes `brief.md`; `--list` marks briefed scenarios. | — | every scenario may carry `review` | the brief reads well in a terminal; nothing prints inside the alternate screen |
| **3.0 Components area** | Nothing visible: the area, its layering guard, `AGENTS.md` entry (roadmap Phase 3). | — | — | the guard fails on a width helper, an escape, a timer, a `../core` import |
| **3a.1 Turns** | The turn rule with its start time; the prompt row in style A with `wrapMax: 4` folding; `⏎ queued` and `■ interrupted`. | 18, 19 | `prompts`, `queued`, *turns* | rule spacing and time; fold row; CJK and multi-line prompts; 60 columns |
| **3a.2 Answers and reasoning** | Wrapped answers with markdown blocks; reasoning rows; the welcome banner. | 18 | `thinking`, `markdown`, `idle` | wrap continuation indent; reasoning tone; blank rows between blocks |
| **3a.3 The live turn** | A streamed answer appending; follow-tail; the `↓ N new · End` pill when scrolled away. | 18 | `markdown` (timed), `wheel`, `history` | no row jumps while streaming; the pill; a 2,000-turn scroll stays smooth |
| **3a.4 Images and cutover** | Pasted images inline; the old transcript painters are gone. | 18 | `prompts` | alt text fallback; nothing regressed in `edge` |
| **3b.1 Settled tool lines** | One static line per call (glyph, past verb, target, outcome); grouped reads and searches; the folded `▸ Read 3 files · …` line. | 17 | `toolkit`, `errors` | verb and target truncation; failure line; folded counts |
| **3b.2 Edit cards** | Numbered diff in two gutters, red and green full-width bands, `−`/`+` marks, 6 rows collapsed and 12 expanded, `A`/`M`/`D` per file, the failure reason on `⎿`. | 17 | `tour`, *edits* | band and gutter tones; `⋯` between hunks; `… +N rows · Ctrl+O`; multi-file |
| **3b.3 Write and command cards** | The one-line write; the expanded highlighted code with line numbers; command rows with `⎿` tails. | 17 | `tour`, `toolkit`, `content` | highlight cap; a 1 MB write shows head rows only |
| **3c.1 Activity header** | The glyph by phase (bloom, fill, breath, still `●` with shimmering label, static `?`, static `■`); the header tail; the gap cue. | 14 | `phases` | motion cadence; reduced motion; what hides first at 60 and 40 columns |
| **3c.2 Activity details and tips** | Up to three `⎿` detail lines; padding to the turn's high-water mark; tips only in the *Deep diving* gap. | 14 | `phases`, *activity-detail* | the editor never shifts between phases; the shed order |
| **3c.3 Notices and banners** | `Banner` rows (rate limiting, offline, context nearly full, low balance, resumed); toasts in the activity gap. | 16 | `notices`, `context`, `retries`, *banners* | severity glyph and tone; stacking; the signals that raise each |
| **3c.4 Compaction** | `1/2 summarizing`, `2/2 applying`, the occupancy bar with its 800 ms drain, `✓ Compacted 84 items · 91% → 9%`, the failure row. | 20 | `compaction`, `manualCompact`, `context` | the drain; the `~` estimate; the failure state |
| **3d.1 Approval card** | The pending approval as the newest open row, and the decision card (variant B: grant first, digits, `Esc` rejects, the 300 ms arm delay, `⚠ deletes files`). | 21 | `approvals`, *approvals-queue* | the stray-key case grants nothing; `1 of N waiting`; feedback line |
| **3d.2 Plan review card** | The plan as markdown of any length, `Approve and start` / `Keep planning…` / `Reject`, `Revise:` on the same line. | 21 | `plan` | a long plan; `Ctrl+G`; `c` copies |
| **3e.1 Levels** | `Ctrl+O` Verbose for the last three turns; `Enter` on a header; the four levels' policies. | 18 | `tour`, `history` | exactly one place shows detail; compact counts |
| **3e.2 Row selection** | `Alt+↑` focuses the newest row; `Enter`, `c`, `Ctrl+G`, `Esc`/`Alt+↓`. | 18 | `tour` | focus mark; hint row; copy feedback |
| **3e.3 Stream search** | `Ctrl+F` search under the stream; the match turn opens at Verbose; matched text `warning` + `strong`. | 18 (`StreamSearch`) | `tour`, `history` | match count; stepping; `Esc` restores levels |

Phases 4 to 6 follow the same rules. Their group texts in the roadmap are the starting points: Phase 4 (editor, queue,
tokens, the `/` `@` `#` completion list, scenes 15 and 30 p1-p2); Phase 5 (the two status rows, scenes 13 and 12,
every width of 100, 72, 52, 36); Phase 6 (the panels 6a-6f, scenes 21 p4 and 22-32). Each is cut into parts the way the
table above cuts Phase 3: one effect group per part, a scenario per part, a brief per part.

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
| Round check | `pnpm run check -- --tier round`; read `.artifacts/verify/summary.md` |
| Group close | `pnpm run check` (pr tier); goldens with `pnpm run scenarios -- --update <name>` after the owner accepts |
| Perf A/B | `pnpm run perf` for a change on the frame path (reported, not gated; roadmap §7) |

The two-terminal comparison (real product beside the prototype) is the default way to review; the agent tells the
owner which scene number and which walk to compare at.

## 10. Definition of done

A **part** is done when: its scenario runs and resumes; every effect of its brief appears at the sizes of the entry;
the round tier is green; the owner has accepted it in a question round; its decisions are recorded; and the part is
committed and marked accepted.

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
- Roadmap §7 step 1 and step 2 point to §3 and §5 here.
- A change to the procedure edits this file; a change to a part's plan edits §7 here and the group's status table in
  the roadmap. Per-part status and results are never written into this file or an `AGENTS.md`.
- The agent restates the part number, the demo commands, and the brief in every hand-off, so a session that has lost its
  context can resume from the hand-off and this document.
