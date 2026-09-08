# `@ephemeral-ai/mayfly`

Owns runtime areas, public subpaths, the flat `cordis.patch.yml` composition,
and the `mayfly-cordis` preset. `src/index.ts` mounts nothing: the patch inserts
ordinary siblings over `dsh-base`. Use manifest exports for the public entry
list; do not duplicate row counts. Dependencies come from `inject`, not YAML
position. Feature code contributes snapshots or leases named internal screen
slots, never arbitrary root components.

## State and lifetime ownership

- `app/` owns primary/current-Agent selection, one auxiliary-view slot, and
  startup. Live auxiliary Agents become the exact current Agent; cold/one-shot
  children use the shared readonly transcript panel. Interrupt descendants
  through native ancestor authority without draining retained Activations/inbox.
- `frontend/index.ts` owns `mayflyUiInteraction` and independent consumer Fibers.
  Its models are implemented in `core/ui-interaction-*.ts` but survive core-only
  reload. Renderer teardown releases editors/handles, not drafts or choice state.
  Registry observers dispose only models from registrations they own.
- Provider setup and application information survive current-Agent/skills/core
  gaps. Agent-specific model, tool, MCP, skills, approval, and question consumers
  bind to exact Agent identity, including same-session-ID replacements. Detail
  views follow their parent/Agent/provider lifetime, not a completed operation.
- `interaction/` keeps editor/autocomplete state and prompt-submit transforms in
  separate Fiber services. Editor presentations are ordinary overlays projected
  into the fixed editor host; preserve and restore the prompt lease.
- `transcript/` has one selected-session controller, generation-keyed reuse, and
  lazy conversion of the latest unread native snapshot. Preserve complete
  cutoff-eligible history; BTW hides seeded history only in presentation. Do not
  rely on entry identity across native parsing or introduce a second session view.
- `conversation/` owns phase-local output measurements from session timestamps.
  Renderer timers animate or expire labels; they do not measure domain progress.

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

## Native writes and sensitive data

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

Patch, preset, skill, dependency, or composition edits require bundle/preset
tests, `pnpm run check:agent-docs`, `pnpm run verify:full`,
`pnpm run check:pack`, dedicated-profile install, PTY smoke, and human acceptance.
Keep `HARNESS_LINE` in `interaction/session-commands.ts`, where drift/build
scripts read it. The public side-question entry is `./btw-command`; do not restore
retired `./pane-btw` or `./attach-view` aliases.

The three shipped skills teach process-local Cordis prototyping, durable external
plugins, and user-owned composition. They use native dsh services and the four
Mayfly UI services, without special manifests, author CLIs, or private hosts.
