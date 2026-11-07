# Streaming transcript & tool cards

The transcript layer folds the session event stream into items and renders them. This page describes what you see; the event-to-item rules are identical for live streams and snapshot replay.

## Message items

- **User messages** — `❯` gutter bubbles (`roleUser` color); images render inline where the terminal supports it (12-line cap), otherwise as `[image]` placeholders.
- **Assistant messages** — ordinary-sized output is rendered as Markdown while streaming; oversized output uses a bounded safe tail both live and after close, while the complete raw text remains in the session record. Messages stay separated by blank lines, with the first line bulleted `●` and continuation indented two columns.
- **Thinking blocks** — reasoning streams as its own block above the body. Live it shows only the `✻` marker over the reasoning's last two lines, with no caption or clock: the activity row says `Thinking` and owns the elapsed time, token count, and rate. Once the phase ends it settles into one row, `✻ Thought for 6s`, previewing the first line (Detailed and Verbose, where reasoning shows). Ctrl-O opens the full body.

## Work details

The transcript speaks in the past tense and the bottom activity row in the present: everything live — the spinner, the turn's elapsed time, the current step, and throughput — appears only in the [activity row](/en/features/panes), so no transcript row ticks or says what is running. `mayfly.transcriptView` keeps the Harness Chat mode names; each step up shows more of the work:

| Mode | Running turn | Completed turn | Stopped / failed turn |
| --- | --- | --- | --- |
| Compact | messages only | header + final answer | past-tense titles |
| Standard (default) | messages, file-change cards, past-tense titles | header + file-change cards + final answer | titles + file-change cards |
| Detailed | every card, live | header + file-change cards + final answer | titles + file-change cards |
| Verbose | every card, live | stays open | every card |

- **Turn header** — a turn with process work gets its header row when it ends: `Took 38s`, `Stopped`, or `Failed`, followed by its tool-call and subagent counts (a subagent spawn counts as a subagent, not as a tool call). A running turn has no header; the activity row carries its elapsed time. A completed turn folds its process and interim replies behind this row; a stopped, failed, or steered turn never folds.
- **Process groups** — reasoning and tool calls between two replies form one group. As a title, a group summarizes only work that has finished: `Read files and searched code`, `Ran commands · 1 failed`. A group whose work is still running, or that holds only reasoning, shows no title until something settles.
- **File changes** — from Standard up, any call whose presenter declares the diff card (`Write(path)`, `Edit(path)`, `ApplyPatch`) renders as its diff card, splits the groups around it, and stays visible when the turn folds, so the code changes read next to the final answer. Compact counts them with the rest of the work.
- **Ctrl-O** — opens the fold, the groups, and the card bodies of the most recent **3 turns** (`expandTurns`). Hints name the key only where it reaches; older turns say how much is hidden without promising the key.

## Tool cards

Every call is one line: glyph, the tool's own name, what it was given, what came of it. On a narrow row the target gives way first, so an outcome or a failure's reason survives.

```
✓ Read(src/list.ts) · 120-127 of 128
✓ Grep("onSelect" in src) · 5 matches in 3 files
✓ Bash(pnpm test) · 4.2s
✗ Bash(pnpm lint) · exit 1 · 3s
✓ Write(tests/a.spec.ts) · created · 39 lines · 1.9 KB
✓ WebSearch("keep selection") · 3 sources · 0.1s
✓ github › get_issue(owner=acme, repo=web, issue_number=1423) · 2.1 KB · 0.4s
✗ github › create_issue(title="Notes", teamId=ENG, +2) · 401 Bad credentials · 0.5s
```

- **Commands** — one line; opened, it adds the description and working directory over the output's last rows, and Ctrl-O shows the complete bounded output. A background command reads `background`, and its output belongs to the Jobs view.
- **File changes** — the title (`Edit(src/auth.ts) · +1 −1`) over unified diffs with LCS line coloring; the collapsed card caps at 12 rows. A patch reads its files from the patch itself, a tree of `A`/`M`/`D`/`R` with per-file counts, and each file's diff once it opens.
- **Grouped calls** — consecutive reads, searches, and commands merge into one tree under a head that counts them; a failed member keeps its own `✗`, a non-zero exit included.
- **MCP calls** — `server › tool(arguments)`, where a lone scalar argument reads as its value and several read as up to three `key=value` within 60 characters, then `+N`. The rest are listed under the line at Verbose and on a request you decide on. A run of calls to one server groups under the server's name (`github · 2 calls`). A result says what can be known of it: `N items` for a JSON list, the format and size of a picture, else its size. The Harness flattens results to text, so a typed count such as `12 issues` is not available. JSON opens as rows to read.
- A call still unanswered when its turn ended shows `⊘ cancelled`.

## Long-session window

Only the latest 15 turns stay mounted (`windowTurns`); older turns leave the render tree while their events stay complete in the session record.

## Special cases

- What outlives a call belongs to its view, so the stream carries less of it (see [Bottom panes](/en/features/panes)). A spawn or a workflow is one line, and `Enter` on it moves to the view. A job poll is drawn only at Verbose. Todo and goal calls are never drawn. A call that failed or waits on you is drawn whatever its kind.
- Synthetic injected messages (workspace instructions, context snapshots) **render as nothing** — the content still reaches the model, the stream stays clean (see the [FAQ](/en/guide/faq)).
