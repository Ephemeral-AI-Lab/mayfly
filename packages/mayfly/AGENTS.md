# `@ephemeral-ai/mayfly`

This package owns every Mayfly runtime area and the installable flat Cordis
composition. Its root module entry owns no product behavior; concrete public
subpaths map to the internal frontend, conversation, app, core, transcript,
interaction, theme, status, pane, and command areas.

Only `src/core/` may import pi-tui or own ANSI, raw-terminal state, focus,
layout, fixed root hosts, named screen slots, and visible-width truth. Renderer-neutral areas contain readonly data
and structured actions only. Harness Agent/session/domain state remains owned
by native dsh services; `src/app/` owns only primary/current-Agent selection,
one auxiliary-view slot, and startup coordination. A live auxiliary Agent is
the exact current Agent, so the ordinary transcript, status, panes, commands,
and editor follow it. One-shot or cold children use the core-owned readonly
transcript panel; interaction must not add another handwritten session view.
Interrupting the selected Agent also interrupts every running continuable
descendant through the native exact-ancestor authority; it must preserve child
Activations and inbox work rather than calling a drain/teardown API.

`cordis.patch.yml` inserts 34 ordinary siblings over `dsh-base`: six dsh
support rows and 28 Mayfly rows. Dynamic plugins, official Mayfly rows, and native
dsh services share one service graph. There is no Cordis group/isolate,
service deny-list, host facade, adapter layer, or provider owner.

Feature code publishes immutable registry snapshots or leases a named internal screen slot;
it never appends arbitrary root components. Ordering requirements are explicit `inject` dependencies, never YAML
position. Mayfly UI services mount before their consumers; app supplies
`mayflyCurrentAgent`; transcript and interaction consume native dsh services
and publish direct UI contributions.

The transcript owns one selected-session controller and keys entry reuse by
session generation. Interaction keeps current-editor/autocomplete state and
prompt-submit transforms in separate Fiber services. Editor presentations are
ordinary overlays; the old editor-panel and generic select/info controller
stacks are removed. Core keeps form
editor bindings, control/scroll handles, and the common framed scroll panel in
renderer-owned implementations. Public pane/overlay drafts and choice state live
in the frontend-owned `mayflyUiInteraction` instances, not renderer objects.

The frontend interaction owner has no app/current-Agent, skills, theme, component,
screen, or keymap dependency. Its separate registry observer Fibers preserve live
contributions across renderer gaps and dispose only the registrations they own.
Renderer teardown releases editors and handles without disposing these models.
Form fields and field pickers use the shared Form/Choice reducers; confirmation,
submission locking, callback validation, and acknowledgement publication go
through the surface model. Explicit submissions may admit their own hidden form
branches, but unrelated hidden content and large list items stay lazy. Accepted
snapshots must not replace newer source data, including unversioned resources.
Flat list indexes are implicit. Filter and Tree visible indexes are recomputed
only when query, disclosure, or definition state changes; ordinary render and
movement read a bounded window and the stored visible focus position, never scan
the complete collection.
Public interaction definitions route observation facts through `onEvent.observe`
and explicit selections/submits/activations/dismissals through `onEvent.action`.
Handled actions always return a structured settlement; observation replies cannot
publish a replacement snapshot or close the surface.

The remaining command bundle explicitly depends on the overlay registry; command
fixtures must mount the UI provider. Renderer fixtures additionally mount the
frontend owner, which must survive a core-only unload.
The input bundle also explicitly depends on the overlay registry because its
bare `/permission` route opens the shared preset picker from the editor.
Overlay and editor presentations use one third of the terminal as their default
maximum height. Short panels retain their natural height; only overflowing
content activates the bounded layout or list window.

Provider management and first-run credential setup mount under frontend-owned
Fibers; app readiness only triggers the latter through a separate child. They
must remain usable while current-Agent/skills or renderer providers are absent.
Agent-specific model selection uses a child Fiber tied to the exact selected
Agent and retires on selection/provider changes. Provider discovery reads a
versioned draft snapshot; only explicit Save writes settings/credentials.

Preset selection is a frontend child depending on native commands/agentPresets,
current-Agent selection, and overlays. It uses shared Choice state and the
native `agentPresets.select()` queue and turn-boundary guard. Mayfly checks the
exact selected Agent and idle status before starting, and never composes a
second preset transaction from `recompose()` plus a manual event append. A
native selection already started may complete after the UI is withdrawn;
retire the UI and late feedback without claiming that native work rolled back.
The unused `form-panel.ts` and `select.ts` controllers are removed; Form and
MultiSelect consumers use shared nodes and reducers directly.

Tools and MCP browsers are independent frontend consumers of native services.
They publish ordinary lists, tabs, and scrollable schema documents; no feature
code wraps text to a fixed width or instantiates an InfoPanel/select controller.
Tool reads use the exact selected Agent. MCP registered counts join global
names with that Agent's scoped names, while visible schemas retain native
restrictions. Environment/header values never enter MCP projections.
Detail overlays are child Fibers of their browser. Parent withdrawal, Agent
replacement, backend unload, or an inaccessible target retires descendants.
Unchanged tool documents are not republished for unrelated catalog changes.
Failed MCP refreshes explicitly mark the retained snapshot as stale.

Session information is a frontend consumer. Status/context read all required
native projections in one snapshot for the exact Agent; version/changelog have
application lifetimes and survive current-Agent or projection-provider gaps.
Context composition is heuristic chart data, distinct from provider-anchored
occupancy. Feature code must not rebuild character bars or fixed glyph grids.
The profile display identity is configured on frontend (`displayVersion`), not
interaction/commands. Keep the maintained `HARNESS_LINE` constant in
`interaction/session-commands.ts`, where build and drift scripts read it.

The skills catalog is a frontend child of native skills/current-Agent services.
It follows exact Agent identity, including same-session-ID replacement, and
aborts obsolete discovery. Incomplete observations retain only that Agent's last
complete catalog and expose incompleteness; changing Agent clears it. `/skills`,
prompt completion, and `#` rewriting share this catalog. Skill details are
ordinary child overlays and never invoke or load a skill body while browsing.

Native approvals and questions mount as frontend children depending on the
current-Agent and overlay services, independently of the input/skills/renderer
tree. Their consumer code declares ordinary overlays and maps native results;
it owns no cursor, feedback editor, question draft, or terminal shortcut. Native
results settle only after the operation's admitted acknowledgement publishes.
Approval keeps its own FIFO and exact-Agent session allowances. Signal abort,
Agent replacement (including the same session ID), and Fiber unload withdraw
visible and queued requests before they can grant or steer.

Wizard steps use shared tabs and form revisions. Explicit navigation validates
its declared read boundary without a domain write; editing or conflicting data
invalidates completion. Questionnaires submit all declared forms through one
final action, preserving native empty/Other answer semantics. A feedback page's
declared return target retains its draft. Decision overlays explicitly discard
on outer dismissal, while ordinary dirty forms require shared confirmation.
Shared document scrolls use the available layout in main and alternate modes;
never restore the old 20-row content truncation or consumer-specific leaf paths.
Operation signals end at settlement, including failed reply admission. A child
view must use its owning UI/command lifetime, not a completed operation signal.

Passive transcript canonical nodes render complete leaves and receive the live
screen viewport for responsive conditions and list windows. A passive main-mode
scroll is linearized into the outer transcript viewport; interactive surfaces
retain semantic ScrollView state. `MayflyUiCompilerOptions` has no max-leaf,
leaf-path, leaf-offset, or leaf-scroll compatibility callbacks.

The settings command mounts under frontend with native settings/commands and
the ordinary overlay registry. Each namespace uses one shared form and one
explicit path-op commit. Rehydrate descriptor schemas with Schemastery; do not
reintroduce string cycles or refresh-and-retry writes. Bind a submission to both
the raw descriptor revision and its exposed field projection, because a schema
or composition-base replacement may reuse a raw revision. Cosmetic translation
does not alter that projection version. Core renders inheritance, override,
reset, and conflict controls, and resets fence old field validation.

Settings snapshots never contain saved secrets or schema secret defaults.
Unsupported containers remain opaque and unchanged by form commits. Raw-file
editing respects provider writability, uses core screen suspension, checks the
original file before writing, and ignores cancelled continuations. The retired
`createSettingsList`, `MayflySettingItem`, `MayflySettingsListOptions`, and
`MayflySettingsList` component API has no compatibility export.

Editor replacements are direct overlay registrations with
`presentation: 'editor'`. The overlay registry owns their activation order;
core projects the active registration into the existing fixed editor host,
preserving the prompt lease and restoring it across replacement gaps. Do not
introduce a second panel event dispatcher or cache renderer objects as UI state.
OAuth URL/code instructions belong to the live authorization surface and its
native prompts. Prompt withdrawal is distinct from a human decline and whole
attempt cancellation; completion releases the sensitive instruction references.

Plan selection and permission presets are independent native dsh state.
Editor Shift+Tab toggles only `/plan` and `/plan off`; full access requires
an explicit `/permission` selection. Status renders plan and yolo together
when both apply. The plan wire projection's `pending` flag means a transition
is queued, not the target boolean; repeated toggles invert the selected state.

Binary confirmations use the shared canonical Yes/No action panel, with No
initially focused and Escape cancelling. Do not model confirmation as a text
field requiring a fixed token. Forms collect actual user data.

Jobs remains its existing ordinary preset sibling, not another frontend child.
Its browser and inspector use native `list/get` without consuming output; only
explicit Read output invokes `read` for the exact selected Agent. Retain each
read outside UI snapshots and publish bounded pages without dropping long-line
tails or splitting surrogate pairs. Paging and locale changes reuse the read;
locale refresh reads the published page baseline while shared Form owns drafts.
Stop uses the shared confirmation and rechecks native status. Native notifications
own its terminal state; a completed action must not publish an older snapshot.
Browser, inspector, output, timers, and listeners follow parent/Agent/provider
Fibers. Native registry tests attach a controller only in the fixture; Mayfly UI
does not take over native job admission or completion reporting.

Explicit form read/submit validation revokes pending field validators only in
that boundary. Their late success cannot clear current submission errors, and
validators for independent forms remain live.

Search text normalization belongs to core's shared native-editor input, including
paste framing and grapheme deletion. Provider workflow outcomes carry structured
status independently of their translated copy. A field being edited owns Delete
and Ctrl-D; entity deletion is a browsing action.

Native session projections validate whole values. The transcript source retains
the latest unread native value and converts it on the next snapshot read, so
stream bursts do not repeatedly parse and present history before a frame. Attach,
detach, and unload discard pending values; session generations isolate rendered
entries. Conversion preserves all cutoff-eligible history. Do not assume entry
identity survives native Zod parsing. Native whole-value validation and each
rendered conversion may still scale with history length.

The conversation projections own phase-local output measurements from session
event timestamps. Thinking animation stops at reasoning block completion or a
switch to text/tools, while the final assistant message still corrects its
content. Thinking headers and composing activity rows consume those readonly
measurements; renderer timers only animate and expire stale rate labels.

In-app host operations use an internal command plus fixed-argument descriptor.
The launcher's `MAYFLY_DSH_BIN` wins over `DSH_BIN` and PATH; a selected JavaScript
entry runs through Node and must never silently fall back to another host.
Clipboard readers and writers share one bounded subprocess runner. Profile argv
parsing is shared internally with the app, without a new public export.

BTW children retain the full seeded parent event stream for model context, but
the transcript source applies the recorded seed cutoff so inherited history is
not shown in the BTW conversation view.

The public side-question entry is `./btw-command`. `./pane-btw` and
`./attach-view` are retired without compatibility exports.

The preset ships three user-facing skills: process-local Cordis prototyping,
durable ordinary Cordis plugin development, and user-owned composition
editing. They must teach direct native dsh services and the four Mayfly UI
services. They must not teach a special manifest, capability request, author
CLI, private realm, or Mayfly host.

Patch, preset, skill, dependency, or composition changes require bundle and
preset tests, `pnpm run check:agent-docs`, `pnpm run verify:full`,
`pnpm run check:pack`, dedicated-profile install, PTY smoke, and human
acceptance. Do not merge or remove the acceptance profile before approval.
