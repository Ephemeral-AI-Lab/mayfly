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

The component design catalog is
[design/component-library.md](./design/component-library.md): wire interfaces,
ASCII state diagrams, key behavior, and composition recipes for every shared
UI component. Its §8 redesign round ships a runnable terminal prototype,
`node docs/design/prototypes/ui-preview.mjs`.

See [native-harness-adaptation.md](./native-harness-adaptation.md) for native
features and Team configuration.

See [package-release.md](./package-release.md) for release maintenance.
Historical investigation and acceptance records live in [audits/](./audits/);
dated audits only describe their point in time and do not define the current
API.

See [platform-acceptance.md](./platform-acceptance.md) for the cross-platform
automation and desktop acceptance checklist.

Plugin authors should start from the Website
[developer manual](../website/plugins/index.md) and use the
[DeepSeek Harness reference](https://deepseek-harness.github.io/deepseek-harness/reference/)
as the authority on native dsh services. Repository maintenance rules live in
the root [AGENTS.md](../AGENTS.md) and each package's `AGENTS.md`.
