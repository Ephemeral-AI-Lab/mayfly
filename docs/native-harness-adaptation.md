# Native-first Harness adaptation

Mayfly targets Harness `0.2.1-rc.1` and follows its native contracts rather
than carrying a compatibility layer. Native services own session lifecycle,
working directories, scheduling, subagent activations, tool execution, and
plugin management. Mayfly supplies terminal presentation, current-Agent
selection, and its one transcript history fold. Read
[native-capability-map.md](./native-capability-map.md) for the exact
projections, services, keys, and command owners.

## Personas and context

Mayfly composes no `{{cwd}}` variable and does not interpolate the working
directory into a persona. A persona may use `{{model}}`; the effective
directory is the native `workingDirectory` projection, delivered to the model
through the native working-directory context. A Session header keeps the
original project directory for workspace identity only. Terminal Sessions
carry no browser timezone metadata, so time context falls back to the process
zone.

## Schedule is Host-wide, its tools are preset-scoped

The Schedule capability is the durable Host-wide `ctx.schedule` service.
Mayfly inserts its row disabled; a profile enables it with `disabled: false`.
The model-facing `schedule_create`, `schedule_list`, `schedule_update`, and
`schedule_delete` tools come from the preset-owned `tool-schedule` row:
`standard`, `ptc`, `cordis`, and `mayfly-cordis` mount it, `minimal` omits it.
There is no Host attachment that adds these tools to every root Agent.

`/schedule` reads the selected Agent's Session list through the native service,
observes `schedule/changed`, and checks the exact Agent's tool schemas for
`schedule_create`. The panel therefore reports the capability as unavailable
when the service is off or the Agent's preset does not mount the tools.
Delivery is durable: a due reminder resolves its original Session through the
Session Controller and wakes it even when no Agent is running. Creation and
cancellation stay in the conversation.

## Plugins are installed by the native manager

`/plugin` renders the marketplace index but never installs by spawning a CLI or
a package manager. Installed state comes from `ctx.pluginManager.listBundles()`;
install, update, remove, and enable/disable go through `installBundle`,
`removeBundle`, and `setBundleEnabled`. The manager owns exact versions,
compatibility checks, profile locks, pending builds, restart semantics, and the
profile composition. Mayfly only presents its `ChangeResult` and the pending
restart marker. The marketplace index remains a read-only discovery source
until a native index migration exists.

The Harness `dsh plugin` command still exists for non-Mayfly profiles and local
package development; Mayfly's own `/plugin` command does not call it, and no
Mayfly code writes `$DSH_HOME/cordis.patch.yml`.

## Subagents are managed activations

Every delegation is one managed activation. A start returns a child id
immediately; the child runs independently and the parent receives the native
completion notice. There is no foreground/background mode, no
`run_in_background` argument, and no `started subagent` acknowledgement to
parse.

Mayfly reads the parent's durable `subagentCatalog`, the child's `subagent`
and `subagentTiming` projections, and the native `subagent/start` /
`subagent/end` lifecycle. `/agents` and the Agents view list the exact direct
children; `Enter` opens a local child's conversation, and `x` stops a
continuable child through `ctx.subagents.drainChildren`. `/btw` is a native
`fork` activation with its own Agent and history floor; `F7` returns to the
previous conversation and `F8` closes the displayed one. Browsing a cold child
reads native addressed history and never activates it; sending a reply is an
explicit addressed prompt.

## Sessions are read from the native controller

`/sessions` browses the Session Controller catalog, groups it by the native
Workspace registry, and reads a Session's values through
`sessionController.projections`. A `sequenced` value is current state; a
`migration-required` value carries cached hints and a notice, and Mayfly never
starts migration on its own. Opening the Session is the explicit migration.

The listing retains only the summary rows one controller read returned, fenced
by controller instance and read generation. It does not enumerate
`sessionPersistence`, consult `sessionProjectionCache`, read a cold title log,
or keep a second session domain store. The one durable-log read is `/save`,
which flushes the exact Session and opens the persistence handle explicitly to
write a Markdown export.

## Commands and surfaces

- `/save [full] [path]` writes the projected transcript, or the full event
  stream, as Markdown. The old `/export` name is not Mayfly's; it belongs to
  the Web download command.
- `/permissions` is Mayfly's preset panel; the native `/permission` command
  keeps its name and argument form.
- `/rename` writes a user-pinned title through the Session Controller.
- `/model`, `/effort`, `/provider`, `/context`, `/stats`, `/trace`, `/skills`,
  `/tools`, `/mcp`, `/files`, `/jobs`, `/agents`, `/btw`, `/schedule`,
  `/settings`, and `/plugin` read native services and render terminal panels.
- `ask_user_question` may use the native timed mode; a late answer is a
  persisted user message with source kind `user-question-reply`, and Mayfly
  renders it like any other user message.
- Web search and sign-in follow the native `deepseek-account` route; the
  account panel uses the native `deepseekAccount` service and its loopback
  callback, never a stored browser session.
- `mayfly.transcriptView` keeps the native work-details vocabulary:
  `compact`, `standard` (default), `detailed`, and `verbose`.

## Optional Agent Team

Agent Team is provided by the `agent-team` marketplace entry from
`Ephemeral-AI-Lab/dsh-plugins` (`plugins/mayfly-agent-team`). Install it through
`/plugin install agent-team`, restart, create a new session, and select the
`team` preset with `/preset team`. Installation does not change the default or
existing presets. Only Team-preset roots and their native teammates receive the
Team tools, policy, `/team`, and Team UI contributions; ordinary presets retain
upstream delegation.

Ask the Lead explicitly to use Agent Team. `/team` opens members and tasks;
wide layouts show both columns, while narrow layouts use tabs with retained
selection and search. Task details can open the owner's conversation. Closing a
view does not stop a teammate, and Team write scopes are advisory. Missing Team
plugins on a historical-session resume must be resolved by reinstalling the
matching plugin, not by replacing the saved preset or deleting its log.

## Development acceptance

Use dedicated `mayfly-<tag>` profiles, never production `mayfly`; never link a
checkout into production. Exercise `/plugin` install/update/remove and the
restart boundary, `/sessions` browsing including a migration-required session,
working-directory changes with native file mentions and skills, managed
subagent activation/completion and `drainChildren`, bash jobs, Schedule in both
`standard` and `minimal`, `/permissions` and `/save`, `/btw`, narrow widths,
and a core reload. Verify that configuration and user data survive each
workflow.
