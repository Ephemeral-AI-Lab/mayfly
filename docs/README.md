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
and interaction design and migration plans live in [design/](./design/); these
files only describe their point in time and do not define the current API.

See [platform-acceptance.md](./platform-acceptance.md) for the cross-platform
automation and desktop acceptance checklist.

The historical design rationale for the interaction architecture is in the
[UI/UX unified model design](./design/ui-ux-unification.md): a consistency
review of notifications, forms, lists, tabs, input routing, and hints, the
target state model, and migration acceptance. The current candidate
implementation is defined by the architecture documents, public types, and
tests.

The corresponding [interaction refactor implementation plan](./design/ui-ux-implementation.md)
lists the code scope and gates for protocol hardening, paired-editable pilots,
notification/authorization guidance, batched migration, and release acceptance.

[The detailed PR #15 implementation plan](./design/pr15-interaction-refactor-plan.md)
records the baseline problems, model types, consumer wiring, concurrent
write-back, interaction logic, and the OAuth lifecycle as the design record for
this candidate implementation.

The latest status of the candidate worktree is in the
[interaction refactor resume plan and current audit](./design/ui-interaction-resume-plan.md),
including completion evidence, remaining release gates, and the manual
acceptance order; it does not represent released runtime behavior.

The concrete execution order is in
[full interaction-model migration: the 20-step plan](./design/ui-interaction-migration-steps.md),
with each step's scope, verification, and completion conditions, plus the
acceptance boundaries for all consumers and the final profile.

[The 20-step completion audit](./design/ui-interaction-completion-audit.md)
lists authoritative evidence and verdicts item by item; Steps 1–20 are complete
and merged into main.

Plugin authors should start from the Website
[developer manual](../website/plugins/index.md) and use the
[DeepSeek Harness reference](https://deepseek-harness.github.io/deepseek-harness/reference/)
as the authority on native dsh services. Repository maintenance rules live in
the root [AGENTS.md](../AGENTS.md) and each package's `AGENTS.md`.
