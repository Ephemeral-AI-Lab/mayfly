# Approvals & questionnaires

When the agent needs a human decision, Mayfly answers with full-width pull-up panels. Panels mount by **editor-slot replacement**: the panel genuinely takes over the editor's dock slot — the editor leaves the tree (state intact), and only the two-row footer remains below the panel. The editor frame never peeks out from behind. Closing the panel restores the editor with focus and draft intact.

## Approval panel

When a tool call needs authorization, a panel titled `Approve {tool}?` opens with the tool's reason (scrollable when long) and one row of choices:

```
[ Reject ]  Allow once  Allow {tool} for this session  Reject with feedback
```

- **Reject is focused first**, so an accidental Enter never grants access. `←` / `→` or `Tab` move between choices and `Enter` runs one; there are no digit shortcuts on this gate.
- **Session-level remember** — *Allow {tool} for this session* records the tool for this Agent; later requests for the same Agent and tool pass without a panel. The allowance survives switching the displayed view (for example with `F7`) and ends when that Agent is disposed.
- **Reject with feedback** opens a reason field on a second page; `Enter` sends, `Alt+Enter` adds a line, `Esc` ends editing and a second `Esc` returns to the choices. Sending steers the agent with a user message (`User rejected …: <reason>`), so it sees why; an empty reason is a plain Reject.
- **Escape rejects**; an aborted request settles as cancelled.
- **FIFO serialization** — concurrent approval requests queue; one panel shows at a time.

Requests from other agents (not the one displayed) don't open a panel — they pass down the waterfall to the next answerer.

## Questionnaire panel

`ctx.userQuestions` requests (clarifying questions and the like) open one panel with a page per question:

- a tab per question (its header, or `Q{n}`) shows progress; answered steps carry `✓`. `←` / `→` on the tab strip or `Alt+←` / `Alt+→` anywhere switch questions, and moving forward validates the current one, like **Next**;
- options are numbered: `1`–`9` or ↑↓ + `Enter` choose, and a single choice advances to the next question (the last one submits). Single-choice questions end with **No selection**; multi-choice toggles with `Space` and confirms with `Enter`;
- every question has an **Other** field (the only field when there are no options): typing starts an answer, `Enter` advances or submits, `Alt+Enter` adds a line;
- **Back** and **Next** buttons sit under each question; **Submit answers** and **Cancel** sit under the panel;
- `Esc` ends editing first; leaving with unsaved answers asks the shared *Discard unsaved changes?* decision, and discarding rejects the request. An aborted signal closes and rejects it too.

Questionnaire answers enter the session as user-visible content the model can see.

## Confirmations

Every confirmation — full access, stopping a subagent, removing a plugin, deleting a provider, archiving an active session, discarding unsaved changes — is the same shared decision: the question as the title, an optional sentence about consequences, then **No** (focused) and **Yes** (or a specific label such as *Enable* or *Stop*). `Enter` on No, `Esc`, or `Ctrl+C` cancel and return to the original surface with its state intact; only Yes proceeds. `/update` uses the same shape before it starts.

When an action cannot run for the selected row — a one-shot or cold subagent, a plugin that is already installed — the action shows why next to its label and is never offered for confirmation.

## Multi-field forms

Provider onboarding, provider and settings editing, and similar panels use one form model:

- each field is a compact `label: value` row; the focused row carries `→`, and wrapped values continue under it;
- **Up / Down** always move between fields; typing or **Enter** starts editing text, and **Enter** confirms and advances (`Alt+Enter` adds a line in multi-line fields);
- a select changes directly with **Left / Right** (disabled options are skipped) or opens its list with **Enter**; a multiselect opens with **Enter** or **Space**; **Tab** applies an open list or text edit and moves to the next group;
- **Escape** ends editing first; leaving a form with unsaved changes asks before discarding them;
- a validation error renders directly below the failing field without closing the panel; any edit clears it;
- values truncate to the panel width, so long pasted keys never break the frame.

## Plan-review panel

When the agent calls `exit_plan_mode` to wrap up a plan, the plan renders into the conversation and the review decision opens in the editor slot:

```
1. <approve label>
2. <decline label>
3. Other — type feedback to revise the plan
```

- the decline row is focused first; digits `1`–`3` or ↑↓ only move between decisions, and `Enter` confirms the focused one, so approving always takes an explicit Enter;
- `c` copies the plan, `o` opens the feedback field; `PageUp` / `PageDown` / `Shift+↑↓` scroll the plan above;
- feedback submits with `Enter` and becomes a decline-with-feedback (the harness folds it into "their feedback: …"), so the agent iterates on the plan; an empty submission returns to the decisions;
- an aborted signal closes the panel with the cancellation code (`ASK_CANCELLED`).

`Shift+Tab` toggles only normal and plan (see [Session modes](/en/features/modes)), preserving current permissions. YOLO is controlled separately through `/permission` and does not skip plan review; the footer can show plan and yolo together.

## Permission-preset panel

`/permission` opens the permission-preset selector (the same single-select list shape as `/sessions` and `/preset`): one numbered row per preset (a named bundle of sandbox mode + approval policy), the active one marked `← current`. `1`–`9` or ↑↓ + `Enter` switch through the host's same write path; full access first asks the shared decision with its sandbox consequence spelled out. The derived `custom` state is shown but cannot be chosen, and says why. A bare invocation is intercepted by the input layer to open the panel; the command itself is registered by the upstream `dsh-permission-presets`, and argumented calls pass through.
