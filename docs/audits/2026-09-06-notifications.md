# Mayfly notification and queue audit

Date: 2026-09-06. Baseline: `bd171aa`, Harness `0.1.2-alpha.5`.
Scope: official interaction, app, transcript, core, plus the native dsh
production path for this round's permission message. This round is a behavior
audit; no runtime code was changed.

## Why switching permissions shows queued / step

Switching permissions and delivering a message to the model are two different
things, and the current UI merges them:

1. `/permission danger-full-access` calls the native permission-presets.
2. That service updates the permission first, then calls
   `approval.setPolicy(agent, 'never')`.
3. After `setPolicy()` writes `approval/policy`, it uses `agent.inject()` to
   enqueue a message for the model's next step, with source
   `{ kind: 'plugin', plugin: 'user-approval' }`.
4. [pane-queue.ts](../../packages/mayfly/src/interaction/pane-queue.ts)
   unconditionally iterates `inbox.nextTurn` and `inbox.nextStep` and renders
   every message as `queued / turn` or `queued / step`, without checking the
   source.
5. Ordinary user feedback takes a different path — the notice below the editor
   with content `preset danger-full-access`. It disappears on the next edit,
   clear, or Agent-selection callback; inbox messages wait to be consumed or
   withdrawn.

So the queued text in the screenshot is not the permission not yet taking
effect — it is the change explanation for the model that has not been
delivered. When the user stops sending messages it keeps occupying the area
above the editor, and repeated switching can accumulate several change
explanations pointing in opposite directions.

The same source is hidden again at another stage:
[conversation/projection.ts](../../packages/mayfly/src/conversation/projection.ts)'s
`user/message` branch only renders `source.kind === 'user'`. So an internal
message is displayed while "waiting for the model to read" but not displayed
as a user message once it enters the recorded session — the source policy is
inconsistent between the two stages. `plan-mode` also injects plugin-sourced
status explanations, so the problem is not limited to approval.

Native evidence comes from the corresponding versions of `lib/index.js` in the
installed `@deepseek-ai/dsh-permission-presets` and
`@deepseek-ai/dsh-user-approval`. For the meaning of native approval, see the
[Harness approval reference](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/approval/).

The fix belongs in the UI's message classification and routing, keeping the
native inbox messages the model should receive; the model message must not be
deleted just to remove text from the screen, nor filtered by matching that
particular English sentence.

## Current display paths

| Type | Produced/held at | Displayed at | Lifecycle |
| --- | --- | --- | --- |
| Generic operation feedback | `SharedEditor.notice(text)`; the single `notice` variable in `input-plugin` | Below the editor box, above the status bar | Later writes overwrite earlier ones; cleared by editing, submit, a selection callback, or an empty string; lost after input reload |
| Pending messages | Native `Agent.inbox`; read by `pane-queue` | Bottom pane above the editor | Follows the exact Agent; refreshed on insert / claim / discard |
| Settings feedback | `SettingsPanelNotice` | Below the first-level settings panel, inside the second-level panel's footer | Panel-private state; until replaced, closed, or cleared by locale refresh |
| Marketplace feedback | `panelStatus: OperationStatus` | Marketplace panel header | Panel-private state, keeps tone; sibling imperative actions instead use the editor notice |
| Update-available hint | `local.update-offer` + editor notice | Shown in the content area and below the editor simultaneously | The content slot lives with its creator Fiber; the hint disappears earlier; a cache hit remounts it |
| Update-interrupted warning | `local.update-interrupted` | Content area | Reads the persisted pending marker; the slot lives with the Fiber; the shown line is truncated |
| Update progress and failure details | `UpdateProgressState` + document panel | A standalone progress/result panel; a notice is emitted after closing | Cannot be closed while running, closable afterward; has a log path and rollback status |
| App navigation errors | stderr output in `app/index.ts` | Bypasses managed UI surfaces | Not governed by notification clearing, priority, or session ownership |
| Shell output, tool results, session errors | local shell slot or session projection | Content area / the corresponding tool entry | Operation results and session content — should not be migrated wholesale into transient notifications |
| plan / yolo / jobs and other current state | Native state + status contribution | footer | Current state is shown continuously, independent of whether a notification has disappeared |

## Problems and inconsistencies

### P1: Internal model explanations are displayed as queued user tasks

Location: `pane-queue.ts:23`, compare `conversation/projection.ts:430`.

The symptom is this round's screenshot. Beyond exposing the internal
`turn` / `step` terminology, it makes the user misjudge that "an operation is
still waiting". The queue also lacks a source indicator; a user message
containing only an image renders as an empty `queued / turn:`. The existing
queue unit tests only construct user text, and the image test even explicitly
accepts empty text — plugin-sourced policy messages are not covered.

Recommendation: only content the user actively submitted but which has not yet
been processed enters the task queue; runtime policy explanations stay in the
native model channel. The attachment queue should show an attachment summary.
A user-facing notification produced proactively by a plugin should be
expressed through an explicit UI contribution or notification semantic, not
automatically treated as a queued user task just because it sits in the inbox.

### P1: Failures inside a panel are written into a hidden notification area

Location: `render()` / `renderHint()` in
[editor-dock-host.ts](https://github.com/Ephemeral-AI-Lab/mayfly/blob/bd171aa/packages/mayfly/src/interaction/editor-dock-host.ts).

Whenever the panel stack is non-empty, the host paints only the topmost panel
and never paints the editor hint. Yet the following call
`getSharedEditor(...).notice(...)` while keeping the panel open:

- [agents-command.ts](../../packages/mayfly/src/interaction/agents-command.ts):
  the stop-refusal branches for one-shot, no-longer-live, and
  has-live-descendants.
- [jobs.ts](../../packages/mayfly/src/interaction/jobs.ts): failing to read
  details, kill refused.
- [preset-commands.ts](../../packages/mayfly/src/interaction/preset-commands.ts):
  selecting a corrupted preset.
- [permission-panel.ts](../../packages/mayfly/src/interaction/permission-panel.ts):
  the refusal branch for derived custom.
- [provider-add.ts](../../packages/mayfly/src/interaction/provider-add.ts): the
  URL and verification code from OAuth `notify()` can be hidden while the
  authorization prompt is open.

What the user sees is that keys seem unresponsive, and the previous error pops
up after the panel closes. The settings panel explicitly knows this
limitation, so it built `SettingsPanelNotice` separately; the marketplace built
`OperationStatus` on its own. There is no unified policy rendered in different
places — the difference is only whether each feature routes around the trap
itself.

Recommendation: keep a unified feedback outlet below the current interaction
surface, visible even while a panel is open; field validation stays beside the
field, and full progress/result details stay in their owning panel.

### P1: Late feedback lands on a different Agent

Location: the `commands.execute(agent, ...).then(...)` at
`input-plugin.ts:445`; `permission-panel.ts:98`; `mode-commands.ts:59`.

The generic command-result callback only checks whether the input Fiber is
unloaded — not whether the user has switched to another Agent. Switching
clears the old notice, but the old operation finishes afterward and writes its
stale result into the now-global hint. The permission panel and hotkeys also
publish results through "the current shared editor" without recording the
Agent/selection generation at initiation.

Recommendation: a feedback record binds the scope and operation ID at
initiation. Session-level results display on the corresponding session;
application/profile-level operations may span sessions but must mark their
target explicitly — "only check unload" must not be applied uniformly.

### P1: Severity is lost; errors cannot be reliably told apart from info

Location: `editor-instance.ts:22`, `input-plugin.ts:192`,
`plugin-commands.ts:161`, `paste-image.ts:520`.

The generic interface is just a string — there is no `severity`. Ordinary
command errors get `colors.error` applied by the caller first, while paste
failures, jobs failures, and the like pass a bare string; HintLine then
uniformly applies muted. One cannot claim nested colors all die just because
the outer layer is muted, but the final visual genuinely depends on whether
each call site pre-colored.

The clearest contrast is the marketplace: the in-panel reporter keeps
`{ text, tone }`; the imperative default reporter sends only `status.text`,
dropping danger/success. The same installation failure renders differently
depending on the entry point.

Recommendation: producers pass structured severity and the renderer decides
color and markers uniformly; ANSI encoding must not be treated as notification
semantics.

### P2: Notifications overwrite each other and can be cleared by unrelated flows

Location: `input-plugin.ts:298`, `commands-plugin.ts:163`,
`input-plugin.ts:775`.

All producers write the same variable. `/sessions` ends its scan with
`notice('')` to clear "loading sessions", but a new error raised meanwhile is
cleared along with it; "new messages available" during scroll pause can
similarly overwrite an operation failure. With no stable ID, owner, or
replace/clear-by-ID, a cleanup action cannot prove which message it deleted.

Recommendation: progress and result for the same operation update by ID, and
clearing may only clear its own messages. A scroll hint is a state and must not
preempt important operation feedback.

### P2: Duration depends on the implementation path, not message semantics

Location: `input-plugin.ts:653` / `:685`, `settings-command.ts:1021`,
`updater/check.ts:192`.

A hint is not a timed toast: untouched it can persist indefinitely, editing any
character clears it immediately, and an input/theme reload loses it. Settings'
own feedback clears on locale refresh, while the update slot lives
independently of input/theme. The same error may vanish on one keystroke,
survive hidden behind a panel, or occupy the content area permanently.

Recommendation: define clearing conditions separately for success/info,
in-flight operations, warning/error, and recovery warnings; in-flight feedback
settles with its operation, important failures offer reviewable details — not
everything can be bound to the editor's onChange.

### P2: Truncation and detail access for long notifications are inconsistent

Location: `input-plugin.ts:199`, `render()` in
[update-notice.ts](../../packages/mayfly/src/interaction/update-notice.ts),
compare `update-command.ts`'s document panel.

A hint is capped at eight lines; beyond that it shows only `... more` with no
expand action; the update-available and update-interrupted hints truncate line
by line, so information like the recovery path may be unreadable on a narrow
screen. Yet the update-failure full progress panel has scrolling and a log
path — proof that a more suitable detail surface already exists.

Recommendation: a short summary goes in the feedback area, and long text gets
an explicit view-details entry; a truncation marker must not imply a "more"
that is not actually actionable.

### P2: Repeated display and clearing for the same fact are out of sync

Location: `updater/check.ts:207` / `:211`; this round's permission inbox + hint
+ footer.

The update hint mounts a content slot and emits a hint simultaneously, with no
shared acknowledgement or clearing state between them. The permission footer,
success feedback, and model explanation each read data with different
lifecycles. Durable state and short feedback coexisting is reasonable on its
own; repeatedly presenting the same internal change sentence adds no useful
information.

Recommendation: give each fact one primary display location. The footer means
current state, the notice means the result of this operation, and the queue
only means pending input.

### P2: Some recoverable errors go only to the terminal or the logger

Location: `app/index.ts:175` / `:183` / `:199` / `:216`;
`permission-panel.ts:111`; `mode-commands.ts:66`.

resume/new/fork/rewind failures go to stderr; ordinary command failures go to
the red hint below; some picker/hotkey execution exceptions only hit the
logger. The same "user action failed" has no unified visible result.

Core already has output recovery in
[terminal.ts](../../packages/mayfly/src/core/terminal.ts) — after bypassed
stdout/stderr in alternate mode it repaints — so this cannot be described as
inevitably breaking the terminal. The problem is that repainting does not turn
the raw output into a manageable, reviewable notification; the text may flash
and then be covered by a restored frame.

Recommendation: errors before startup, when no UI can be built, or during exit
keep using stderr; recoverable action failures while the UI is running should
also land in their owning feedback area, with logs serving only as detailed
diagnostics.

### P3: Documentation has drifted from the real layout

Location: the `input-plugin.ts` file header still says "flattened to one
display row before truncation", while HintLine actually wraps and keeps up to
eight lines; the `SettingsNoticeController` comment still says "always exactly
one row", while canonical text actually wraps and the empty state does not
retain that row; `docs/mayfly-architecture.md` classifies temporary
notice/echo under local activity, while many notices actually belong to the
editor dock.

Recommendation: settle the notification model and locations first, then sync
these ownership and layout descriptions — otherwise later implementations will
keep picking the wrong outlet based on stale descriptions.

## Content that must not be conflated with notifications

- Prompts/steers the user genuinely queued: pending input that belongs in the
  queue; it should not all move to the hint because of the internal
  policy-message problem.
- plan/yolo, task counts, etc.: current state, belongs in the footer/pane.
- Tool errors and execution results: belong to the corresponding session/tool
  entry; a transient notification that then loses context is not enough.
- Field validation: should sit beside the field; approvals and questions are
  interactions awaiting a user answer and must not degrade into notifications.
- Output of a shell the user ran manually: a local operation result; update
  logs: long-task details — both legitimately have their own content areas.

## Suggested unified direction

| Semantics | Default presentation |
| --- | --- |
| Internal runtime note for the model | Keep the native model message; do not enter the user queue panel |
| User pending input | Queue above the editor, with an understandable target and attachment summary |
| Short operation result, warning, error | A unified feedback area below the current editor or panel, above the footer |
| Field validation | Beside the original field, with a summary when needed |
| Long-task progress/details | The owning panel; the feedback area provides a summary or a details action |
| Current state | The footer or the corresponding pane |

A unified record needs at least source/owner, scope (app/session/panel),
operation ID, severity, state, body/details, and a clearing policy. This can be
unified inside the existing interaction owner and existing slots — no new
public UI service is needed; renderers still consume readonly data and dsh
keeps owning domain state.

Suggested implementation order: fix the queue's source classification first;
then give panels a visible feedback outlet; then message ownership, async
generations, update/clear by ID, and severity; finally unify long text,
duplicate hints, and documentation.

## Verification evidence

Five isolated ad-hoc Vitest probes ran the existing source directly, and all
reproduced the current state:

1. A plugin-sourced policy message renders as `queued / step`.
2. While a panel is open a notice is not shown; it appears only after closing.
3. One producer's empty-string clear wipes another producer's new message.
4. A slow command from the old Agent finishes and writes into the new Agent's
   hint.
5. A twelve-line notification keeps only eight lines ending in `... more`, and
   the rest is invisible.

Execution record: `/tmp/mayfly-notification-audit-probes.log`. These probes
prove the problems exist — they do not mean fixes are done, and they were not
written into product tests to cement the undesirable behaviors. The original
runtime code and the acceptance profile are unchanged this round.
