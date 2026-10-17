# Native Harness capability map

This map is the contract between Mayfly and DeepSeek Harness. Mayfly is a
terminal presentation over native host capabilities: it reads current state
from native projections and services, writes through native services,
commands, and controllers, and folds session events only for its terminal
transcript history.

The authoritative sources are the Harness [reference](https://deepseek-harness.github.io/deepseek-harness/reference/),
`docs/subsystems/*.md`, and each package README. This file records only the
subset Mayfly consumes.

## Rules

1. **Current state is native.** If a domain package publishes a
   `SessionProjectionMap` key, Mayfly reads that key; it does not fold the
   underlying events into a second domain store.
2. **Writes are native.** A Mayfly command or panel calls the owning service,
   command, or controller. It never writes `$DSH_HOME/cordis.patch.yml`, runs a
   package manager to install a plugin, or replays a preset by hand.
3. **History is Mayfly's.** `mayflyConversation` folds committed session events
   into terminal transcript rows because Harness has no host transcript
   projection; this is the one intentional fold.
4. **Presentation-only keys are Mayfly's.** `mayflyConversationFacts` holds
   phase, activity, output progress, retries, compaction/approval marks, run
   outcome, and spawn-call presentation facts that no native projection
   exposes. It must not repeat a native domain value.
5. **No private internals.** Do not read loader `FiberState` numbers, plugin
   manifests as configuration, or parser prose from a native tool result.
6. **No duplicate command names.** A native command owns its name. Mayfly adds
   a different name (for example `/permissions`, `/save`) when it needs a
   terminal panel.

## Native projections

| Key | Package | Mayfly consumer |
|---|---|---|
| `title` | `@deepseek-ai/dsh-session-title` | banner, transcript header, sessions list |
| `goal` | `@deepseek-ai/dsh-goal` | Goal item |
| `todos` | `@deepseek-ai/dsh-tool-todo` | Todo item |
| `plan` | `@deepseek-ai/dsh-plan-mode` | mode status |
| `permissions` | `@deepseek-ai/dsh-permission-presets` | mode status, permission panel |
| `userQuestions` | `@deepseek-ai/dsh-user-questions` | question panel |
| `subagentCatalog` | `@deepseek-ai/dsh-subagent` | Agents item, `/agents` |
| `subagent` | `@deepseek-ai/dsh-subagent` | child identity/mode |
| `subagentTiming` | `@deepseek-ai/dsh-subagent` | Agents timing |
| `modelSelection` | `@deepseek-ai/dsh-api-session-controller` | model status, banner, sessions list |
| `workingDirectory` | `@deepseek-ai/dsh-working-directory` | cwd/git status, file mentions, skills, deliverables |
| `sessionStats` | `@deepseek-ai/dsh-session-stats` | status, `/context`, sessions detail |
| `tokenUsage` | `@deepseek-ai/dsh-token-meter` | context status, sessions list |
| `contextPressure` | `@deepseek-ai/dsh-token-meter` | context status |
| `contextBreakdown` | `@deepseek-ai/dsh-token-meter` | `/context` composition |
| `turnOutline` | `@deepseek-ai/dsh-session-turn-outline` | turn navigation/previews |
| `agentPreset` | `@deepseek-ai/dsh-agent-preset-registry` | preset display |
| `inbox` | `@deepseek-ai/dsh-agent` | pending input (via exact Agent) |
| `sessionListMetadata` | `@deepseek-ai/dsh-api-session-controller` | sessions list |
| `imageLimits` | `@deepseek-ai/dsh-attachment` | paste-image limits |

Read in process with `ctx.sessionProjections.snapshot(session, keys)`,
`stateOf` for host-only state, and `onChanged` for subscriptions. For cold or
remote sessions use `ctx.sessionController.projections({ sessionId })`; it
returns `sequenced` or `migration-required` hints, never starts migration.

## Native services and controllers

| Capability | Service | Mayfly use |
|---|---|---|
| Session lifecycle | `ctx.sessionController` | create/prompt/cancel/fork/rename/page/follow/projections/selectModel |
| Agents | `ctx.agents` | exact live Agent lookup only |
| Tools | `ctx.tools` | schemas/get/execute for the exact Agent |
| Commands | `ctx.commands` | register Mayfly-only names; execute native commands |
| Approvals | `ctx.approval` | answer `approval/request` |
| Questions | `ctx.userQuestions` | answer `user-questions/request`; read projection |
| Plan | `ctx.planMode` / `/plan` | display projection; write through command/service |
| Goal | `ctx.goals` / `/goal` | display projection; write through service/command |
| Jobs | `ctx.jobs` | list/get/readAt/kill; durable `job/registered`/`job/settled` |
| Subagents | `ctx.subagents` | `startActivation`, catalog/control, `drainChildren` |
| Schedule | `ctx.schedule` | list/catalog/history; preset-owned `tool-schedule` |
| Settings | `ctx.settings` / `ctx.settingsController` | describe/mutate; never patch YAML |
| Models | `ctx.llm` / `ctx.agentDefaultModel` | catalog/defaults; selection through controller |
| Credentials/account | `ctx.credentials*`, `ctx.deepseekAccount` | sign-in UI and redacted views |
| Skills | `ctx.skills` | list/snapshot only |
| MCP | `ctx.mcpResources` / `ctx.tools` | resources through tool pipeline; no status guess |
| File references | `ctx.fileReferences` | `list(agent, query, signal)` plus official grammar |
| Deliverables | `deliverables/presented` + `ctx.workspaceChanges` | `/files` cards and changed-file summaries |
| Workspace | `ctx.workspaceRegistry` / `workspaceController` | `WorkspaceId`, archive, pin |
| Plugins | `ctx.pluginManager` / `ctx.pluginMarket` | install/remove/update; market read when the service is mounted |
| Working directory | `ctx.workingDirectory` | current directory for all current operations |
| Permissions | `ctx.permissionPresets` | catalog/current; `/permission` remains native |

## Mayfly-owned keys

| Key | Owner | Contents |
|---|---|---|
| `mayflyConversation` | `conversation/projection.ts` | terminal transcript rows: user/assistant/thinking/tool/error/interrupted/goal/compaction/turn history |
| `mayflyConversationFacts` | `conversation/facts.ts` | presentation-only facts: phase, activity, output progress, retries, per-step usage, approvals, compactions, run outcome, spawn calls |
| `mayflyDeliverables` | `conversation/deliverables.ts` | latest `deliverables/presented` files; Harness has the event but no projection key |

## Enforcement

`tests/architecture/native-capability.spec.ts` scans source for projection and
service names, command registrations, direct profile writes, loader internals,
and known prose/flag guesses. A new key or service must be added here with its
native owner; a Mayfly-owned key must be justified under the rules above.
