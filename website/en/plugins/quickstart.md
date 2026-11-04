# Quickstart

Choose the process where the plugin runs. Use Node `>=24.9.0`, the repository's
pinned pnpm, and Harness `0.2.2-alpha.3`; match Cordis peers to the selected
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

Mount it with ordinary `ctx.plugin(entry)` in the Remote composition of a
dedicated worktree. Build and launch that worktree's Host and TUI:

```sh
PROFILE=mayfly-build-health script/install-dev.sh
dsh --profile mayfly-build-health
MAYFLY_DSH_STARTUP_URL='<Host URL>' script/mayfly-remote.sh
```

There is currently no public external TUI plugin installer or hot-loading
entry. A Remote consumer needing Host state reads official Client facts or
focused Mayfly Host DTOs, then publishes readonly UI nodes. Rebuild after source
edits and reinstall the dedicated profile after dependency changes. Do not
use the production `mayfly` profile for acceptance.
