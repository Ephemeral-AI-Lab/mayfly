# `@ephemeral-ai/mayfly`

Owns runtime areas, public subpaths, the flat `cordis.patch.yml` composition,
and the `mayfly-cordis` preset. `src/index.ts` mounts nothing: the patch inserts
ordinary siblings over `dsh-base`. Use manifest exports for the public entry
list; do not duplicate row counts. Dependencies come from `inject`, not YAML
position. Feature code contributes snapshots or leases named internal screen
slots, never arbitrary root components.

## State and lifetime ownership

- `app/` owns startup and the conversation registry (`mayflyConversations`):
  the primary plus any number of side conversations (at most one BTW), one
  displayed selection, and the most-recently-displayed order behind F7.
  Access is derived, never declared. `mayflyCurrentAgent.current()` is the
  exact Agent only while an interactive conversation is displayed; readonly
  and resumable views yield null, never the primary. Cold continuable
  children use addressed native history and explicit reply-to-resume.
  Interrupt descendants through native ancestor authority without draining
  retained Activations/inbox.
- `frontend/index.ts` owns `mayflyUiInteraction` and independent consumer Fibers.
  Its models are implemented in `core/ui-interaction-*.ts` but survive core-only
  reload. Renderer teardown releases editors/handles, not drafts or choice state.
  It also owns `mayflyUiImages`, the byte source of `image` nodes: the host tree
  provides a loader (Fiber-owned, newest first) and core never imports the
  Harness; the wire carries only the attachment id and the alt fallback.
  A `prompt` node's draft, selected token, recall walk, and completion cursor live in
  the surface model (`core/ui-interaction-prompt.ts`) and survive a renderer reload;
  the runtime only leases the terminal editor that mirrors the draft
  (`core/ui-prompt.ts`), and the prompt's keys are one `keyGrammar` arm.
  Registry observers dispose only models from registrations they own.
  Locale namespaces are refcounted shared catalogs: any surface plugin may
  register the same namespace when its catalog is equivalent, and the catalog
  lives until the last owner unloads; a conflicting catalog is a programming
  error. Vocabulary shared across namespaces belongs to `common`. English
  strings are the stable keys, so changing one means updating its emitting
  call site; `tests/locale-catalog.spec.ts` enforces used-key completeness,
  dead-key liveness, placeholder parity, and zh terminology in both directions.
  It also owns exact-Agent assistant drafts and the session-facts bridge;
  neither depends on theme/core. Recovery reads native assistant-stream
  baselines, fences Agent replacement and late continuations, and never folds
  a second durable session log. App selection must survive renderer gaps.
- Provider setup and application information survive current-Agent/skills/core
  gaps. Agent-specific model, tool, MCP, skills, approval, and question consumers
  bind to exact Agent identity, including same-session-ID replacements. Detail
  views follow their parent/Agent/provider lifetime, not a completed operation.
- `interaction/` keeps editor/autocomplete state and prompt-submit transforms in
  separate Fiber services. Editor presentations are ordinary overlays projected
  into the fixed editor host; preserve and restore the prompt lease.
- `/sessions` retains only native catalog headers and revision-keyed title
  read results in the command Fiber across panel opens. Group the picker by
  exact cwd using headers only; materialize projections and names only for the
  opened workspace or explicit global search results. Show loading/progress
  until pending reads settle. Enumerate persistence once per refresh and bound
  cold reads. A cold title comes from `readColdSessionLog` rather than a retained
  `sessionQuery` observation, with `sessionProjectionCache` consulted first.
  Storage replacement and unload retire retained results; browsing must
  never activate Agents, retain logs, or create a second session domain store.
- `transcript/` has one conversation controller with one view per displayed
  or retained conversation (listed ones hold nothing), generation-keyed
  reuse, and lazy conversion of the latest unread value from a feed: a live
  Session through the native registry, or a stored child through its native
  address. Hidden views stash values without converting or waking the
  renderer. Preserve complete floor-eligible history; a history floor (BTW's
  seed) hides entries only in presentation. Do not rely on entry identity
  across native parsing or render a conversation outside the transcript pane.
  Durable sequence numbers and transient presentation revisions are separate.
  Live overlays share stable history; completion comes from explicit settled
  steps, never a reasoning block's animation flag. Verify through the actual
  source-to-component path, including settlement and renderer reload.
  The activity pane is the sole owner of live status (phase, elapsed time,
  current action, throughput); transcript rows show content and settled
  summaries only, and only surfaces without an activity row opt into the
  running turn header.
- A submitted reply acknowledges its form snapshot before dismissal. The
  editor stays visible for every conversation: readonly ones keep the draft,
  resumable ones hand it to the explicit reply form.
- Schedule reminders belong to the Host, not a session projection. `/schedule`
  reads the exact selected Agent's Session through the optional native service,
  observes `schedule/changed`, and fences late reads across selection and unload.
- `conversation/` owns phase-local output measurements from session timestamps.
  Renderer timers animate or expire labels; they do not measure domain progress.

## Node slots

`screen.mountNodeSlot(id, { region: 'content' | 'dock' | 'footer' })` is a
core-private lease (`core/node-slot.ts`) whose wire node compiles through the
surface path, with the same compiler entry, runtime, and caches as a pane, into
one of the screen's fixed hosts. Its interaction state is a `slot` model in
`mayflyUiInteraction`, so a screen teardown revokes the lease and keeps the
model for the next lease of the same id; only `dispose()` drops it. Mayfly
features reach the footer, the editor, and the conversation through slots, never
through a new root component. Plugins still use only the four public services.

## Views lane

A `mayflyPanes` pane with `placement: 'views'` is a view of status row 2, kept
by `core/views-lane.ts` (`SurfaceManager.views`), not by a pane lane: it has no
rows of its own, its summary joins row 2 through the footer, and an entered
panel replaces row 2. A view's slot lives with its `PaneComponent`. Entry keys
are the named actions `ui.focus-next`, `ui.left`/`ui.right`, and `ui.cancel`;
`F6` walks the views before the interactive panes. Mayfly's own views register
through the public pane service, never through core.

## Keymap

`mayflyKeymap` owns every dispatched key as a named action (`ui.save`,
`ui.search`, `ui.copy`, `ui.delete`, `ui.refresh`, `ui.external`, `ui.cancel`,
`ui.focus-next`, and the rest of `core/key-actions.ts`) with a scope: `global`,
`editor`, `surface`, or `stream`. A `global` action claims its key in every
scope; within overlapping scopes a key belongs to one action, and a conflict is
refused with the owner's name (`KEY_CONFLICT`). `bind`/`reset`/`resetAll` change
a key for the session (a rebound-away key is dead, not an alias; `Esc` and `Enter`
stay fixed), `list` offers registered and seen component actions for rebinding,
and `preferPlain` puts the plain second default first where Alt is not delivered (or the `preferPlainKeys` setting says so).
Component actions (`<owner>.<action>`) appear in nodes and in the hint row under
the same rule. Printable accelerators never pre-empt a control that takes text,
and `core/ui-key-grammar.ts` derives the hint row from the same state. A new
default key passes `tests/core/key-audit.spec.ts`.

## Interaction contracts

Use shared Form/Choice/Tree/Tab/ScrollView state for drafts, validation, locks,
confirmation, navigation, and acknowledgement. Observations report facts;
handled actions return structured settlements. Publish admitted acknowledgements
before settling native requests. Fence late validation, replies, and source data;
never overwrite newer snapshots or independent form errors.

Keep hidden branches and large lists lazy. Explicit submissions may admit their
own hidden forms; ordinary rendering/movement reads a bounded list window.
Filter/tree indexes change with query, disclosure, or definition, not each frame.
Passive transcript scrolls linearize into the outer viewport; interactive
surfaces retain semantic scroll state. Do not add fixed-width feature renderers.

Use shared Yes/No confirmation with No initially focused. Ordinary dirty forms
confirm dismissal; native decisions may explicitly discard. Wizard navigation
validates read boundaries without domain writes. Decision withdrawal, decline,
and whole-attempt cancellation are distinct; abort/Agent replacement/unload
must retire visible and queued requests before they grant or steer. OAuth
instructions belong only to the live authorization surface.

`core/ui-key-grammar.ts` is the single source for key dispatch and contextual
hints; [docs/interaction-model.md](../../docs/interaction-model.md) is the
spec. Changes to shared keys update `SHARED_KEY_REFERENCE` and both Website key
references together. Escape leaves one layer per press (picker, editing,
search, back, close); Tab commits text and open pickers; arrows up/down never
change a select. Editor shells leave every key except modifier accelerators to
the editor. Choice reducers never focus disabled rows. Consumers express
per-row availability with `unavailableActions` and questions with `confirm`,
not custom confirm pages or post-confirmation rejections.

Core reuses work by identity, never by value. A surface keeps one admission memo
(`ui-validator.ts`), one compile memo and one list-row memo (on its
`MayflyUiSurfaceRuntime`), and the renderer keeps one `UiAnimationClock`; none is
a module singleton. Only a frozen `isWireSnapshot` value is a cache key, a memo
hit must replay every quota and duplicate check, and a subtree that carries a
control, tab, page, action key, filter, editor slot, or responsive branch is
admitted whole each time. Reused leaves are static painters that read only their
node, width, colors, and components; a new palette recompiles them. The work
budgets in `tests/perf/budgets.json` only ratchet down.

An unchanged subtree costs nothing on republish, so a painter that paints rows is
written once in its cacheable form and brings its budget row. `list` reads
`selectedIds` through `listSelectedIds` (the field is optional on the wire).

An unchanged surface also costs nothing per frame. pi-tui lays a pane out on every
frame of the terminal and renders a component once per stack that measures it, so
every component `compileNode` returns answers a repeat render from memory
(`retain` in `core/ui-compiler.ts`), and so do the parts pi-tui lays out one by one
(a form's fields, a loader's row, a surface's head and tail). The rows hold for one
epoch of the surface (`MayflyUiSurfaceRuntime.epoch`). The rules a painter lives by:

- Whatever can change a row moves the epoch. A handled key, focus, `invalidate`,
  and a new compile move it where they happen; a frame moves it for a new host
  viewport, model revision, keymap revision, or completion state. State a painter
  reads from anywhere else needs its own `touch()`, or the component is volatile.
- A component that paints a live engine (the host editor, a prompt) is volatile:
  it always paints, and no render that contains it is remembered. Keep volatile
  components out of large trees.
- A moving cell reads the clock through `loaderFrame()` or `progressValue()`. Its
  render and the renders around it hold for one animation frame, a tick asks the
  host for a frame without invalidating (`requestFrame`), and the clock is armed
  only while the cell can be on screen (`core/ui-stacks.ts` places children; a
  cell outside the window of its scroll view does not arm it).
- A layout pass has one viewport, the frame the layout engine was given. A stack
  child's `visible` must not adopt the unbounded viewport of a measuring render.
- Stacks are `ColumnStack` and `RowStack`: pi-tui's rows, the row each child
  starts at, and a horizontal stack that remembers composited rows.

`pnpm run test:retained` runs the suites with `MAYFLY_UI_VERIFY_MEMO=1`: every
memo hit paints again and throws when the rows differ. A stale row is a test
failure there, not a report from a screen.

The presentation (`core/presentation.ts`: glyph mode, monochrome, reduced
motion, from the `mayfly` settings and `NO_COLOR`) is read when a theme provider
and the components service are built, never per paint. A change restarts the
live theme provider (`reloadTheme`), so every consumer and cached row rebuilds.

Build surfaces from the shared components (actions row, text/choice fields,
lists, tabs, decision panels, questionnaire, loader/progress/empty). The
[UI design](../../docs/design/component-library.md) is the target for a planned
refresh, not shipped behavior, and its
[implementation reference](../../docs/design/component-library-reference.md) holds
the wire mechanics. Never hand-roll pi-tui panels outside `core/`; the editor
autocomplete list is a retained legacy exception, not a model.

## Native writes and sensitive data

- `/plugin` keeps the marketplace catalog and CLI-backed installer. Installation,
  update, and removal apply after restart; HMR stays disabled in the default bundle.
- Optional collaboration plugins own their preset, tools, and UI contributions.
  The default bundle and shipped presets do not mount Agent Team. Keep upstream
  ordinary delegation available. Generic child navigation and the shared
  `mayfly/request-subagent-reply` event remain app/interaction-owned; replies
  explicitly choose Queue or Steer and fence exact-Agent replacement.

- Settings use shared forms and explicit native path-op commits. Bind writes to
  descriptor revision and exposed field projection; rehydrate with Schemastery.
  Never refresh-and-retry writes, expose saved secrets/schema secret defaults,
  or overwrite unsupported containers. Raw editing checks writability and the
  original file, suspends the screen, and ignores cancelled continuations.
- Provider discovery reads versioned drafts; only Save writes settings/credentials.
  MCP projections omit environment/header values. Skills browsing never loads
  skill bodies; incomplete catalogs retain only the same Agent's complete data.
- Presets use native `agentPresets.select()` and its turn-boundary guard, not
  recompose plus a manual event. UI withdrawal does not roll back native work.
  Plan toggles and permission presets remain independent; `pending` means queued.
- Jobs stays an ordinary preset sibling. Browsing uses `list/get`; only explicit
  Read output consumes `read`. Keep reads outside snapshots and page without
  losing long-line tails or splitting surrogate pairs. Recheck status for Stop;
  native notifications own terminal job state.
- Host commands use fixed-argument descriptors. `MAYFLY_DSH_BIN` wins over
  `DSH_BIN`/PATH; selected JS entries run through Node with no silent host fallback.
  Clipboard I/O shares the bounded subprocess runner. Profile parsing is internal.

## Verification and composition

Follow the root change-aware gate; lifecycle changes need the owning suite and
renderers need width scans. Core fixtures mount the UI provider and frontend
owner, and test that frontend state survives core reload. New public seams need
real consumers, replay/abort/late-result tests, width and whole-tree composition
coverage, and dedicated-profile acceptance.

The canonical UI pipeline takes an optional core-private work-counter sink
(`core/ui-work-counters.ts`) through the validator and compiler options; production
passes none and no module holds one. `tests/perf/work-budget.spec.ts` gates the
counts of the workloads in `tests/perf/workloads.ts`, so a change under
`src/core/ui-*.ts` keeps them within `tests/perf/baseline.json` or updates it on
purpose. `docs/design/prototypes/**` feeds the committed goldens under
`tests/design/golden/`; `pnpm run design:golden:check` fails when the prototype
changes, and `pnpm run design:golden` rewrites them after review. The budgets are
the work-budget gate of the foundation: `budgets.json` may not exceed
`baseline.json` (the work of the slice 1.0 pipeline), W1 and W4 gate again through
the node slot (`W1-slot`, `W4-slot`), a slice that adds a painter adds its row,
and wall-clock time from `script/audit-performance.mjs` is reported with a change
and gates nothing. W13 to W17 (`tests/perf/frame-workloads.ts`) count a whole frame
through the alternate layout, the lanes, and the surface renderer (leaf renders,
control walks, reconciliations, layout passes, clock ticks, keymap snapshots): a
budget row gates the counters it names, and a change to the frame path
(`core/terminal.ts`, `core/surface-renderer.ts`, the keymap, the editor-extension
runtime) runs them. `pnpm run bench:pty:assert` holds the real terminal to coarse
ceilings in the full gate. `tests/design/deltas.ts` lists every accepted difference from the
prototype (roadmap section 2.3) and `tests/design/pending.ts` only walks that wait
for Phase 3 or later; a new difference needs the reviewer's approval.

Patch, preset, skill, dependency, or composition edits require bundle/preset
tests, `pnpm run check:agent-docs`, `pnpm run verify:full`,
`pnpm run check:pack`, dedicated-profile install, PTY smoke, and human acceptance.
Keep `HARNESS_LINE` in `interaction/session-commands.ts`, where drift/build
scripts read it. The public side-question entry is `./btw-command`; do not restore
retired `./pane-btw` or `./attach-view` aliases.

The three shipped skills teach process-local Cordis prototyping, durable external
plugins, and user-owned composition. They use native dsh services and the four
Mayfly UI services, without special manifests, author CLIs, or private hosts.
