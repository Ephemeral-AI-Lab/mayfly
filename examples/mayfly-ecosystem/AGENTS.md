# `@mayfly-example/ecosystem`

Composition-only opt-in bundle for five runnable external plugins: header,
right-inspector, bottom-log, overlay, and ui-gallery. The user kit is a
dependency, not a row.

Rows are ordinary Cordis siblings of Mayfly. They inject native dsh services and
direct Mayfly UI services exactly as their source declares. Keep this package
outside Mayfly's release set and default bundle.

Tests must install publish-shaped packages, boot all five rows, observe their
direct contributions, and prove Fiber unload cleanup. Do not add manifests,
capability maps, host facades, provider examples, or compatibility paths.
