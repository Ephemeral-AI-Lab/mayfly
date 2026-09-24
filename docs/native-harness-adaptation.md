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
- `/schedule` displays active native reminders. Creation/cancellation stays in
  the conversation. Delivery requires a live root Agent; overdue reminders resume
  when their session resumes. Mount `@deepseek-ai/dsh-schedule` in profile files
  before creating/resuming that Agent. There is no independent background daemon.
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

## Built-in Agent Team

Agent Team ships in the default Mayfly bundle. Start Mayfly normally:

```sh
mayfly
```

The default composition mounts native Team services and tools once. All shipped
presets use those Team tools instead of overlapping ordinary subagent controls;
the presets retain their remaining differences, including PTC and creative tools.
No separate Team profile, optional bundle, or copied patch is required.

The Team UI follows the official Web panel: roster, shared tasks, and ordinary
member-conversation navigation. Task creation and coordination belong to native
Team tools. The panel has no task editor or configuration wizard.

Ask the Lead explicitly to use Agent Team, then open `/team`. Select a member to
inspect its conversation, and select the Lead to return. F7 switches the retained
views; F8 closes the auxiliary view. Cold continuable history offers `i` to reply;
only Send resumes the child through Harness's addressed-subagent path. One-shot
history remains read-only. Closing a view does not stop a teammate.

Team write scopes are advisory. Members share a checkout, as in upstream. Team
remains experimental, including upstream's one-shot Workflow tool-visibility
limitation.

## Development acceptance

Use dedicated `mayfly-<tag>` profiles, never production `mayfly`. Exercise the
existing marketplace install/remove flow and its restart boundary; default Team
roster/task updates and live/cold navigation; narrow terminal layouts; reminder
visibility; explicit resource/file reads; and archive refusal followed by explicit
stop-and-archive. Verify configuration and user data survive each workflow.
