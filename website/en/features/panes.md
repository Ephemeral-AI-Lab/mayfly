# Bottom panes

Between the status bar and the input editor sits the **bottom dock**: five passive panes stacked by priority (activity → queue → todo → agents → workflow, editor last). Panes with nothing to say render zero rows, so the dock does not jump. BTW and sessions opened from `/agents` are not panes: they switch the current Agent or use the shared readonly session panel.

## Activity pane

A mode machine over the attached session's event stream, telling you what the agent is doing:

| Mode | Presentation |
| --- | --- |
| waiting | moon spinner + rotating tip (a new tip when the loading kind changes) |
| tool | moon spinner + the running tool's name (MCP tools read `server › tool`) |
| thinking | braille `thinking...` line with the phase's token count and rate — the transcript's thinking block stays static, so this row is the sole spinner and the dock never collapses mid-turn |
| composing | braille `working...` line (primary-colored frames + an inline tip) — no output cursor; this line is the "writing" signal |
| idle | a one-row placeholder (stable dock edge) |
| dialog open | the row hides (a panel holds the editor slot) |

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

While the agent's **subagent group** runs, its group card is pinned directly above the editor — the last dock row (the kimi swarm-pane semantics). Spawn-class calls (`subagent` and any `subagent_*` provider) count in the transcript's process titles and turn header and appear there as one-row members, while this pane shows who was spawned and what each is doing live. A settled group stays until the next turn starts; a call left unanswered when its turn ended reads `cancelled` rather than running forever.

## Workflow pane

After native `workflow/*` lifecycle facts are attributed to the current Agent, this pane shows the workflow name, current phase, running/completed/failed child-Agent tree, and elapsed time updated once per second. A settled summary remains until the next relevant state replacement; switching primary/auxiliary Agents switches this pane with every other session-scoped surface.
