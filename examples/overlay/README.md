# Overlay example

An opt-in Mayfly plugin adding `/example-overlay` through native
`ctx.commands`. The command opens a capturing modal directly through
`ctx.mayflyOverlays` and edits the plugin-owned `mayfly-example-overlay` namespace
through native `ctx.settings`.

Connection and Workspace pages retain independent drafts. Save commits changed
paths with the native descriptor revision; background updates preserve edits and
expose conflicts. Cancel uses Mayfly's shared unsaved-change confirmation. The
plugin provides readonly snapshots and structured action replies while Mayfly
owns drafts, focus, navigation, submission locking, and the modal frame.

```sh
dsh plugin --profile mayfly-dev add @mayfly-example/overlay
```

Unloading the package removes its command, namespace, observers, and overlay with
the plugin Fiber. Stored settings are read again on the next load.
