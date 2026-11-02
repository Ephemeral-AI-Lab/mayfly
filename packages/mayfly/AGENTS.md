# `@ephemeral-ai/mayfly`

Owns the shared terminal renderer and presentation used by the independent
Remote TUI. Public subpaths expose readonly data-to-node builders, renderer
services, themes, and transcript/editor controllers. There is no root plugin
entry, dsh bundle declaration, composition patch, or preset payload in the
published package. Native Host composition belongs to `packages/host`; Client
transport, feature state, and structured writes belong to `packages/remote`.

Historical in-process source and patch/preset fixtures remain private tests and
UI reference inputs. Their `apply`/`inject` entry points must not leak through
shared exports. Split mixed modules into pure shared models and private native
owners, and update every shared caller to import the pure model. The packed
runtime imports only Cordis, Schemastery, and the official browser-safe
`dsh-llm`/`dsh-session/surface` stream helpers from Harness; `check:pack` refuses
Host service runtime imports and legacy composition payload.

## State and lifetime ownership

- A resource acquired across an `await` registers its owner first and checks
  it again on resumption. Unload and stale-generation fences cover starts,
  late success, late failure, publishers, and acknowledgement continuations.
- Shared modules consume readonly facts and structured action replies. Native
  Agent selection, Session creation, provider/settings/plugin writes, jobs,
  side-session bindings, and command routing belong to Remote and Host. Old
  `app/`, native interaction, startup, and native projection owners remain
  private source fixtures; their services are not public frontend APIs.
- `frontend/index.ts` owns `mayflyUiInteraction`, images, locale, and consumer
  Fibers independently of core. Form/Choice/Tabs/Document/Prompt drafts,
  caret/recall/completion state, locks, confirmations, semantic focus, and
  feedback survive renderer gaps. Teardown releases terminal editors and
  handles, not valid frontend drafts. Registry observers dispose only their
  own registration instances.
- Locale namespaces are refcounted shared catalogs. Equivalent registrations
  share a catalog; conflicting content is an error. Use
  `memoizedLocaleTranslator` (`frontend/locale.ts`), with one observer Fiber
  per context/namespace and one resolution per locale revision. Shared words
  belong to `common`. Used keys, liveness, placeholders, and zh terminology
  stay covered by `tests/locale-catalog.spec.ts`.
- Shared conversation presentation never folds durable Host history. The
  public bounded `transientAssistantConversation` helper accepts only the
  current assistant attempt. Official whole Host snapshots supply durable
  conversation and facts; reconnect replaces baselines. Explicit settled-step
  facts close live content, never a reasoning animation flag. Durable
  `updatedSeq` and transient `renderRevision` are separate clocks.
- Tool presenter sources optionally implement `getForCall(name, callId)` for
  both call and result resolution. A missing exact-call view never falls back
  to `get(name)`. Native registries receive only the name; their second argument
  remains the native private scope. Asynchronous Remote sources use the exact
  call identity to preserve repeated calls independently
  of lookup count or argument equality. Keep native Read windows, Edit diffs,
  Write bodies, and absolute result paths intact across this seam.
- Transcript controllers keep one view per displayed/retained conversation,
  stash hidden values without conversion, and lazily convert floor-eligible
  entries on display. BTW history floors hide seeds only in presentation.
  Entry identity cannot be assumed across native decoding. Live publishes
  coalesce bursts under their fixed budget and publish immediately when a
  step settles or turn closes. Timers animate labels; domain progress comes
  from native timestamps and projections.
- The activity row owns live phase, elapsed time, action, and throughput.
  Transcript rows show content and settled summaries. A surface without an
  activity row may opt into its running-turn header. Decision components use
  readonly queue facts supplied by the caller, never inspect an overlay.

## Node slots

`screen.mountNodeSlot(id, { region: 'content' | 'dock' | 'footer' })` is a
core-private lease (`core/node-slot.ts`) whose wire node compiles through the
surface path, with the same compiler entry, runtime, and caches as a pane, into
one of the screen's fixed hosts. Its interaction state is a `slot` model in
`mayflyUiInteraction`, so a screen teardown revokes the lease and keeps the
model for the next lease of the same id; only `dispose()` drops it. Mayfly
features reach the footer, the editor, and the conversation through slots, never
through a new root component. Plugins still use only the four public services.

The `content` region is the content of the outer scroll: while the slot holds no
focus its lists and rows are not bounded by the viewport (`MayflyUiSurfaceRuntime.flowing`),
and the scroll view windows what they paint, so wheel, page keys, and follow-tail
work as for any content. A focused slot keeps the list's cursor window. An owner
can follow one list item with `MayflyNodeSlot.track(controlId, itemId)`: each paint
of a flowing list notes the item's line, and `trackedRow()` returns it among the
scroll content's rows (the new-messages rule uses it to find itself against the
view). The content scroll (`TailScrollView`) paints the rows of its window before it
settles on a height, lays out again when painted rows moved the length it measured, and
a scroll it cannot take asks for a frame, so a lazy document's estimate never leaves the
last rows out of reach. That holds only while every layer between the document and the
scroll (the flowing list's painter, a column stack, the surface frame) reports the live
length and passes `prepare` on: none may slice at a length it read once or keep a height
it measured before the rows painted. Follow-tail is `Ctrl+↓`'s second press: the first goes to that rule. The
conversation stream (`TranscriptView`, published by `transcript/transcript-model.ts`
from `transcript/stream-facts.ts`) is the first consumer.

## Components area

`src/components/` holds the Mayfly components as pure functions of facts that
return `ui.*` nodes (`TranscriptView`, `ToolLine`, `ActivityRow`,
`NotificationLine`, `CompactionRow`, and `DecisionCard`). Feature owners supply
readonly decision queues; the stream maps the first request to its call block
and never reads an overlay.

It has no Cordis entry and no public subpath, and a component is imported from
its own module. A file there imports
only `@ephemeral-ai/mayfly-ui` and its siblings and contains no `node:` module,
Cordis, `../core`, width helper, escape sequence, timer, or key binding.
The feature plugins that publish a component's nodes own its facts, its
Fibers, and its writes; `core/` owns widths, ANSI, clocks, and keys.
`tests/components/layering.spec.ts` is the guard, and it must keep failing on
each of those constructs. A new component module extends the guard's reach
without edits, and its row renderers join the owning `width-scan.spec.ts`.

## Views lane

The pure `buildModelStatusNode`, `buildCwdStatusNode`, and
`buildContextStatusNode` helpers on the existing status subpaths also serve the
independent Remote frontend. `transcript.mountStatusFooter` leases their shared
registry row and returns an early disposer in addition to Fiber cleanup. Keep
these data-to-node helpers independent of Agent access; the native in-process
producers and Remote supply their own exact-snapshot facts. `banner-content`
exports the splash composer/types and canonical fly-in timing for the same
reason.

`session-browser` exposes the same workspace rail, catalog/search form, and
detail nodes used by the in-process `/sessions` panel. Remote maps its native
Client snapshots into readonly display facts; this shared model must never
retain a Session, open history, or perform Workspace writes.

`command-panels` exposes the reference changelog content and its pure node
builder alongside help, version, context, rewind, rename, and update presentation.
The shared rename model preserves the reference title form and Enter action;
each frontend owns native writes and the exact selected Session's lifetime.
The shared subagent tree preserves the reference tree, slash filter, row metrics
and selected-row stop confirmation. Owners supply native descendant facts and
localized availability reasons; the model never lists or stops an Agent.
The Remote router owns command admission; its app-scoped overlay owns locale
subscriptions, scrolling, focus restoration, and disposal.
It also exposes the rc.2 MCP/tool catalog, Job browser and reminder builders.
The private native owners consume the same pure models. Preserve resource URI
editing, template rows, resource body/back layers and the distinct Job browser
list; the Jobs status view is a different presentation. Missing tool parameters
remain absent facts and render the reference empty-schema message.

`trace` exposes the rc.2 timeline, responsive detail nodes, and clipboard
formatters over readonly native trace facts. Host owns complete Session queries,
surface classification, stream grouping, and direct event relationships;
Remote owns reads, selection, cancellation, and frontend-local clipboard writes.
The shared trace model never queries or folds native Session state.

A `mayflyPanes` pane with `placement: 'views'` is a view of the status row, kept
by `core/views-lane.ts` (`SurfaceManager.views`), not by a pane lane: it has no
rows of its own, its summary joins the status row through the footer, and an entered
panel opens under the status row (which stays, with a `━` line under the active item as its second line). A view's slot lives with its `PaneComponent`. Entry keys
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

One deeply frozen wire subtree may occupy mutually exclusive responsive children
of the same stack while keeping one control and action identity. Each child is
fully admitted and charged its quotas independently; its reservations may reuse
an identical sibling's reservations once only when page, depth, scroll context,
and local viewport exclusivity agree. Mutable declarations, different stacks,
overlapping conditions, and subtrees with further responsive children receive no
reservation sharing. Failed deferred admission restores all budget and key state.

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
- Pages switched in place keep one height, the tallest page's at the current
  width and viewport: `holdHeight` (`core/ui-stacks.ts`) pads the page on show
  for tab pages (`PageHold`) and for the views lane. Components never pin page
  heights of their own to the same end.

Every spec outside `tests/perf/` runs with `MAYFLY_UI_VERIFY_MEMO=1` (the vitest
`suite` project): every memo hit paints again and throws when the rows differ. A
stale row is a test failure, not a report from a screen.

The presentation (`core/presentation.ts`: glyph mode, monochrome, reduced
motion, from the `mayfly` settings and `NO_COLOR`) is read when a theme provider
and the components service are built, never per paint. A change restarts the
live theme provider (`reloadTheme`), so every consumer and cached row rebuilds.
Independent frontends retaining a native editor across palette swaps call
`MayflyEditor.updateColors` and rebuild its frame around that same engine;
recoloring never replaces its cursor, undo, history, paste, or completion state.

Build surfaces from the shared components (actions row, text/choice fields,
lists, tabs, decision panels, questionnaire, loader/progress/empty). The
[UI design](../../docs/design/component-library.md) and its prototype are the
starting sketch; the owner's acceptance in the running terminal decides, and a
finalized section describes accepted behavior. Its
[implementation reference](../../docs/design/component-library-reference.md) holds
the wire mechanics. Never hand-roll pi-tui panels outside `core/`; the editor's
completion list is state only (`core/completion-list.ts`) and the palette that
paints it is `core/completion-drawer.ts`. A component that replaces a surface deletes the old code in
the same change; nothing is kept for a later cleanup.

## Shared action and sensitive-data contracts

Remote/Host own native writes. Shared marketplace, settings, provider, jobs,
and catalog models contain facts and structured actions only. They never
import Host services, mutate profile files, spawn package managers, retain
credentials, or refresh-and-retry conflicts. Keep descriptor/field revisions,
explicit confirmations, restart boundaries, and operation feedback in the
readonly models so feature owners can preserve the native semantics.

Secrets stay redacted and saved schema defaults never become form values.
MCP facts omit environment/header values. Clipboard, exports, palettes, and
external editors are frontend-local; shared nodes never encode arbitrary
Host paths or commands as executable operations. No renderer timer, panel
closure, or UI withdrawal silently rolls back or cancels Host work.

## Verification and composition

Follow the root change-aware gate; lifecycle changes need the owning suite and
renderers need width scans. Core fixtures mount the UI provider and frontend
owner, and test that frontend state survives core reload. New public seams need
real consumers, replay/abort/late-result tests, width and whole-tree composition
coverage, and dedicated-profile acceptance.

The historical scenario catalog (`script/scenarios/catalog.mjs`) records live
states behind `pnpm run scenario` and `pnpm run frame`, including a replay of
`script/scenarios/replays.mjs` with the marks its script plays to, played into the real product by
`script/scenarios/driver.mjs`. A `manual` entry is owner-only, runs through
`pnpm run scenario`, and has no frame or golden. The Website's app shots are
checkpoints of the `app-*` scenarios, painted from their goldens.

The canonical UI pipeline takes an optional core-private work-counter sink
(`core/ui-work-counters.ts`) through the validator and compiler options; production
passes none and no module holds one. `tests/perf/work-budget.spec.ts` gates the
counts of the workloads in `tests/perf/workloads.ts`, so a change under
`src/core/ui-*.ts` keeps them within `tests/perf/baseline.json` or updates it on
purpose. The budgets are
the work-budget gate of the foundation: `budgets.json` may not exceed
`baseline.json` (the work of the slice 1.0 pipeline), W1 and W4 gate again through
the node slot (`W1-slot`, `W4-slot`), a slice that adds a painter adds its row,
and wall-clock time from `script/audit-performance.mjs` is reported with a change
and gates nothing. W13 to W17 (`tests/perf/frame-workloads.ts`) count a whole frame
through the alternate layout, the lanes, and the surface renderer (leaf renders,
control walks, reconciliations, layout passes, clock ticks, keymap snapshots): a
budget row gates the counters it names, and a change to the frame path
(`core/terminal.ts`, `core/surface-renderer.ts`, the keymap, the editor-extension
runtime) runs them. `pnpm run perf -- --assert` holds the perf scenarios of the
real terminal to the catalog's coarse ceilings in the full tier. The design scenes (`tests/design/scene-*.spec.ts`) drive
the real renderer under the probe palette (`tests/design/probe.ts`) through the walks
of `tests/design/walks.ts` and compare every frame with a cell-grid golden under
`tests/design/frames/` (`script/scenarios/grid.mjs`); `vitest -u` rewrites a grid
after review. Those grids are the visual record of Phase 1 until the foundation
review replaces them. The prototype is a sketch and gates nothing. The owner's live
acceptance decides a component's look, and its accepted frames become its goldens.

Publication, dependency, or composition edits require package/bundle
tests, `pnpm run check:agent-docs`, `pnpm run check -- --tier full`,
`pnpm run check:pack`, dedicated-profile install, PTY smoke, and human acceptance.
Keep `HARNESS_LINE` in `interaction/session-commands.ts`, where drift/build
scripts read it. Native side-question, startup, app, and interaction entries are
private source fixtures, never public compatibility exports.

The legacy preset skills remain repository fixtures for process-local Cordis
prototyping, durable external plugins, and user-owned composition. They are not
published by this shared renderer package.

## Split frontend consumers

The shared `transcript` entry exposes the presentation policy, resolved-settings
observer, locale catalog and focus-status builder to independent frontends.
Each frontend owns its policy capsule and publishes controller focus facts;
the observer follows both native document updates and frontend settings-source
replacement, retiring queued callbacks with its Fiber. Core's
`normalizeWheelInput` is the shared terminal decoder; frontends route its
structured result to the existing scroll controller instead of decoding ANSI.
Core's `sanitizeShellOutput` also owns captured-output control-sequence removal;
native and independent frontends consume it instead of keeping ANSI parsers.

`./plugin-marketplace` exposes the shared marketplace component, readonly
model/facts and discovery catalog. Host plugin mutations remain native Remote
calls in the independent frontend; this subpath never imports Host services.
`./editor-presentation` also exposes the common readonly decision-card and
activity models, native-decision presentation facts, and teaching-tip rotation.
The resumed-session notice text is also shared; each frontend owns its own
selection identity and notification lifetime.
Independent frontends derive those facts from native requests/projections and
consume these shared builders instead of maintaining another renderer model.
The same subpath exports `EditorExtensionRuntime`, the sole editor shell,
decoration/action consumer, completion multiplexer and pre-clear transform
barrier. Its input owner binds exact autocomplete sources, delayed-wait
ownership and readonly attachment metadata with deferred result preparation.
It never accesses native PromptEditor or image state. Rebinding retires old
callbacks and submissions; retained source callbacks and old disposers cannot
affect a successor. Palette refresh recompiles around the same editor and
focus identity. The private interaction entry supplies only native bindings
and reversible image admission for the legacy reference and perf fixtures.
The npm 0.1.4-rc.2 reference is immutable; candidate rendering comes from this
checkout's built package. Develop behavior and meaningful tests together, then validate the combined
split runtime under the root gate. Shared renderer evidence alone does not
establish complete reference parity.

`files-browser` exports the readonly rc.2 Files list/detail/diff builder used by
both native and Remote controllers. Facts expose only metadata and preview/open
availability; filesystem targets stay in their controller. Preserve the frozen
source fixtures and interaction width scan when changing its output.

`./stats-presentation` exposes the rc.2 statistics panel, pure facts, summaries,
range aggregation and readonly digest/account types. It performs no native
Session, account, credential or filesystem reads. Owners supply the Host home
directory explicitly when collapsing Host paths; a Remote machine's home must
not determine their display. Native account I/O stays outside the pure account
model, which preserves decimal amounts for exact wallet addition.
