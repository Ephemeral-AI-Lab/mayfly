# Streaming transcript & tool cards

The transcript layer folds the session event stream into items and renders them. This page describes what you see; the event-to-item rules are identical for live streams and snapshot replay.

## Message items

- **User messages** — `❯` gutter bubbles (`roleUser` color); images render inline where the terminal supports it (12-line cap), otherwise as `[image]` placeholders.
- **Assistant messages** — ordinary-sized output is rendered as Markdown while streaming; oversized output uses a bounded safe tail both live and after close, while the complete raw text remains in the session record. Messages stay separated by blank lines, with the first line bulleted `●` and continuation indented two columns.
- **Thinking blocks** — reasoning streams as its own block above the body. Live it shows a static `✻ Thinking · 6s · ↓1.2k · ≈42 tok/s` header over the reasoning's last two lines (the activity row owns the animated spinner); once the phase ends it settles into one row, `✻ Thought for 6s`, previewing the first line (Standard, Detailed, and Verbose). Ctrl-O opens the full body.

## Work details

`mayfly.transcriptView` follows the Harness Chat work-details modes. Each mode enables a fixed set of capabilities:

| Mode | Completed turn | Process groups | Running title detail | Settled reasoning preview |
| --- | --- | --- | --- | --- |
| Compact | folds behind its header | collapsed | — | — |
| Standard (default) | folds behind its header | collapsed | command, path, query, or reasoning | ✓ |
| Detailed | folds behind its header | collapsed once the turn ends; the running turn stays open | ✓ | ✓ |
| Verbose | stays open | none (every card shows) | — | ✓ |

- **Turn header** — every turn with process work carries one header row: `Deep diving for 12s` while it runs, then `Took 38s`, `Stopped`, or `Failed`, followed by its tool-call and subagent counts. A completed turn folds everything except its final answer behind this row; a stopped, failed, or steered turn never folds.
- **Process groups** — reasoning and tool calls between two replies form one group. Collapsed, a group is a single title: `Read files and searched code` once closed, or the live `Running commands · pnpm test` while its turn runs (Compact drops the detail). Failures add `· N failed`.
- **Ctrl-O** — opens the fold, the groups, and the card bodies of the most recent **3 turns** (`expandTurns`). Hints name the key only where it reaches; older turns say how much is hidden without promising the key.

## Tool cards

- **Terminal card** — `$ command` with an `exit N` or `signal` pill (failures show `✗`) and the run time; the body is the description over the output's last three rows; Ctrl-O shows the complete bounded output.
- **Diff card** — the presenter's title (`Edit src/auth.ts · +1 −1`) over per-file unified diffs with LCS line coloring; the collapsed card caps at 12 rows.
- **Presenter cards** — any other tool with a presenter shows its own call title and its result preview (three rows for text).
- **Grouped calls** — consecutive file reads, code searches, and commands within a step merge into one tree card (`Read 3 files`, `Searched 2 patterns`, `Ran 3 commands`); a partial failure shows `◐` and a per-member `✗`, a non-zero exit included.
- **One-row calls** — delegation, plan and goal updates, questions, web retrieval, skills, and agent messages render as one row (`✓ Searched the web · vitest vi.fn · 5 sources`, `? Also fix signup? → No`); Ctrl-O opens the bounded result.
- **Fallback card** — tools without presenters show `Used name (key argument)` (MCP tools read `server › tool`) with a result preview; JSON results pretty-print when expanded.
- A call still unanswered when its turn ended shows `⊘ cancelled`.

## Long-session window

Only the latest 15 turns stay mounted (`windowTurns`); older turns leave the render tree while their events stay complete in the session record.

## Special cases

- Delegation (`subagent`, `subagent_*`) and `todo_write` calls appear as one-row process members; the agents and todo panes stay their live surfaces (see [Bottom panes](/en/features/panes)).
- Synthetic injected messages (workspace instructions, context snapshots) **render as nothing** — the content still reaches the model, the stream stays clean (see the [FAQ](/en/guide/faq)).
