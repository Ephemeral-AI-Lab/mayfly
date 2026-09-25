# Mayfly documentation index

The current runtime has exactly two architecture documents:

- [mayfly-architecture.md](./mayfly-architecture.md): package boundaries, state
  ownership, and the flat Cordis composition.
- [mayfly-seams.md](./mayfly-seams.md): usage boundaries for the native dsh
  services, the Mayfly UI services, and `mayflyCurrentAgent`.

See [native-harness-adaptation.md](./native-harness-adaptation.md) for native
features and Team configuration.

See [package-release.md](./package-release.md) for release maintenance.
Historical investigation and acceptance records live in [audits/](./audits/),
and interaction design documents live in [design/](./design/); dated audits
only describe their point in time and do not define the current API.

See [platform-acceptance.md](./platform-acceptance.md) for the cross-platform
automation and desktop acceptance checklist.

The design rationale for the interaction architecture is in the
[UI/UX unified model design](./design/ui-ux-unification.md): a consistency
review of notifications, forms, lists, tabs, input routing, and hints, plus the
target state model. The current implementation is defined by the architecture
documents, public types, and tests.

[The detailed PR #15 implementation plan](./design/pr15-interaction-refactor-plan.md)
records the baseline problems, model types, consumer wiring, concurrent
write-back, interaction logic, and the OAuth lifecycle as the design record for
the shipped interaction model.

The follow-up [terminal UX optimization design](./design/ui-ux-optimization.md)
defines the global key grammar, control behaviors, and per-surface inventory.
Its contract increments M1–M6 are implemented; M7 (registration-time warning
for printable shortcuts on filterable surfaces) and the listed polish items
remain open.

Plugin authors should start from the Website
[developer manual](../website/plugins/index.md) and use the
[DeepSeek Harness reference](https://deepseek-harness.github.io/deepseek-harness/reference/)
as the authority on native dsh services. Repository maintenance rules live in
the root [AGENTS.md](../AGENTS.md) and each package's `AGENTS.md`.
