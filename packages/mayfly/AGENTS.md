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
session generation. Interaction keeps current-editor/autocomplete state,
the replayable editor-panel stack, and prompt-submit transforms in three
separate Fiber services. Help and read-only information share one panel;
single/multi-select behavior shares one list controller. Core keeps form
drafts, control/scroll bindings, virtual-list cursors, and the common framed
scroll panel in dedicated renderer-owned implementations.

Plan selection and permission presets are independent native dsh state.
Editor Shift+Tab toggles only `/plan` and `/plan off`; full access requires
an explicit `/permission` selection. Status renders plan and yolo together
when both apply. The plan wire projection's `pending` flag means a transition
is queued, not the target boolean; repeated toggles invert the selected state.

Binary confirmations use the shared canonical Yes/No action panel, with No
initially focused and Escape cancelling. Do not model confirmation as a text
field requiring a fixed token. Forms collect actual user data.

Job detail retains each consuming read outside canonical snapshots and admits
bounded output pages, including for single lines larger than the text quota.

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
