# Quickstart

Choose the process where the plugin runs. Use Node `>=24.9.0`, the repository's
pinned pnpm, and Harness `0.2.2-rc.1`; match Cordis peers to the selected
Host/Remote release.

## Host plugin

A Host extension is an ordinary ESM Cordis package exporting built `name`,
optional `inject`, and `apply(ctx)`. See [commands](/en/plugins/commands) for
native service usage. An installable Host bundle also exports and publishes
its native `cordis.patch.yml` through `package.json`.

Build it, then install into an existing dedicated Mayfly Host profile:

```sh
dsh plugin --profile mayfly-build-health add file:/absolute/path/to/host-plugin
dsh --profile mayfly-build-health
```

This path adds Host capabilities; it does not mount TUI nodes.

## TUI source integration

A terminal presentation entry directly depends on the four UI services:

```ts
import type { Context } from '@deepseek-ai/cordis'
import { ui } from '@ephemeral-ai/mayfly-ui'

export const name = '@acme/build-health-ui'
export const inject = ['mayflyStatus']

export function apply(ctx: Context): void {
  ctx.mayflyStatus.register({
    id: 'acme.build-health', priority: 30, band: 'right',
  }, ui.text('healthy', { tone: 'success' }))
}
```

Compose it into a TUI entry of your own. `run` from `@ephemeral-ai/mayfly/bin`
is the `mayfly` command itself, with the same options and environment; the
plugins load into the TUI's Cordis tree after its built-in features and unload
with it:

```ts
import { run } from '@ephemeral-ai/mayfly/bin'
import * as buildHealth from '@acme/build-health-ui'

await run(process.argv.slice(2), { plugins: [buildHealth] })
```

Start the Host separately, as for `mayfly`, then run the entry with the Host's
startup URL:

```sh
dsh --profile mayfly-build-health
MAYFLY_DSH_STARTUP_URL='<Host URL>' node ./build-health-tui.js
```

`examples/mayfly-ecosystem` is a complete composition. There is no installer or
hot-loading for TUI plugins: a composition is an ordinary program. The TUI's
tree has the four UI services but no native dsh services; a TUI plugin needing
Host state reads official Client facts or focused Mayfly Host DTOs, then
publishes readonly UI nodes. Do not use the production `mayfly` profile for
acceptance.
