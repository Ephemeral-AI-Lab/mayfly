# Native Harness capability map

This map describes the split Mayfly runtime on DeepSeek Harness
`0.2.2-alpha.2`. The immutable UI reference uses `0.2.1-rc.2`; its native values
and old process-local composition do not define the candidate's wire contract.
The Host reads native services and publishes presentation projections. The
independent TUI reads official Client snapshots and sends native Remote writes.

The authoritative sources are the Harness [reference](https://deepseek-harness.github.io/deepseek-harness/reference/),
`docs/subsystems/*.md`, and each package README. This file records only the
subset Mayfly consumes and the rules that keep it native.

## Rules

1. **Current state is native.** If a domain package publishes a
   `SessionProjectionMap` key, Mayfly reads that key; it does not fold the
   underlying events into a second domain store.
2. **Writes are native.** A Mayfly command or panel calls the owning service,
   command, or controller. It never writes `$DSH_HOME/cordis.patch.yml`, runs a
   package manager to install a plugin, or replays a preset by hand.
3. **Transcript projection belongs to the Host.** `mayflyConversation` folds
   committed session events into terminal transcript rows. Remote consumes its
   whole snapshots and overlays only the current attempt's transient output;
   it never folds a second durable transcript or domain store. Host statistics
   and trace queries also derive presentation facts from native passive reads.
4. **Presentation-only keys are Mayfly's.** `mayflyConversationFacts` holds
   phase, activity, output progress, retries, compaction/approval marks, run
   outcome, and spawn-call presentation facts that no native projection
   exposes. It must not repeat a native domain value.
5. **No private internals.** Do not read loader `FiberState` numbers, plugin
   manifests as configuration, parser prose from a native tool result, or the
   projection cache as a session list. Do not guess MCP state from numeric
   indexes.
6. **No duplicate command names.** A native command owns its name. Mayfly adds
   a different name (for example `/permissions`, `/save`) when it needs a
   terminal panel.
7. **Sessions are browsed natively.** `/sessions` reads the official Client
   catalog, projection reads, and Workspace registry. It never opens
   `sessionPersistence` to list sessions, consults no private projection cache,
   and never starts a migration. A `migration-required` read shows cached
   values and a notice; opening the Session is the explicit migration.

## Native projections

| Key | Package | Mayfly consumer |
|---|---|---|
| `title` | `@deepseek-ai/dsh-session-title` | banner, transcript header, sessions list |
| `goal` | `@deepseek-ai/dsh-goal` | Goal item |
| `todos` | `@deepseek-ai/dsh-tool-todo` | Todo item |
| `plan` | `@deepseek-ai/dsh-plan-mode` | mode status, plan questions |
| `permissions` | `@deepseek-ai/dsh-permission-presets` | mode status, permissions panel |
| `userQuestions` | `@deepseek-ai/dsh-user-questions` | question panel |
| `subagentCatalog` | `@deepseek-ai/dsh-subagent` | native descendant catalog behind Host `subagentTree` |
| `subagent` | `@deepseek-ai/dsh-subagent` | child identity and mode |
| `subagentTiming` | `@deepseek-ai/dsh-subagent` | Agents timing and activity |
| `modelSelection` | `@deepseek-ai/dsh-api-session-controller` | model status, banner, sessions list |
| `workingDirectory` | `@deepseek-ai/dsh-working-directory` | cwd/git status, file mentions, skills, deliverables |
| `sessionStats` | `@deepseek-ai/dsh-session-stats` | status, `/context`, sessions detail |
| `tokenUsage` | `@deepseek-ai/dsh-token-meter` | context status, sessions list |
| `contextPressure` | `@deepseek-ai/dsh-token-meter` | context status, notices |
| `contextBreakdown` | `@deepseek-ai/dsh-token-meter` | `/context` composition |
| `sessionListMetadata` | `@deepseek-ai/dsh-api-session-controller` | sessions list last-prompt time |
| `agentPreset` | `@deepseek-ai/dsh-agent-preset-registry` | preset display |

Host plugins read with `ctx.sessionProjections.snapshot(session, keys)`,
`stateOf` for host-only state, and `onChanged` for subscriptions. A session
summary from `ctx.sessionController.list()` may carry the same projections as
hints. For cold or remote sessions use
`ctx.sessionController.projections({ sessionId })`; it returns a `sequenced`
read or `migration-required` cached hints, and never starts migration.
Remote reads the corresponding official Client projection faces and catalog
snapshots. A passive `remote.session.projections({ sessionId })` reads complete
child facts without retaining a Session or activating an Agent; a previously
ready Client catalog entry alone does not establish that later child facts
have refreshed.

The `workingDirectory` projection is the directory every current operation
uses. `Session.header.cwd` is the immutable original project identity used by
workspace membership, archive grouping, and permission roots; it is a
fallback only when no working-directory service is composed.

## Native services and controllers

| Capability | Service | Mayfly use |
|---|---|---|
| Session lifecycle | `ctx.sessionController` | create/prompt/cancel/fork/rename/page/follow/projections/selectModel |
| Session registry | `ctx.sessions` | live Session list; `flush` before a durable `/save` read |
| Agents | `ctx.agents` | exact live Agent lookup only |
| Tools | `ctx.tools` | schemas/get/execute for the exact Agent |
| Commands | `ctx.commands` | register Mayfly-only names; execute native commands |
| Approvals | `approval/request` event | answer through the decision card; no parallel approval store |
| Questions | `ctx.userQuestions` | answer `user-questions/request`; read projection |
| Plan | `ctx.planMode` / `/plan` | display projection; write through service/command |
| Goal | `ctx.goals` / `/goal` | display projection; write through service/command |
| Jobs | `ctx.jobs` | list/get/readAt/kill; durable `job/registered`/`job/settled` |
| Subagents | `ctx.subagents` | `startActivation`, `listChildren`/`listDescendants`, `drainChildren`, catalog/control |
| Schedule | `ctx.schedule` | selected Session's `list`; tasks are Host-wide and Session-bound |
| Settings | `ctx.settings` / `ctx.settingsController` | describe/mutate; never patch YAML |
| Models | `ctx.llm` / `ctx.agentDefaultModel` | catalog/defaults; selection through the controller |
| Credentials/account | `ctx.credentials*`, `ctx.authorization`, `ctx.deepseekAccount` | sign-in UI and redacted views |
| Skills | `ctx.skills` | list/snapshot only |
| MCP | `ctx.mcpResources` / `ctx.tools` | resources through the exact Agent's tool pipeline |
| File references | `ctx.fileReferences` | `list(agent, query, signal)` plus the official mention grammar |
| Deliverables | `deliverables/presented` + `ctx.workspaceChanges` | `/files` cards and changed-file summaries |
| Workspace | `ctx.workspaceRegistry` | `WorkspaceId`, archive, pin, grouping |
| Plugins | `ctx.pluginManager` | `listBundles`, `installBundle`, `removeBundle`, `setBundleEnabled` |
| Working directory | `ctx.workingDirectory` | service-side changes mirrored by the `workingDirectory` projection |
| Permissions | `ctx.permissionPresets` | catalog/current; `/permission` remains native |
| Session query | `ctx.sessionQuery` | `/trace`, `/stats` history; no second log store |
| Persistence | native Session Query/controller | Host passive presentation queries; no TUI filesystem access or persistence-based session browsing |

These services stay in the Host process. Remote uses their existing official
Remote namespaces, Session faces, and native file routes. The focused
`mayflyHost` namespace adds serializable presentation queries and guarded
writes where the stock transport lacks them; see the
[Host package API](../packages/host/README.md) for its exact methods. It is not
an arbitrary service invocation or filesystem facade.

`ctx.pluginManager` owns all profile changes. The marketplace index is a
read-only discovery source; Mayfly renders the manager's `ChangeResult` and
restart semantics, and never spawns a package-manager process or edits a
profile file.

`tool-schedule` is a preset row, not a Host attachment. The shipped
`standard`, `ptc`, `cordis`, and `mayfly-cordis` presets mount it; `minimal`
does not. The Host `schedule` service stays Host-wide and comes enabled from
the composed `dsh-web-app` row; a profile can disable it. `/schedule` reads the
selected Session's active reminders through native `remote.schedule.list`
and refreshes on `schedule/changed`. The readonly panel does not require
`schedule_create` in that preset. Reminder creation and cancellation remain in
the conversation; the TUI does not add an `all` task-browser mode.

## Mayfly-owned keys

| Key | Owner | Contents |
|---|---|---|
| `mayflyConversation` | Host `conversation/projection.ts` | terminal transcript rows: user/assistant/thinking/tool/error/interrupted/goal/compaction/turn history |
| `mayflyConversationFacts` | Host `conversation/facts.ts` | presentation-only facts: phase, activity, output progress, retries, per-step measurements, approvals, compactions, run outcome, spawn calls |
| `mayflyDeliverables` | Host `conversation/deliverables.ts` | latest `deliverables/presented` files; Harness has the event but no projection key |
| `mayflyJobs` | Host `conversation/jobs.ts` | durable settled job presentation, paired with the native resident roster |
| `mayflyWorkflow` | Host `remote/workflow.ts` | whole workflow baseline for native snapshot-stream replacement |
| `mayflyRetraction` | Host `remote/retraction.ts` | guarded turn-retraction presentation state |

`mayflyConversationFacts` no longer carries `todos`, `contextTokens`,
`contextWindow`, `flowUp`, `model`, `provider`, or `reasoningEffort`; those
are native values.

## Command ownership

A native Host command owns its name. The Remote editor discovers the exact
selected Session's native catalog and routes frontend commands locally before
native dispatch. Aliases (`/q`, `/exit`, `/clear`, `/resume`) are frontend
rewrites. Sessionless `/plan` records startup intent; a selected Session's
`/plan` uses native admission and ordered image/file attachments.

| Owner | Commands |
|---|---|
| Native Host | `/permission`, `/plan`, `/goal`, `/compact`, `/feedback`, plus that Host's discovered command catalog |
| Mayfly | `/permissions`, `/save`, `/copy`, `/sessions`, `/new`, `/fork`, `/rewind`, `/rename`, `/help`, `/mode`, `/model`, `/effort`, `/provider`, `/plugin`, `/preset`, `/mcp`, `/skills`, `/tools`, `/stats`, `/context`, `/version`, `/changelog`, `/trace`, `/update`, `/init`, `/schedule`, `/jobs`, `/agents`, `/btw`, `/quit`, `/theme`, `/settings`, `/files` |

The Remote's `/save` and `/export` write local files from Host-projected
conversation data; `full` explicitly reads passive native audit pages. They do
not invoke the Web download command or read Host paths locally. Permission
presets use Mayfly's `/permissions` panel; native `/permission` retains its
name and argument form. `/host`, `/attach`, `/detach`, and `/host-status` are
additional frontend-local connection commands.

## Enforcement

`tests/architecture/native-capability.spec.ts` scans source for projection and
service names, command registrations, direct profile writes, loader internals,
session-browsing persistence reads, current-operation header cwd reads, and
known prose/flag guesses. A new key or service must be added here with its
native owner; a Mayfly-owned key must be justified under the rules above.
