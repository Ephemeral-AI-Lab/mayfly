---
name: cordis-plugin-development
description: Inspect native DeepSeek Harness APIs and develop Host Cordis plugins in Mayfly creative mode. Use for Host tools, commands, services, and lifecycle debugging. Read the split-process limitations before promising a live terminal UI prototype.
---

# Develop a Host Cordis plugin

This skill runs on the dsh Host. The independent Mayfly terminal frontend has
its own process and Cordis tree. Host plugins cannot inject `mayflyPanes`,
`mayflyStatus`, `mayflyOverlays`, or `mayflyEditorExtensions`; those services
exist only in the frontend.

## Discover before implementing

1. Inspect the current tool list. `cordis_inspect_list` and
   `cordis_inspect_query` discover Providers and their exact method/type
   declarations; they do not invoke business methods.
2. Query only the Services, Events, Config, Builtins, or Tools needed by the
   task, using the actual returned schemas. Do not invent provider names or
   inspection arguments.
3. For a package-owned API, use `Config.listConfigs` to locate its `packageDir`,
   then read that package's README and public declarations. A preset-only
   plugin may be absent from this Host Loader directory.
4. Use documented native services directly. Agent-scoped work receives the
   exact Agent from its native invocation; never select a global or parent
   Agent as a substitute.

## Current dynamic-prototype limits

Harness `0.2.2-alpha.3` exposes only the two inspection model tools above.
There are no supplied `cordis_mount`, `cordis_define`, `cordis_run`,
`cordis_stop`, or `cordis_undefine` model tools. Do not tell the user that such
a tool ran, or replace it with an unreviewed helper tool.

The Host runner retains a programmatic definition lifecycle, but it is not a
Mayfly terminal extension channel. A dynamic `code.host` half runs on Host.
A `code.client` half requires the native browser runner and browser approval;
it does not run in the independent Node terminal frontend. Remote exposes no
public UI hot-load or external frontend plugin installation entry in this
release. A visible terminal prototype requires frontend source integration,
build, restart, and acceptance; load `mayfly-plugin-development` for that path.

## Implement authorized Host work

Create an ordinary ESM Cordis package only when file work is within the user's
request. Expose a built entry and a bundle patch through `package.json`; use
the official Plugin Manager or `dsh plugin --profile mayfly-<tag> add file:...`
for a dedicated profile. Do not edit installed shipped packages, mutate the
production `mayfly` profile, or publish a package without authorization.

An entry exports `name`, optional `inject`, and `apply(ctx)`. Declare hard
dependencies in `inject`, use `ctx.get()` for genuinely optional services, and
follow each inspected API's exact registration shape. Domain registrations
remain native `commands`, `tools`, `sessionProjections`, or another service's
own API. A Host extension may add a narrowly scoped, client-safe Remote
method when a real frontend consumer needs it; do not add a generic RPC or
execute-code bridge.

All registrations, listeners, timers, external resources, and async work belong
to the plugin Fiber. Use native effect/disposal facilities, fence cancellation
and generation changes after every await, and release captured Agent/Session
references when their native owner retires. Never recursively enumerate,
stringify, or expose live Cordis, Agent, Session, credentials, or connection
objects; construct the minimum owned readonly data required by a result.

## Verify

Mount the real plugin with the native services it consumes. Test exact-Agent
scope, duplicate registrations, unload cleanup, cancellation, and late results.
Build and pack the package, import its published entry, and verify the patch
and dependency closure. Run the primary workflow in a dedicated profile and
report the actual result. Host success alone is not evidence that a terminal
UI was rendered. Mayfly repository work follows its checkout's `AGENTS.md`.
