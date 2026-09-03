# Mayfly plugin development

A Mayfly plugin is an ordinary Cordis plugin. It consumes native dsh services
directly and injects one of Mayfly's four UI services only when it needs terminal
UI.

```text
native dsh services
commands · sessionProjections · tools · settings · ...
                         │
                ordinary Cordis plugin
                         │
Mayfly UI services
mayflyPanes · mayflyStatus · mayflyOverlays · mayflyEditorExtensions
```

Official Mayfly packages and external plugins are structurally identical:
`name / inject / apply(ctx)`, one service graph, and the same Fiber unload
behavior. There is no special manifest, capability request, adapter facade, or
plugin-author CLI.

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@ephemeral-ai/mayfly-ui'
import { ui } from '@ephemeral-ai/mayfly-ui'

export const name = '@acme/build-health'
export const inject = ['commands', 'mayflyPanes']

export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'health',
    description: 'Show build health',
    handler: () => ({ kind: 'success', text: 'healthy' }),
  })
  ctx.mayflyPanes.register({
    id: 'acme.build-health',
    placement: 'right',
    narrow: 'bottom',
  }, ui.text('healthy'))
}
```

Use the [quickstart](/en/plugins/quickstart) to create a package. The
[Harness reference](https://deepseek-harness.github.io/deepseek-harness/reference/)
defines native dsh APIs; [service seams](/en/plugins/seams) covers Mayfly UI.
