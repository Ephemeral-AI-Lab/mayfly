---
name: mayfly-plugin-development
description: Develop a durable Mayfly extension after identifying its Host, Agent-preset, or independent terminal-frontend process. Use for persistent native plugins, split frontend integration, or migration of an old in-process Mayfly plugin; state unsupported UI hot-loading explicitly.
---

# Develop a durable split Mayfly extension

Choose the process that owns the behavior before writing code. Preserve the
user's existing authorization and destination; ask only about material choices
the request and repository cannot resolve.

| Behavior | Owner and deployment |
| --- | --- |
| Tools, commands, domain services, persistence, credentials, projections | Native dsh Host; ordinary Cordis bundle installed by Plugin Manager |
| Persona, model-facing tools, prompt sections, skill roots | Native Agent preset declared in a user-owned bundle |
| Terminal panes, status, overlays, editor extensions, focus and layout | Independent `@ephemeral-ai/mayfly` TUI process; a plugin in a TUI source composition |
| Renderer-neutral node contracts and builders | `@ephemeral-ai/mayfly-ui` |

## Audit a migration

Find every entry, injection, event subscription, timer, mutable singleton,
Agent/Session reference, public export, dependency, and patch row. Old plugins
that reached `mayflyCurrentAgent` or terminal services from the Host need their
process boundary redesigned. Do not recreate the retired in-process TUI,
private runtime realm, or a generic Host adapter facade.

Native domain plugins consume documented dsh services directly. Terminal UI
uses only the frontend-local `mayflyPanes`, `mayflyStatus`, `mayflyOverlays`,
and `mayflyEditorExtensions`. Frontend actions use the documented native
Client API with the exact currently selected Host and namespaced SessionRef.
The Host Agent belongs to the Host; a frontend never stores it or folds its
events into a second domain state machine.

## Host package path

Implement an ordinary ESM Cordis package with built exports, types, a package
`files` whitelist, and `dsh.bundle.patch`. The patch inserts its public entry.
Use `name`, optional `inject`, and `apply(ctx)`; discover exact native API
signatures through `cordis_inspect_list` / `cordis_inspect_query` and package
declarations. Keep native domain state in its native owner. A new Remote seam
must have a real consumer, readonly serializable facts, structured writes,
exact authorization, and abort/stale-result tests.

Install the verified package into a dedicated `mayfly-<tag>` profile with the
official Plugin Manager or `dsh plugin --profile mayfly-<tag> add file:...`.
Build before installing and restart when the changed native package requires
it. Host installation changes the Host tree only.

## Terminal UI path and current limits

There is no external frontend plugin installer or UI hot-load entry in this
release. A Host `dsh plugin` install cannot mount a terminal pane, and the
native dynamic runner's browser `code.client` half cannot reach the Node TUI
process. Current model tools do not supply dynamic define/run/mount
operations. State these limits before proposing an in-session visual result.

An authorized terminal feature is an ordinary Cordis plugin (`name`, optional
`inject`, `apply(ctx)`) that a TUI source composition loads: an entry calling
`run(process.argv.slice(2), { plugins: [plugin] })` from
`@ephemeral-ai/mayfly/bin`, which keeps every `mayfly` option and environment
variable. `examples/mayfly-ecosystem` in the Mayfly repository is a complete
composition. Build the entry and restart the TUI to load a change. Follow the
checkout's root and owning-package `AGENTS.md`; do not invent a plugin-author
CLI, hidden loader, bridge, or manifest. Use the four UI services in that
process, `@ephemeral-ai/mayfly-ui` builders, and documented native Client
operations. A model contains
readonly data and structured actions, never ANSI, terminal width, focus handles,
Promises, Agent/Session objects, or renderer instances. Core owns width,
palette, focus, input, and terminal state.

Do not claim an unavailable integration path is complete: a composition is an
ordinary program the user starts, not an installed or hot-loaded extension.

## Verification and acceptance

Verify native Host behavior and frontend rendering independently, then exercise
their real connection together. Include exact Host/Session selection,
reconnect and stale-generation fencing, abort, late failures, and Fiber cleanup.
Visible UI must use shared components and render within narrow and wide widths;
test focus restoration and renderer reload without losing drafts.

Check built/package closure and publication-shaped imports. Use a dedicated
profile for the actual workflow, and keep acceptance available until the user
has reviewed it. Publishing, remote repository work, and production-profile
changes require their own authorization. Never edit shipped bundle files.
