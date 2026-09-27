# Bottom panes

Between the status bar and the input editor sits the **bottom dock**: five passive panes stacked by priority (activity → queue → todo → agents → workflow, editor last). Panes with nothing to say render zero rows, so the dock does not jump. BTW and sessions opened from `/agents` are not panes: they switch the current Agent or use the shared readonly session panel.

## Activity pane

The one live-status row for the current Agent: the transcript only records what happened, while this row says what is happening now — the spinner, a present-tense label, the turn's elapsed time, token counters (`↑` context, `↓` estimated output, characters / 4), the output rate while text streams, and a rotating tip:

```
🌔 Deep diving · 3s · Tip: …
⠋ Thinking · 8s · ↓2 · ≈42 tok/s · Tip: …
⠋ Writing · 14s · ↓120 · ≈40 tok/s · Tip: …
🌔 Running commands · 21s · ↑30k ↓4k · pnpm test
```

| Mode | Presentation |
| --- | --- |
| waiting | moon spinner + `Deep diving`; while a tool call's arguments still stream, its preparing label (`Preparing to write files`) |
| tool | moon spinner + the running category (`Running commands`, `Reading files`, `Calling tools`); a subagent spawn keeps `Deep diving` because the agents pane shows it |
| thinking | braille spinner + `Thinking` |
| composing | braille spinner + `Writing` — no output cursor; this line is the "writing" signal |
| stopping | a static `■ interrupting...` while an interrupt drains |
| idle | a one-row placeholder (stable dock edge) |
| dialog open | the row hides (a panel holds the editor slot) |

In Standard, the tip's slot carries the running action instead: the command, path, or query (a generic or MCP tool shows its name, `server › tool`), or the latest reasoning paragraph while thinking. Compact stays minimal, and Detailed and Verbose already show the running card in the transcript, so they carry no detail; neither does a file write or edit, whose diff card is on screen. As the terminal narrows, the row sheds the tail first (a long detail truncates before it goes), then the rate, the counters, the elapsed time, and finally the label; it never wraps.

## Queue pane

Follow-ups you submit while the agent runs queue in the harness inbox — the pane leads with a divider and lists one row per message: messages awaiting the next turn carry a `Queued:` prefix and steer messages carry a `Steer:` prefix (user messages only). Empty queue, zero rows.

↑/↓ always belong to editor history — the queue pane only displays pending messages and never takes over keys (see [Input editor](/en/features/editor)).

## Todo pane

The session's todo list (whole-list snapshots, last-write-wins) renders under a kimi-style flat-rule frame: a `Todo` title + three-state dots — `✓` completed (muted, struck through), `●` in progress (primary, bold), `○` pending.

- **Five-row folding** — long lists fold to all in-progress first, then the earliest pending and the latest completed; a one-row footer `… +N more (2 done · 1 pending) · ctrl+t to expand` accounts for the hidden items.
- **Ctrl-T** toggles between folded and full (`all N items · ctrl+t to collapse`); the expanded state survives writes and resets on session change or a settled list.
- **All-completed auto-close** — the next write reopens folded.

- **Interrupted runs** — when the latest run failed or was stopped while the list is unsettled, the title adds a muted `· interrupted`.

`todo_write` calls appear in the transcript only as one-row process members (`✓ Updated the plan · 3/5 done`); this pane is the list's live surface.

## Auxiliary conversations (/btw and /agents)

Mayfly retains one auxiliary conversation slot. `/btw <question>` creates a temporary side Agent seeded from the current session's complete event stream and inheriting its provider, model, reasoning effort, and agent preset. `/agents` opens the primary session's complete descendant tree:

- a live BTW or continuable subagent becomes `mayflyCurrentAgent.current()`, switching the existing transcript, status, bottom panes, commands, and complete editor to that Session; BTW retains the full parent seed for model context, while the transcript starts at BTW's first question and hides inherited history; images, follow-ups, steer, retraction, and interrupts use the same input pipeline;
- a one-shot or currently non-resident continuable child does not activate an Agent. It opens a core-owned, full-fidelity readonly transcript panel in the editor slot, reusing the official transcript model, tool presentation, image loading, width containment, and scrolling;
- the centered status explicitly shows the active side and `F7 switch · F8 close`. `F7` toggles primary/auxiliary; `F8` closes the auxiliary view and returns to main. Closing a normal subagent only detaches it, while closing BTW also disposes its temporary Agent;
- opening another BTW or child replaces the retained auxiliary. A bare `/btw` closes the current BTW; `/new`, `/resume`, `/fork`, `/rewind`, and the `/agents` browser return to primary first;
- in `/agents`, `Enter` views a child, `Space` or `←` / `→` expand a branch, and `Tab` reaches **Stop selected**, which asks a Yes / No confirmation (No focused) before stopping a live continuable child. For a one-shot or cold/inactive child, or one that still owns live descendants, Stop shows why it cannot run instead of asking. `/agents stop <id>` is the direct path. Harness recursively releases live descendants owned by a destroyed Agent, so Mayfly refuses a target that still owns live descendants and requires leaf-first teardown.

## Subagent-group pane (agents)

While the agent's **subagent group** runs, its group card is pinned directly above the editor — the last dock row (the kimi swarm-pane semantics). Spawn-class calls (`subagent` and any `subagent_*` provider) appear in the transcript as one-row members, count as subagents in the settled turn header, and join a group title (`Coordinated subagents`) once they settle; the activity row leaves them to this pane. This pane alone shows each agent live: its task, phase, model, effort, estimated output (`↓`, characters / 4), tools, elapsed time, tokens, and current activity. The summary row adds a phase breakdown only when phases differ, and a group clock only when several agents run. A settled group stays until the next turn starts; a call left unanswered when its turn ended reads `cancelled` rather than running forever.

## Workflow pane

After native `workflow/*` lifecycle facts are attributed to the current Agent, this pane shows the workflow name, current phase, running/completed/failed child-Agent tree, and elapsed time updated once per second. A settled summary remains until the next relevant state replacement; switching primary/auxiliary Agents switches this pane with every other session-scoped surface.
