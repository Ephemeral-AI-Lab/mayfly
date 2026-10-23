# Mayfly UI/UX audit: flows and localization

Audit baseline: `27bc1885c4b59268eb5b972a30f71bbb902fb1f8`. Report date:
2026-09-28. Scope: the plugin marketplace flows (`/plugin` browser, detail
panel, refresh, install/update paths) and locale/catalog health across the
interaction and transcript surfaces (registration lifecycle, missing keys,
hardcoded English, dead and drifted entries, terminology consistency).
Severity indicates the order of work, not a security rating. This record is
an audit of that commit; it does not indicate fixes were implemented. Every
file:line citation below was re-verified against source at the baseline.

## UX-01: Plugin "Update / repair" action always fails

- Severity: high
- Category: unreasonable design
- Status: substantiated

### Symptom

For an installed plugin whose market index publishes a newer version, both
the `/plugin` browser (Installed tab) and the detail panel offer a primary
"Update / repair" action. Activating it always fails with
`install failed: "<name>" is already or partially installed; uninstall it
before reinstalling`.

### Root cause

The action is offered whenever the entry is installed and `updateAvailable`:
detail panel at `packages/mayfly/src/interaction/plugin-commands.ts:312`,
browser row action at `plugin-commands.ts:370`. `runOperation` only
short-circuits an install when the entry is installed *and* up to date
(`plugin-commands.ts:398-401`), so an installed entry with an available
update proceeds into `operate` (`plugin-commands.ts:202`), which calls
`installEntry` (`packages/mayfly/src/interaction/plugin-market/installer.ts:299`).
`installEntry` reads the profile manifest and hard-refuses any entry whose
package rows are already installed (`installer.ts:303-306`), returning the
"already or partially installed" error; `operate` wraps it as
`install failed: {message}` (`plugin-commands.ts:205-209`). No code path
performs an upgrade: the advertised update action routes into a
fresh-install-only function, so it fails by construction on every click.

### User impact

Anyone with an installed plugin that has an update in the catalog. The
primary call to action in both panels is a guaranteed failure whose error
message tells the user to do a manual uninstall plus reinstall — two
restarts.

### Suggested fix

Give the action a real upgrade path: in `operate`/`installEntry`, when the
entry is fully installed and only the version changed, run remove-then-add
inside one transaction (or invoke `dsh plugin add` with the new spec and let
dsh upgrade), with the existing rollback discipline. Alternatively stop
offering it: extend the `unavailable` map (`plugin-commands.ts:345-353`) and
the `detailNode` action list (`plugin-commands.ts:312`) to suppress install
when `state.installed === true`, and point the user at the CLI path.

## UX-02: /plugin info <id> panel has dead Install/Remove/Update actions treated as silent success

- Severity: high
- Category: inconsistent interaction
- Status: substantiated

### Symptom

`/plugin info <id>` opens the same detail panel as the marketplace browser,
including Install/"Update / repair" and Remove actions; Remove even shows
the "Remove the selected plugin?" confirmation first. After the user
confirms, nothing happens: no message, no state change, nothing removed —
and the surface internally records the operation as succeeded.

### Root cause

The info path opens the overlay at `plugin-commands.ts:555` with no
`onEvent` in the definition, while the shared `detailNode` renders the
action bar unconditionally (`plugin-commands.ts:311-315`). When an action is
activated, `UiInteractionSurface.invoke` dispatches it
(`packages/mayfly/src/core/ui-interaction-surface.ts:474-483`) — that path
never checks whether the definition carries handlers (only `observe` and
`finishClose` do, `ui-interaction-surface.ts:645` and `:654`). The endpoint
resolves `handler` to `undefined`
(`packages/ui/src/snapshot-events.ts:149-154`), and
`admitReply(undefined, event, false)` returns `undefined` without throwing
for non-submit events (`snapshot-events.ts:84-87`). Back in the surface,
`execute` treats `reply === undefined` as success — `setPhase(task,
'succeeded')`, no feedback (`ui-interaction-surface.ts:682-686`). The same
panel opened from the browser registers a full `onEvent.action` handler
(`plugin-commands.ts:436-449`), so identical UI behaves differently purely
by entry path.

### User impact

Any user who runs `/plugin info` on an installed plugin and confirms Remove
is told nothing and may believe the removal worked. The dead "Update /
repair" variant additionally compounds UX-01.

### Suggested fix

Register the same `onEvent.action` handler `openDetail` uses
(`plugin-commands.ts:436-449`) for the info-path overlay, routing through
`runOperation`. Independently, make the backstop loud: in
`UiInteractionSurface.execute`, when an activate/submit event produces an
undefined reply because no handler is registered, report a warning instead
of recording silent success (`ui-interaction-surface.ts:682-686`). A
cheaper partial fix is to omit the action bar in `detailNode` when no
handler is attached.

## UX-03: Locale namespace registration race — 11 plugins register 'interaction', 10 throw on every startup, catalog lifetime bound to an arbitrary winner

- Severity: high
- Category: data error
- Status: substantiated

### Symptom

Every startup logs `locale namespace "interaction" is already registered`
once per losing plugin (10 times in the default bundle). If the plugin that
happens to win the race is ever disabled or unloaded, every translated
surface in the app silently reverts to English even though the other ten
mounts are still alive.

### Root cause

`MayflyLocaleService.register` throws on a duplicate namespace
(`packages/mayfly/src/frontend/locale.ts:118-119`).
`mountInteractionLocale` unconditionally registers the 'interaction'
catalog inside `ctx.inject(['mayflyLocale'], ...)`
(`packages/mayfly/src/interaction/locale.ts:623-627`), and eleven plugins
call it: `interaction/index.ts:49`, `session-commands.ts:48`,
`settings-command.ts:137`, `approval-plugin.ts:54`, `questions-plugin.ts:17`,
`preset-commands.ts:29`, `tools-commands.ts:84`, `mcp-commands.ts:66`,
`skills-command.ts:38`, `jobs.ts:101`, `schedule-command.ts:107` — mounted
as siblings under one frontend tree (`frontend/index.ts:50-60`) plus the
interaction root. The first fiber to activate wins; each of the other ten
throws out of its effect, the anonymous inject fiber fails, and cordis logs
the error through its plugin-start error path (`ctx.logger.error`), so
startup continues with exactly one registration. Worse, the catalog's
lifetime is the winning fiber's: the effect returns the `register` disposer
(`interaction/locale.ts:625`), which deletes the namespace on unload
(`frontend/locale.ts:128-133`). `translate` then finds no 'interaction'
catalog and falls back to the raw key — the English source string
(`frontend/locale.ts:152-160`) — and the ten failed mounts never retry, so
nothing re-registers.

### User impact

Log noise on every boot for all users. Because `cordis.patch.yml` lets
users disable plugins, disabling whichever plugin happens to win activation
silently strips Chinese from every interaction surface with no warning —
a supported configuration operation with an invisible translation outage as
its side effect.

### Suggested fix

Register the 'interaction' namespace exactly once, owned by the fiber that
owns `MayflyLocaleService` (`frontend/index.ts:45-46`), and remove the
eleven per-plugin mounts. Alternatively make `register` idempotent for an
identical catalog reference instead of throwing, and keep the first
registration until the locale service itself disposes.

## UX-04: Stale plugin catalog reported as "refreshed", with no staleness indication anywhere

- Severity: high
- Category: data error
- Status: substantiated

### Symptom

When every fetch leg fails but a cache exists (flaky network, blocked
registry), `/plugin refresh` answers `refreshed N entries` in success tone,
and the marketplace browser shows the cached catalog with no indication
that it is stale.

### Root cause

`loadMarketCatalog` distinguishes three outcomes
(`packages/mayfly/src/interaction/plugin-market/catalog.ts:40-43`); on
total fetch failure with a cache present it returns `status: 'stale'`
carrying the failure `message` (`catalog.ts:115-117`). Both refresh paths
collapse everything non-`'offline'` into success: the `/plugin refresh`
verb returns `refreshed {count} entries` for a stale result
(`plugin-commands.ts:535-541`), and the browser's `refreshMarket` does the
same (`plugin-commands.ts:460-470`). `marketNode` only special-cases
`'offline'` (`plugin-commands.ts:333-338`), so the stale status and its
message are dropped and the catalog renders as if current.

### User impact

Anyone browsing or refreshing the marketplace on a degraded network acts on
outdated install data while the UI positively claims it was just refreshed.
Combined with UX-01, a stale index can also manufacture phantom "update
available" badges whose repair action then fails.

### Suggested fix

Handle `'stale'` explicitly in both refresh paths
(`plugin-commands.ts:465-470` and `:538-541`): report a warning carrying
`result.message` (and ideally the cache age) instead of the success
message, and render a stale banner row in `marketNode` when
`catalog.status === 'stale'` (`plugin-commands.ts:329-338`).

## UX-05: ~80 zh catalog keys missing — entire surfaces fall back to English for zh users

- Severity: high
- Category: unfriendly interface
- Status: substantiated

### Symptom

With locale = zh, whole surfaces render English: OAuth sign-in, `/trace`,
provider add/edit validation and feedback, `/agents` errors and command
description, the plan divider, `/status` fields, the `/plugin` empty state,
several command descriptions, and settings labels.

### Root cause

The strings are passed through `t(...)`, but the keys are absent from the
zh catalog (`packages/mayfly/src/interaction/locale.ts`), and `translate`
falls back to the key itself (`frontend/locale.ts:152-160`). Missing keys
re-verified against the catalog at this commit, with their emitting call
sites:

- OAuth: `Copy URL` / `Copy code` (`interaction/authorization-ui.ts:39-40`),
  `Waiting for authorization` (`:46`), `Sign in` / `Finish setup` (`:48`),
  `Authorize {route}` (`:108`), `Authorization completed` /
  `Authorization cancelled` (`:117`, `:142`).
- `/trace`: `Trace` (`interaction/trace-command.ts:25`), `no trace events
  yet` (`:29`), `Copy all` (`:30`), `Surface` (`:36`), `copied {count}
  trace events` (`:81`).
- Providers: `Provider settings saved, but the credential could not be
  saved` (`interaction/provider-edit.ts:313`), `No providers available`
  (`interaction/provider-add.ts:278`).
- Agents: `agents panel is unavailable: the Mayfly screen is not mounted`
  (`interaction/agents-command.ts:230`), `Browse this session's subagents,
  view one, or stop a continuable child` (`agents-command.ts:333`).
- Misc: `Plan` (`interaction/plan-document.ts:20`), `(unknown)`
  (`interaction/session-info-model.ts:73`), `Thinking effort`
  (`session-info-model.ts:80`), `no plugins available`
  (`plugin-commands.ts:366`), `Show the release changelog (what's new)`
  (`interaction/session-commands.ts:58`), and the settings labels
  `Work details` / `Plugin market index` (`interaction/settings-model.ts:13`
  and `:16`, passed through `t()` at `settings-model.ts:57`).

The audit's key-by-key trace counted ~80 such keys across first-run
onboarding, provider management, the `/update` flow, MCP resources,
marketplace badges, and the surfaces above.

### User impact

zh-locale users hit English exactly in the setup, sign-in, provider, and
update flows — the flows where guidance matters most. The English fallback
is by design, so this is a coverage gap, not a crash.

### Suggested fix

Add the missing keys to `interaction/locale.ts`, organized by workflow
(OAuth, `/trace`, provider add/edit/onboarding, `/update`, MCP, agents,
status, settings labels). Add a catalog-completeness test that extracts
`t()` keys from source and diffs against the catalog so the gap cannot
silently regrow.

## UX-06: Many user-visible strings bypass t() entirely (hardcoded English)

- Severity: high
- Category: unfriendly interface
- Status: substantiated

### Symptom

Even where the catalog infrastructure and matching keys exist, many
surfaces never call the translator: command outcomes, editor feedback
flashes, transcript tool/group headers, status badges, and panes render
English in a zh UI.

### Root cause

Call sites construct raw literals instead of `t()` calls. Verified
examples:

- `/rewind` overlay fully raw: `no active session`
  (`interaction/commands-plugin.ts:73`), `cannot rewind while the agent is
  running` (`:74`), `no user turns to rewind` (`:76`), `Rewind current
  session` (`:79`, `:85`), manual English pluralization `message/messages`
  plus `Turn N · … rewinds N` (`:86`), `The original session stays
  available in /sessions.` (`:87`). Also `help is unavailable: …` (`:100`),
  `exit is unavailable: …` (`:153`), `starting a new session` (`:183`),
  `cannot fork while the agent is running` (`:199`), `forking the current
  session` (`:202`), `resuming session ${id}` (`:220`).
- Mode/model/permission: `no session is live yet`
  (`interaction/mode-commands.ts:48`), `plan mode is unavailable` (`:53`),
  `mode command is unavailable: /plan` (`:61`); `the llm service is
  unavailable` (`interaction/model-commands.ts:177`, `:261`, `:489`),
  `model picker is unavailable` (`:384`, `:516`); `permission picker is
  unavailable: …` (`interaction/permission-panel.ts:81`), `permission
  command is unavailable` (`:116`).
- Editor feedback and command results: `set $VISUAL or $EDITOR to edit
  drafts externally` (`interaction/input-plugin.ts:454`), `draft cleared ·
  ↑ restores` (`:492`), `interrupt requested` (`:511`), `press ctrl+c again
  to exit` (`:593`), `new messages available · press End to follow`
  (`:779`); command result text is rendered raw
  (`input-plugin.ts:430-432`).
- Subagent panel and deliverables: `the session controller is unavailable`
  (`interaction/session-transcript-panel.ts:141`), `the stored subagent
  conversation is unavailable` (`:151`), `conversation unavailable`
  (`:169`); `File unavailable` / `unknown` / `bytes`
  (`interaction/deliverables-command.ts:38`).
- Transcript and status chrome: `Running a command` / `Ran a command`
  (`transcript/components.ts:489`), `Using` / `Used` (`:492`), the
  `line`/`lines` chip (`:498`), ` · plan declined` (`:502`), `✗ request
  failed` (`:677-680`); group headers `Reading N files…`
  (`transcript/read-group.ts:148-155`), `Searched N patterns`
  (`transcript/search-group.ts:99-111`), `Ran N commands`
  (`transcript/command-group.ts:93-100`); `  Todo` / ` · interrupted` /
  `blocked: ` / the `ctrl+t` hints (`transcript/pane-todo.ts:218-259`);
  `Running N agents` / `N agents finished`
  (`transcript/pane-agents.ts:217-223`); `Queued: ` / `Steer: `
  (`interaction/pane-queue.ts:30-31`); `plan...` / `plan` / `yolo`
  (`interaction/mode-status.ts:22-25`); `MAIN` / `SUBAGENT` / ` · reply to
  resume` / ` · read-only` (`interaction/agent-view-status.ts:22-37`);
  `⏵ N jobs` (`transcript/status-jobs.ts:35`); `Goal <phase> · N/M ·
  <activation>` (`transcript/status-goal.ts:21`).

Notably, two of these strings already have zh translations the call sites
ignore: `no active session` (`interaction/locale.ts:300`, raw use at
`commands-plugin.ts:73`) and `no session is live yet`
(`interaction/locale.ts:610`, raw use at `mode-commands.ts:48`).

### User impact

All zh-locale users, on the most frequently visible surfaces — the status
bar, transcript headers, and editor flashes. Adding dictionary entries
alone cannot fix call paths that never invoke `t()`.

### Suggested fix

Thread `interactionTranslator(ctx)` through the listed modules and replace
the literals with `t()` calls, adding catalog keys as needed; mount a
catalog for the surfaces that have none (the todo pane). Replace manual
pluralization (`commands-plugin.ts:86`) with catalog placeholders so plural
rules live in the locale, not the code.

## UX-07: Dead and drifted locale catalog entries — translations exist for strings code no longer emits while live strings are untranslated

- Severity: medium
- Category: redundant implementation
- Status: substantiated

### Symptom

The catalogs carry translations for strings no code path emits anymore,
while the replacement wording is untranslated. Example: zh has
"更新不可用：Mayfly 界面尚未挂载" for `update is unavailable: the Mayfly
screen is not mounted`, but the live `/update` error renders in English —
`…the Mayfly UI registry is not mounted`.

### Root cause

Nothing couples the catalog to its consumers, so entries survive rewrites.
Verified at this commit:

- Drift pairs (dead translation vs live untranslated string):
  `interaction/operation-locale.ts:54` vs the live
  `interaction/update-command.ts:318`; `operation-locale.ts:69` vs the live
  `plugin-commands.ts:321` and `:548`; `provider name "{name}" already
  exists` (`interaction/locale.ts:124`) vs the live `This provider already
  exists` (`interaction/provider-add.ts`); `every catalog vendor is already
  active — switch with /provider switch` (`locale.ts:139`) vs the live
  `No providers available` (`provider-add.ts:278`, itself untranslated per
  UX-05); `Browse this session's subagents and attach to one`
  (`locale.ts:554`) vs the live description at `agents-command.ts:333`.
- Dead blocks confirmed unreferenced by a `t('key'` call-form search:
  settings hint lines `· esc close · ↵ open` / `↵ change` / `esc back` /
  `restart to apply` (`locale.ts:251-255`); result messages `could not
  update {label}: {message}` / `{label} set to {value}` (`:258-259`);
  `Follow system` (`:186`); `Question {current} of {total}` /
  `Other: {value}` / `{label} cannot be empty` / `Submit feedback`
  (`:515-520`); `toggle / choose` / `toggle branch` / `to search`
  (`:160-161`, `:173`); per-setting descriptions and the
  `Transcript detail` … `Other tools detail` tiers (`:188-248` — settings
  forms render labels only, `settings-model.ts:45-112`); and the superseded
  plugin-browser block explicitly fenced by the comment at
  `locale.ts:427-429`.
- Scale: `interaction/locale.ts` holds 589 zh keys at this commit; the
  audit's key-by-key trace flagged ~146 keys across the two interaction
  catalogs as unreferenced.

### User impact

Every wording change requires editing entries that may be dead, and stale
entries mask the untranslated live strings — a translator can "complete"
the catalog while zh users still see English, compounding UX-05 and UX-06.

### Suggested fix

Generate a usage report (extract `t()` keys from source, diff in both
directions), delete confirmed-dead keys in one pass, and wire the diff into
the test suite. Fix the drift pairs by retargeting the translations at the
live strings.

## UX-08: Inconsistent zh terminology for the same concepts, plus duplicated hint vocabulary across two catalogs with real drift

- Severity: medium
- Category: unclear prompts
- Status: substantiated

### Symptom

The same concept is translated several ways in zh — 子 Agent vs 子代理 for
subagents; 提供方 vs 提供商 vs untranslated `provider`; 推理强度 vs 思考强度
vs 思考级别 for thinking effort — and the same English hint word `leave`
renders 离开 in one surface and 退出编辑 in another.

### Root cause

No glossary is enforced across independently maintained catalogs. Verified
instances in `packages/mayfly/src/interaction/locale.ts`: 子 Agent (`:57`,
`:59`) vs 子代理 (`:551`, `:552`, `:555`); `provider` left English inside a
zh string (`:273`) vs 提供商 (`:70-71`) vs 提供方 (`:297`); 推理强度 (`:225`,
`:272`) vs 思考强度 (`:94`, `:112`) vs 思考级别 (`:115`); profile as 配置目录
(`interaction/operation-locale.ts:8`) vs untranslated profile
(`locale.ts:417`, `:444`); host as 宿主 (`:79`, `:135-137`) vs untranslated
host (`:256`, `:329`) vs `Host` (`:586`); `skill` (`:292`) vs 技能 (`:293`,
`:298`); `Schedule` kept English (`:586`) vs 提醒 for the same panel
(`:562-566`). Separately, the contextual-hint vocabulary is duplicated
wholesale between `core/context-hint-locale.ts:13-46` and
`interaction/locale.ts:149-183` (tabs/actions/options/fields/groups/
choose/toggle/run/edit/adjust/apply/submit/confirm/back/close/scroll/
newline/`toggle / confirm`), and the copies have drifted on `leave`:
离开 (`core/context-hint-locale.ts:39`, the Escape-layer hint) vs
退出编辑 (`interaction/locale.ts:170`). The same English word yields two zh
labels depending on which namespace a surface binds.

### User impact

zh users see inconsistent naming for core concepts across adjacent
surfaces, and translators must maintain two copies of one vocabulary —
which is how the `leave` drift happened.

### Suggested fix

Pick one glossary term per concept and normalize both catalogs in a single
pass. Collapse the duplicated hint vocabulary into one shared catalog (or
have one re-export the other) so `leave` and its siblings cannot drift
again.
