# `@mayfly-example/ecosystem`

TUI source composition: `plugins` lists header, right-inspector, bottom-log,
overlay, and ui-gallery in load order, and `start(argv)` hands them to
`run(argv, { plugins })` from `@ephemeral-ai/mayfly/bin`. The user kit is a
dependency of the plugins, not a plugin; the package adds no contributions of
its own.

Composition tests must install publish-shaped packages, load every plugin,
observe direct UI contributions, and prove Fiber unload cleanup.
