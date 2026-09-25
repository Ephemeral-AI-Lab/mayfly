# Native Harness features in Mayfly

Mayfly targets Harness 0.1.7-rc.1. Native services own session lifecycle,
scheduling, Team coordination, and tool execution. Mayfly provides terminal
presentation and current-Agent selection.

## Commands and breaking changes

- `/plugin` retains the marketplace browser, cache, install/remove commands,
  `marketIndexUrl`, and CLI-backed installer. Package changes take effect after
  restarting Mayfly and starting a new session. HMR remains disabled.
- `/sessions` lists native session summaries, filters titles, searches contents
  when native full-text search is configured, and archives/restores sessions.
  Active work requires an explicit Stop activity and archive decision. Archive
  does not delete the session log.
- `/schedule` displays the current Agent's active reminders, overdue first,
  with local and relative times. Creation/cancellation stays in the
  conversation. The shipped `standard` preset mounts
  `@deepseek-ai/dsh-schedule` inside its own composition, so the
  `schedule_create`/`schedule_list`/`schedule_delete` tools and the reminder
  runtime exist only for Agents under that preset — `minimal`, `ptc`,
  `mayfly-cordis`, and other presets carry no row and get no tools — `/schedule`
  there reports the capability as unavailable rather than an empty list. A
  custom preset opts in by adding the same row to its own `config.plugins`. The same
  composition mounts `@deepseek-ai/dsh-time-context` with a five-minute
  durable-injection throttle; terminal sessions carry no browser timezone
  metadata, so timestamps fall back to the process zone. Delivery requires a
  live root Agent; overdue reminders resume when their session resumes. There
  is no independent background daemon. Reminder tools register on the Agent's
  own scope at creation, so a `/preset` switch can neither retract nor grant
  them: the command refuses selections that would flip schedule capability
  against the target composition, and `/new <preset>` starts a session that
  composes the chosen preset instead.
- `/files` displays native `present` deliveries. Preview reads at most 256 KiB;
  binary and rich documents use an explicit external Open action where available.
- `/mcp` server details expose Resources and Templates. Listing reads metadata;
  Read fetches a chosen URI through the exact Agent's native tool pipeline.
- `mayfly.transcriptView` replaces `mayfly.transcript.*`. Values are `compact`,
  `standard` (default), `detailed`, and `verbose`. Completed work folds while final
  replies remain visible; Verbose keeps process rows open. Ctrl+O expands recent
  details. Old per-family settings are no longer interpreted.

These changes do not automatically rewrite user configuration or delete user data.
Remove obsolete keys from settings files when updating.

## Optional Agent Team

Agent Team is provided by the `agent-team` marketplace entry from
`Ephemeral-AI-Lab/dsh-plugins` (`plugins/mayfly-agent-team`). Install it through
`/plugin install agent-team`, restart, create a new session, and select the
`team` preset with `/preset team`. The preset starts from `standard` capabilities;
installation does not change the default or existing presets.

Only Team-preset roots and their native teammates receive the Team tools,
policy, `/team`, and Team UI contributions. Ordinary presets retain upstream
subagent delegation. The plugin consumes native Team projections and owns the
readonly roster/task panel, overlap notices, and conversation actions.

Ask the Lead explicitly to use Agent Team. `/team` opens members and tasks;
wide layouts show both columns, while narrow layouts use tabs with retained
selection and search. Task details can open the owner's conversation.

Generic Mayfly navigation owns exact-Agent selection, F7 switching, and F8
view closure. The public `mayfly/request-subagent-reply` event opens the shared
reply form for the displayed continuable child. Queue waits until the current
turn ends; Steer delivers at the next step boundary. Browsing cold history and
editing drafts do not resume a child; only Send uses the native addressed prompt.
Closing a view does not stop a teammate.

Team write scopes are advisory. Members share a checkout and the upstream
Team runtime remains experimental. Missing Team plugins on historical-session
resume must be resolved by reinstalling the matching plugin, not by replacing
the saved preset or deleting its log.

## Development acceptance

Use dedicated `mayfly-<tag>` profiles, never production `mayfly`. Exercise the
existing marketplace install/remove flow and its restart boundary; optional Team
roster/task updates and live/cold navigation; narrow terminal layouts; reminder
visibility; explicit resource/file reads; and archive refusal followed by explicit
stop-and-archive. Verify configuration and user data survive each workflow.
