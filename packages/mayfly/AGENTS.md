# `@ephemeral-ai/mayfly`

Owns runtime areas, public subpaths, the flat `cordis.patch.yml` composition,
and the `mayfly-cordis` preset. `src/index.ts` mounts nothing: the patch inserts
ordinary siblings over `dsh-base`. Use manifest exports for the public entry
list; do not duplicate row counts. Dependencies come from `inject`, not YAML
position. Features contribute snapshots or leases of named internal screen
slots, never arbitrary root components.

## State and lifetime ownership

- A resource acquired across an `await` registers its owner first and rechecks
  it on resumption; async work fences starts and late failures behind unload.
- `app/` owns startup and `mayflyConversations` (the primary plus side
  conversations, one displayed selection, and the F7 order).
  `mayflyCurrentAgent.current()` is the exact Agent only while an interactive
  conversation is displayed; readonly and resumable views yield null. Cold
  continuable children use addressed native history and explicit
  reply-to-resume. Startup selects no Agent: the first message creates the
  session through `mayflySessionStart`; `/new` and `/clear` deselect. A
  sessionless command registers through `registerOwnedCommand` and must not
  read `invocation.agent`. Interrupt only through native ancestor authority.
- `frontend/` owns `mayflyUiInteraction`, `mayflyUiImages`, exact-Agent
  assistant drafts, the session-facts bridge, and independent consumer Fibers.
  Its models live in core interaction-state modules but survive core-only
  reload; teardown releases editors and handles, not drafts or choice state. A
  `prompt` draft, token, recall walk, and completion cursor live in the model;
  the runtime leases the editor that mirrors it. Recovery reads native
  assistant-stream baselines and never folds a second durable session log.
- Agent-specific model, tool, MCP, skills, approval, and question consumers bind
  to exact Agent identity, including same-session-ID replacements. `interaction/`
  keeps editor/autocomplete and prompt-submit state in separate Fiber services;
  editor presentations are overlays in the fixed editor host.
- `/sessions` retains only the rows one native catalog read returned and fences
  refreshes by controller instance and generation. A `migration-required`
  projection shows cached values and never starts migration. Do not enumerate
  `sessionPersistence`, consult `sessionProjectionCache`, call
  `readColdSessionLog`, or keep a second session store.
- `transcript/` has one controller with one view per displayed or retained
  conversation, generation-keyed reuse, and lazy conversion of the latest unread
  value. Preserve complete floor-eligible history; a BTW floor hides entries only
  in presentation. Do not rely on entry identity across native parsing or render
  a conversation outside the transcript pane. The controller publishes at most
  once per window; completion comes from explicit settled steps.

## Core, slots, and views

`src/core/` is the only pi-tui importer and owns raw terminal state, ANSI, focus,
layout, and visible width; its modules group around admission, compilation,
painting, and interaction state, with content, hosts, terminal, keys, text, and
theme beside them.

`screen.mountNodeSlot(id, { region: 'content' | 'dock' | 'footer' })` is a
core-private lease whose wire node compiles through the surface path into a fixed
host. Its `slot` model lives in `mayflyUiInteraction`, so a screen teardown
revokes the lease and keeps the model. A `views` pane is a status-row view kept
by `core/ui/state/views-lane.ts`; entry keys are `ui.focus-next`, `ui.left`/`ui.right`,
and `ui.cancel`.

## Components area

`src/components/` holds pure fact-to-node functions (`TranscriptView`,
`ToolLine`, `ActivityRow`, `NotificationLine`, `CompactionRow`, `DecisionCard`,
`Editor`, pickers, wizards, panels). The approval and questions plugins own the
request queue and publish it as `mayfly/decision-requests-changed`. There is no
Cordis entry or public subpath, and a component is imported from its own module.
A file there imports only `@ephemeral-ai/mayfly-ui` and its siblings and contains
no `node:` module, Cordis, `../core`, width helper, escape sequence, timer, or key
binding. `tests/components/layering.spec.ts` is the guard; row renderers join the
owning `width-scan.spec.ts`.

## Keymap

`mayflyKeymap` owns every dispatched key as a named action with a scope:
`global`, `editor`, `surface`, or `stream`. A key belongs to one action within
overlapping scopes; a conflict is refused with the owner's name (`KEY_CONFLICT`).
`bind`/`reset`/`resetAll` change a binding for the session (a rebound-away key is
dead, not an alias; `Esc` and `Enter` stay fixed). Component actions
(`<owner>.<action>`) appear in nodes and in the hint row under the same rule.
Printable accelerators never pre-empt a control that takes text. A new default
key passes `tests/core/key-audit.spec.ts`.

## Interaction contracts

Use shared Form/Choice/Tree/Tab/ScrollView state for drafts, validation, locks,
confirmation, navigation, and acknowledgement. Observations report facts; actions
return structured settlements. Publish admitted acknowledgements before settling
native requests; fence late validation, replies, and source data. Keep hidden
branches and large lists lazy; passive transcript scrolls linearize into the
outer viewport, interactive surfaces keep semantic scroll state.

Use shared Yes/No confirmation with No focused. Dirty forms confirm dismissal;
native decisions may discard. Wizard navigation validates read boundaries without
domain writes. Withdrawal, decline, and whole-attempt cancellation are distinct;
abort/Agent replacement/unload retires visible and queued requests.

`core/ui-key-grammar.ts` is the single source for dispatch and hints;
[docs/interaction-model.md](../../docs/interaction-model.md) is the spec.
Shared-key changes update `SHARED_KEY_REFERENCE` and both Website key references.
Escape leaves one layer per press; Tab commits text and pickers; arrows never
change a select. Editor shells leave every key except modifier accelerators to
the editor; choice reducers never focus disabled rows.

Core reuses work by identity, never by value. A surface keeps one admission memo,
one compile memo, and one list-row memo; the renderer keeps one
`UiAnimationClock`; none is a module singleton. Only a frozen `isWireSnapshot`
value is a cache key, a memo hit replays every quota and duplicate check, and a
subtree carrying a control, tab, page, action key, filter, editor slot, or
responsive branch is admitted whole each time.

An unchanged surface costs nothing per frame: `compileNode` answers a repeat
render from memory (`retain`) until the surface epoch moves (a handled key,
focus, `invalidate`, new compile, host viewport, model revision, keymap revision,
or completion state). Any other state a painter reads needs `touch()`, or the
component is volatile; a live engine (host editor, a prompt) is volatile. A
moving cell reads one clock, armed only while it can be on screen.

Every spec outside `tests/perf/` runs with `MAYFLY_UI_VERIFY_MEMO=1`: every memo
hit paints again and throws when the rows differ.

Build surfaces from the shared components (actions, fields, lists, tabs, decision
panels, questionnaire, loader/progress/empty). The
[UI reference](../../docs/design/component-library.md) is authoritative. Never
hand-roll pi-tui panels outside `core/`; a component that replaces a surface
deletes the old code in the same change.

## Native writes and sensitive data

- `/plugin` renders `ctx.pluginManager` state and uses `installBundle`,
  `removeBundle`, and `setBundleEnabled`; never spawn a package manager, write a
  profile file, or keep a CLI-backed installer. Changes apply after restart.
  Optional collaboration plugins own their preset, tools, and UI; the default
  bundle does not mount Agent Team, and child navigation plus
  `mayfly/request-subagent-reply` remain app/interaction-owned.
- Settings use shared forms and explicit native path-op commits, bound to
  descriptor revision. Never refresh-and-retry writes, expose saved secrets or
  schema secret defaults, or overwrite unsupported containers. Raw editing
  checks writability and the original file, suspends the screen, and ignores
  cancelled continuations. Provider discovery reads versioned drafts; only Save
  writes settings/credentials, MCP projections omit environment/header values,
  and skills browsing never loads skill bodies.
- Presets use native `agentPresets.select()` and its turn-boundary guard; UI
  withdrawal does not roll back native work. Plan toggles and permission presets
  remain independent; `pending` means queued. Jobs uses `list/get`, only explicit
  Read output consumes `read`, and Stop rechecks status. Host commands use
  fixed-argument descriptors; `MAYFLY_DSH_BIN` wins over `DSH_BIN`/PATH, selected
  JS entries run through Node, and clipboard I/O shares the bounded subprocess
  runner.

## Verification and composition

`pnpm run check` is the gate; lifecycle changes need the owning suite and
renderers need width scans. Core fixtures mount the UI provider and frontend
owner and test that frontend state survives core reload. New public seams need
real consumers, replay/abort/late-result tests, width and whole-tree composition
coverage, and dedicated-profile acceptance.

The scenario catalog (`script/scenarios/catalog.mjs`) is the registry of live
demo states behind `pnpm run scenario` and `pnpm run frame`; scenarios are a
review tool, not a test gate. Patch, preset, skill, dependency, or composition
edits require bundle/preset tests, `pnpm run check:agent-docs`,
`pnpm run check`, `pnpm run check:pack`, dedicated-profile install, PTY smoke,
and human acceptance. Keep `HARNESS_LINE` in
`interaction/session-commands.ts`. The public side-question entry is
`./btw-command`. The three shipped skills use native dsh services and the four
Mayfly UI services, without special manifests, author CLIs, or private hosts.
