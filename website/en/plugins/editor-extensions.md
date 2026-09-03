# Editor extensions

`mayflyEditorExtensions` adds passive UI, diagnostics, actions, completion, and
submit transforms around the one Mayfly-owned editor. It does not replace the
editor engine.

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@ephemeral-ai/mayfly-ui'
import { ui } from '@ephemeral-ai/mayfly-ui'

export const inject = ['mayflyEditorExtensions']

export function apply(ctx: Context): void {
  ctx.mayflyEditorExtensions.register({
    id: 'acme.issue-links',
    priority: 20,
    complete: request => request.trigger === '#'
      ? [{ id: 'issue-123', label: '#123', insertText: '#123' }]
      : [],
    transformSubmit: request => ({ text: request.text.trim() }),
  }, {
    hint: '#123 links an issue',
    before: ui.text('Issue helper', { tone: 'muted' }),
  })
}
```

Callback context carries an AbortSignal, surface id, and revision.
Completions are bounded to 5 seconds and submit transforms to 30 seconds.
Late results after unload, generation change, or abort are discarded.

Extension nodes are a restricted tree without editor-control. Render, event,
diagnostic, and action content is admitted again. Registrations expose
`set(decoration)/dispose()` and follow the Fiber.
