# Mayfly documentation index

The current runtime is described by three architecture documents:

- [mayfly-architecture.md](./mayfly-architecture.md): package boundaries, state
  ownership, and the flat Cordis composition.
- [mayfly-seams.md](./mayfly-seams.md): usage boundaries for the native dsh
  services, the Mayfly UI services, and `mayflyCurrentAgent`.
- [interaction-model.md](./interaction-model.md): input routing, the shared key
  grammar, the Escape ladder, focus and search rules, hints, and the
  confirmation and availability contract for panes, overlays, and editor
  extensions.

The UI composition layer is [design/compose.md](./design/compose.md); the
component language and the Mayfly components are
[design/component-library.md](./design/component-library.md).

A review round runs on the workbench: `pnpm run dev` rebuilds and restarts the
profile on the same session, `pnpm run scenario` opens the product on a scripted
timeline played into the live session (no model, no tools, no quota), and
`pnpm run frame` runs a scenario against the real product and writes each
checkpoint as a cell grid, text, and SVG (with `--png`, a screenshot from
xterm.js in headless Chrome). `pnpm run scenario --list` lists the catalog.

See [native-harness-adaptation.md](./native-harness-adaptation.md) for native
features and Team configuration, [package-release.md](./package-release.md) for
release maintenance, and [platform-acceptance.md](./platform-acceptance.md) for
the cross-platform automation and desktop acceptance checklist.

Plugin authors should start from the Website
[developer manual](../website/plugins/index.md) and use the
[DeepSeek Harness reference](https://deepseek-harness.github.io/deepseek-harness/reference/)
as the authority on native dsh services. Repository maintenance rules live in
the root [AGENTS.md](../AGENTS.md) and each package's `AGENTS.md`.
