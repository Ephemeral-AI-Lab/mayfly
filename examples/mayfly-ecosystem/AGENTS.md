# `@mayfly-example/ecosystem`

Composition-only bundle: `cordis.patch.yml` mounts header, right-inspector,
bottom-log, overlay, and ui-gallery as ordinary siblings. The user kit is a
dependency, not a row; the runtime entry adds no contributions.

Composition tests must install publish-shaped packages, boot every row, observe
direct UI contributions, and prove Fiber unload cleanup.
