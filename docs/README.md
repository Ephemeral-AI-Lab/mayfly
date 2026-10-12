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
components built from them, reviewed before the implementation. It is the starting
sketch, not shipped behavior: each Mayfly component is finalized with the owner in the
running terminal, and a finalized section describes the accepted behavior. It ships a
runnable terminal prototype
(`node docs/design/prototypes/ui-preview.mjs`) whose `--audit` mode proves that every
Mayfly component uses only the basic components a plugin also has. The implementation material
for the follow-up change (wire mechanics, builder tables, backlog) is in
[design/component-library-reference.md](./design/component-library-reference.md), and the
order of that work, with the decisions taken after review, is
[design/implementation-roadmap.md](./design/implementation-roadmap.md).
The prototype's frames were the strict oracle of the foundation phase. Roadmap Phase 2b
retired them from the gate: the design scenes now compare the real renderer with its own
frames, committed as cell grids, until the accepted frames of the foundation review
replace them.

Components are developed part by part under
[design/component-development-spec.md](./design/component-development-spec.md): each part has a scenario demo, a
brief of what it implements and what to judge, and a question round with the owner in the terminal.

A review round runs on the workbench: `pnpm run dev` rebuilds and restarts the
profile on the same session, `pnpm run scenario` opens the product on a scripted
timeline played into the live session (no model, no tools, no quota), `pnpm run frame` runs a scenario against the real product and writes each checkpoint as a cell grid, text, SVG, and (with `--png`) a screenshot from xterm.js in headless Chrome, and the
prototype runs beside it as `node docs/design/prototypes/ui-preview.mjs <scene>`
(see the root `AGENTS.md`).

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
