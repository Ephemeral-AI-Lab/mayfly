# Bottom panes

Between the transcript and the input editor sits the **bottom dock**: four passive panes stacked by priority, top to bottom workflow → queue → activity → notification, so the notification row sits directly above the editor (the status bar stays below it). Agents, jobs, goal, and todo are not panes: they are the items of the status row ([Status bar](/en/features/status-bar)). Panes with nothing to say render zero rows, so the dock does not jump. BTW and sessions opened from `/agents` are not panes: they are side conversations shown in the transcript pane.

## Dock budget

The dock never takes more than a third of the terminal height. When several panes are active they share one rule instead of repeating it, and rows are handed out by a fixed rule: every pane first gets its head row (title or summary), starting nearest the editor, then the remaining rows go round-robin in the same order. A pane with more rows than its share keeps its head and ends in a muted `… +K more rows`; panes never lose rows from the middle or run into each other. Each pane row is a single line — long labels truncate with `…` instead of wrapping.

## Activity pane

The one live-status row for the current Agent: the transcript only records what happened, while this row says what is happening now — the phase glyph, a present-tense label, the turn's elapsed time, token counters (`↑` context, `↓` estimated output, characters / 4), the output rate while text streams, and a rotating tip:

```
🌔 Deep diving · 3s · Tip: …
⠋ Thinking · 8s · ↓2 · ≈42 tok/s · Tip: …
⠋ Writing · 14s · ↓120 · ≈40 tok/s · Tip: …
🌔 Running commands · 21s · ↑30k ↓4k · pnpm test
```

| Mode | Presentation |
| --- | --- |
| waiting | fill glyph + `Deep diving`; while a tool call's arguments still stream, its preparing label (`Preparing to write files`) |
| tool | still `●` + the running category (`Running commands`, `Reading files`, `Calling tools`); a subagent spawn keeps `Deep diving` because the Agents item shows it |
| thinking | bloom glyph + `Thinking` |
| composing | fill glyph + `Writing` — no output cursor; this line is the "writing" signal |
| stopping | a static `■ interrupting...` while an interrupt drains |
| idle | a one-row placeholder (stable dock edge) |
| dialog open | the row hides (a panel holds the editor slot) |

In Standard, the tip's slot carries the running action instead: the command, path, or query (a generic or MCP tool shows its name, `server › tool`), or the latest reasoning paragraph while thinking. Compact stays minimal, and Detailed and Verbose already show the running card in the transcript, so they carry no detail; neither does a file write or edit, whose diff card is on screen. As the terminal narrows, the row sheds the tail first (a long detail truncates before it goes), then the rate, the counters, the elapsed time, and finally the label; it never wraps.

## Notification pane

One row on the line above the editor — blank when there is nothing to say, so the editor never moves. It shows the notice to read now, the most severe and then the newest of the app's and the current session's records, with a muted `· +N` for the ones waiting behind it. The notice sits at the right edge and may use the whole row between the margins; a notice that is still too long is cut at its front with `…` and keeps its tail, the count or countdown it ends with (`⚠ Rate lim… · retrying in 9s · 1/5`). When the stream is scrolled away from its tail the row also carries the centered `Back to bottom · Ctrl+↓` chip. Side conversations put `F7 btw · F8 close` at its right in place of its idle hint.

While focus is on the conversation or on a search, the keys of that mode take the left of the row as parts the row sheds by priority — `↑/↓ select · Enter expand · c copy · / ? search · Ctrl+G editor · Ctrl+C JSON · Esc back` — and `Esc` is the last to go; the notice yields to its glyph and its tail while the mode holds.

## Queue pane

Follow-ups you submit while the agent runs queue in the harness inbox — the pane leads with a divider and lists one row per message: messages awaiting the next turn carry a `Queued:` prefix and steer messages carry a `Steer:` prefix (user messages only). Empty queue, zero rows.

↑/↓ always belong to editor history — the queue pane only displays pending messages and never takes over keys (see [Input editor](/en/features/editor)).

## Todo view

The session's todo list (whole-list snapshots, last-write-wins) is the **Todo view** of the status row. The row shows only `● todo 2/12 4m 12s` (done over total, and how long the list has been tracked; the time is the first thing a crowded row gives up); when the list settles it reads `✓ todo 12/12 12s` for five seconds and then goes. `Alt+↓` opens its panel under the status row (the row itself stays, with a heavy line under the item): every row with three-state marks — `✓` completed (muted, struck through), `●` in progress (primary, bold), `○` pending — and no heading, count, or time. The panel has one fixed length and scrolls vertically past it, its last row counting the rows still below (`↓ 6 more`); it adds no keys of its own (`↑/↓` scroll, `←/→` switch item, `Esc` returns).

- **History** — completed items are listed only when the `viewHistory` setting is on (off by default).
- **Interrupted runs** — when the latest run failed or was stopped while the list is unsettled, the panel starts with a muted `interrupted`.

`todo_write` calls appear in the transcript only as one-row process members (`✓ Updated the plan · 3/5 done`); this pane is the list's live surface.

## Side conversations (/btw and /agents)

Mayfly keeps the primary conversation and any number of side conversations open at once and shows exactly one of them in the transcript pane. `/btw <question>` creates a temporary side Agent seeded from the current session's complete event stream and inheriting its provider, model, reasoning effort, and agent preset. `/agents` opens the primary session's complete descendant tree:

- every conversation renders in the same transcript pane. A live BTW or continuable subagent becomes `mayflyCurrentAgent.current()`, switching the status, bottom panes, commands, and complete editor to that Session; BTW retains the full parent seed for model context, while the transcript starts at BTW's first question and hides inherited history; images, follow-ups, steer, retraction, and interrupts use the same input pipeline;
- a one-shot child, or a continuable child that is not resident, does not activate an Agent: its transcript loads from native history into the same pane, keeps its own running-turn header (no activity row follows it), and the status marks it `read-only` or `reply to resume`. The editor stays: in a read-only conversation a submitted draft stays in the editor with a notice; in a resumable one it opens the Queue / Steer reply form seeded with the draft, and only **Send** resumes the child. Slash commands still run against the primary;
- a chip in the status line names the displayed conversation (` main `, ` btw `, ` subagent `) while more than one is open, and the right of the notification pane shows `F7 btw · F8 close` in place of its hint (`F7 main · F8 close`, or `F8 detach` for a subagent). `F7` returns to the previously displayed conversation; `F8` closes the displayed side conversation, or the `F7` counterpart while main is displayed. Closing a normal subagent only detaches it, while closing BTW also disposes its temporary Agent;
- opening another child keeps the others open; a new BTW replaces the previous BTW. A bare `/btw` closes the current BTW; `/new`, `/resume`, and `/fork` close every side conversation, while `/rewind` and the `/agents` browser show main first;
- only the displayed conversation and its `F7` counterpart keep transcript state; the others hold nothing until you return to them, so many open conversations stay cheap;
- in `/agents`, `Enter` views a child, `Space` or `←` / `→` expand a branch, and `Tab` reaches **Stop selected**, which asks a Yes / No confirmation (No focused) before stopping a live continuable child. For a one-shot or cold/inactive child, or one that still owns live descendants, Stop shows why it cannot run instead of asking. `/agents stop <id>` is the direct path. Harness recursively releases live descendants owned by a destroyed Agent, so Mayfly refuses a target that still owns live descendants and requires leaf-first teardown.

## Agents view

The subagents of the conversation are the **Agents view** of the status row, not a dock pane. The row shows `● agents 1/3 41s` (settled over all, and how long the oldest working one has run), and it stays for the whole conversation: `✓ agents 3/3 41s`, or `✕` when one failed on its own; a subagent you stopped is no failure. Spawn-class calls (`subagent` and any `subagent_*` provider) are the members, so a subagent shows from the moment its call starts: a call without a result is a **foreground** subagent that blocks the turn (`fg`), one whose `started subagent` acknowledgement landed is a **background** one (`bg`). In the transcript the call's line follows its child: `● Subagent(…) · running in background`, then `✓ … 41s`, `✕ … failed`, or `⊘ … stopped`.

`Alt+↓` opens the panel under the row: a list of every subagent of the conversation, the working ones first, one aligned line each — the mark (`●` working, `✓` done, `✕` failed, `⊘` stopped), the name, the task, `fg`/`bg`, tool count, tokens (total, `↑` in, `↓` out), the output rate while it streams, and the time last. A narrow row gives up columns in a set order (the rate, the `↑` count, the `↓` count, the tag, the tools) and keeps the name, the task, and the time. `↑/↓` choose a row, `Enter` opens its conversation exactly as `/agents` does (`F8` closes it and returns to the view that opened it; `/agents` opens its own browser, which does not return here), `x` stops a continuable child behind a Yes / No confirmation (No focused), and `b` (foreground to background) is listed but unavailable until Harness has a call that ends a running foreground call early. A side conversation (`/btw` or a subagent) lists only the subagents it spawned itself.

## Workflow pane

After native `workflow/*` lifecycle facts are attributed to the current Agent, this pane shows the workflow name, current phase, running/completed/failed child-Agent tree, and elapsed time updated once per second. A run with more than six agents lists its running agents first and counts the rest in a closing `… +K more` row. A settled summary remains until the next relevant state replacement; switching the displayed conversation switches this pane with every other session-scoped surface.
