# Native-first Harness adaptation

Mayfly targets Harness `0.2.2-alpha.3` and follows its native contracts. The
published Mayfly `0.1.4-rc.2` on Harness `0.2.1-rc.2` remains the immutable
appearance, key, and workflow reference. Native services own session lifecycle,
working directories, scheduling, subagent activations, tool execution, and
plugin management. The Mayfly Host supplies durable presentation projections
and focused serializable queries. The separate TUI owns Host/Session selection
and presentation, consuming the official React-free Client. Read
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
The split Host inherits its enabled row from `dsh-web-app`; a profile may
disable it independently of an Agent's preset.
The model-facing `schedule_create`, `schedule_list`, `schedule_update`, and
`schedule_delete` tools come from the preset-owned `tool-schedule` row:
`standard`, `ptc`, `cordis`, and `mayfly-cordis` mount it, `minimal` omits it.
There is no Host attachment that adds these tools to every root Agent.

`/schedule` reads the complete native `remote.schedule.catalog()` and filters
active tasks by the exact selected Session in `involvedSessionIds`; it observes `schedule/changed`. It uses
the shared rc.2 reminder panel, not a Host-wide task browser. A `minimal` preset
without reminder tools can still inspect that Session's reminders; a missing
or failing service renders the panel's unavailable state.
Delivery is durable: a due reminder resolves its original Session through the
Session Controller and wakes it even when no Agent is running. Creation and
cancellation stay in the conversation.

## File uploads use native binary HTTP

The TUI copies local file bytes into a Blob and calls the official Client
`fileUpload.upload` method. Its Node carrier sends the authenticated binary HTTP
route; the Host owns upload receipts, Session scope, and durable attachment data.
Cancellation and stale-selection checks apply before and after upload.

Harness `0.2.2-alpha.3` has a Client injection gap in the Uint8Array Remote
fallback: it accesses `remote.fileUploads` while declaring only `remote`.
Mayfly's TUI uses the supported Blob HTTP path for every file upload. Headless
consumers of the unchanged official `HostClient.fileUpload` service should use
Blob or ReadableStream inputs on this Harness line. Mayfly does not patch the
native plugin or provide a second upload protocol.

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

The Host's `subagentTree` reads native `listDescendants`, preserving the complete
descendant preorder and diagnostics. Exact resident Agents and native
`subagent`, `subagentTiming`, workflow and passive stream facts supply the
readonly presentation metrics. `/agents` and the Agents view display that tree;
`Enter` opens a local child's conversation. `x` or `/agents stop <id>` stops
only a live continuable leaf. The Host rechecks the current authorized tree and
waits for `subagents.drainChildren` through that child's exact direct parent.
External children have no local conversation. Browsing a cold child reads
native addressed history and never activates it; sending a continuable child a
reply is an explicit addressed prompt.

`/btw` uses ordinary native Session Controller fork, not a managed subagent
activation. It inherits the complete observed source tail, including an open
first turn, and returns the inherited boundary for the frontend's history
floor. A genuinely empty source uses native create and has no inherited floor.
`F7` returns to the previous conversation and `F8` closes the displayed view;
neither operation stops Host work.

## Sessions are read from the native controller

`/sessions` browses the Session Controller catalog, groups it by the native
Workspace registry, and reads a Session's values through
`sessionController.projections`. A `sequenced` value is current state; a
`migration-required` value carries cached hints and a notice, and Mayfly never
starts migration on its own. Opening the Session is the explicit migration.

The listing consumes official Client catalog snapshots, fenced by exact Host,
Client and selection generation. It does not enumerate
`sessionPersistence`, consult `sessionProjectionCache`, read a cold title log,
or keep a second session domain store. Ordinary `/save` and `/export` consume
the Host's whole conversation projection; `full` explicitly reads passive
native audit pages. Exported files are created on the TUI machine. Host trace
and statistics queries also use native passive history reads.

## Commands and surfaces

- `/save` and `/export` write the projected transcript, or with `full` the
  native audit stream, on the TUI machine. Relative paths use the TUI working
  directory; absolute paths are supported, parent directories are created, and
  existing files are overwritten. Without a path the generated Markdown
  filename is placed in that same directory. These are not Host filesystem
  paths or Web downloads.
- `/permissions` is Mayfly's preset panel; the native `/permission` command
  keeps its name and argument form.
- `/rename` writes a user-pinned title through the Session Controller.
- `/goal` retains the native command parser, output, refusals and ordered
  objective attachments. Goal and Todo displays use shared rc.2 builders over
  native projections; Goal activation comes from the matching native revision.
  Its edit action returns `/goal edit <objective>` to the prompt.
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

The process-local reference's Agent Team is provided by the `agent-team` marketplace entry from
`Ephemeral-AI-Lab/dsh-plugins` (`plugins/mayfly-agent-team`). Install it through
`/plugin install agent-team`, restart, create a new session, and select the
`team` preset with `/preset team`. Installation does not change the default or
existing presets. Only Team-preset roots and their native teammates receive the
Team tools, policy, `/team`, and Team UI contributions; ordinary presets retain
upstream delegation.

Its Host-native tools and presets can be installed independently. A TUI
contribution must also be integrated into the separate frontend's Cordis tree
and the TUI restarted: installing a Host bundle cannot dynamically mount a
frontend extension through the current official API. Do not claim `/team`
parity from Host installation alone. In the reference composition, asking the
Lead explicitly to use Agent Team makes `/team` open members and tasks;
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
