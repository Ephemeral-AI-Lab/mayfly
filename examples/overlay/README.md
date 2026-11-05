# Overlay example

An opt-in Mayfly plugin whose editor action (`Alt+O`, registered through
`ctx.mayflyEditorExtensions`) opens a capturing modal directly through
`ctx.mayflyOverlays`. The modal edits a two-page settings form whose values live
in the plugin Fiber.

Connection and Workspace pages retain independent drafts. Save commits the
changed fields with the snapshot revision the form was opened at; a save from a
stale form gets a conflict. Cancel uses Mayfly's shared unsaved-change
confirmation. The plugin provides readonly snapshots and structured action
replies while Mayfly owns drafts, focus, navigation, submission locking, and the
modal frame.

```ts
import { run } from '@ephemeral-ai/mayfly/bin'
import * as overlay from '@mayfly-example/overlay'

await run(process.argv.slice(2), { plugins: [overlay] })
```

Unloading the plugin removes its editor action and overlay with the Fiber, and
the next load starts again from the defaults.
