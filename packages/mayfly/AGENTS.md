# `@ephemeral-ai/mayfly`

This package owns every Mayfly runtime area and the installable flat Cordis
composition. Its root module entry owns no product behavior; concrete public
subpaths map to the internal frontend, conversation, app, core, transcript,
interaction, theme, status, pane, and command areas.

Only `src/core/` may import pi-tui or own ANSI, raw-terminal state, focus,
layout, fixed root hosts, named screen slots, and visible-width truth. Renderer-neutral areas contain readonly data
and structured actions only. Harness Agent/session/domain state remains owned
by native dsh services; `src/app/` owns only current-Agent selection and
startup coordination.

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
editor-panel hosting, and prompt-submit transforms in three separate Fiber
services. Core keeps form drafts, control/scroll bindings, and virtual-list
cursors in dedicated surface-state stores.

The preset ships three user-facing skills: process-local Cordis prototyping,
durable ordinary Cordis plugin development, and user-owned composition
editing. They must teach direct native dsh services and the four Mayfly UI
services. They must not teach a special manifest, capability request, author
CLI, private realm, or Mayfly host.

Patch, preset, skill, dependency, or composition changes require bundle and
preset tests, `pnpm run check:agent-docs`, `pnpm run verify:full`,
`pnpm run check:pack`, dedicated-profile install, PTY smoke, and human
acceptance. Do not merge or remove the acceptance profile before approval.
