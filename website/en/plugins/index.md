# Mayfly plugin development

Mayfly has two independent Cordis trees: the native dsh Host and the TUI.
Plugins remain ordinary `name / inject / apply(ctx)` entries; their dependencies
must exist in the process where they run.

| Location | Services | Installation and execution |
| --- | --- | --- |
| Host | Native commands, sessionProjections, tools, settings, and other services | Native Host bundles and plugin manager |
| TUI | Official Client, frontend state, and four Mayfly UI services | Source composition through `run(argv, { plugins })` from `@ephemeral-ai/mayfly/bin`, a build, and a TUI restart |

TUI features read Host data through official Client calls and serializable
DTOs. Agent, Session, Tool Definition, callback, and renderer objects do not cross
processes. Mayfly Host supplies additional transport capabilities through public
native APIs; this project does not modify dsh upstream to provide them.

A static UI plugin for a TUI source composition looks like this:

```ts
import type { Context } from '@deepseek-ai/cordis'
import { ui } from '@ephemeral-ai/mayfly-ui'

export const name = '@acme/build-health'
export const inject = ['mayflyPanes']

export function apply(ctx: Context): void {
  ctx.mayflyPanes.register({
    id: 'acme.build-health',
    placement: 'right',
    narrow: 'bottom',
  }, ui.text('healthy'))
}
```

Installing a Host plugin does not mount a TUI contribution. `@ephemeral-ai/mayfly`
is the TUI itself; it publishes no Host plugin, Host patch, or preset.

Use the [quickstart](/en/plugins/quickstart) for the Host or TUI integration path.
The [Harness reference](https://deepseek-harness.github.io/deepseek-harness/reference/)
defines native APIs; [service seams](/en/plugins/seams) covers Mayfly UI.
