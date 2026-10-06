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

The UI design is [design/component-library.md](./design/component-library.md): the
target visual language, key grammar, basic components (the UI API), and the Mayfly
components built from them, reviewed before the implementation. It is a design, not
shipped behavior, and ships a runnable terminal prototype
(`node docs/design/prototypes/ui-preview.mjs`) whose `--audit` mode proves that every
Mayfly component uses only the basic components a plugin also has. The implementation material
for the follow-up change (wire mechanics, builder tables, backlog) is in
[design/component-library-reference.md](./design/component-library-reference.md), and the
order of that work, with the decisions taken after review, is
[design/implementation-roadmap.md](./design/implementation-roadmap.md).
The prototype's frames are committed as goldens (`pnpm run design:golden`, checked by
`pnpm run design:golden:check`); they are what the real renderer is compared with.

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
