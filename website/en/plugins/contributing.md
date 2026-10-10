# Contributing to Mayfly

Mayfly is a pnpm 11 workspace requiring Node
`^22.19.0 || >=24.0.0`. The release set has three packages:
`@ephemeral-ai/mayfly-ui`, `@ephemeral-ai/mayfly`, and
`@ephemeral-ai/mayfly-cli` (frontend, conversation, app, core, transcript,
and interaction are internal source areas of `mayfly`, no longer published
individually).

Read root `AGENTS.md` and the owning package's `AGENTS.md`. Develop
user-visible behavior, public seams, and Website changes in a dedicated
worktree and branch.

```sh
pnpm install
pnpm run check -- --tier round   # every edit: incremental build, lint, the tests the change reaches
pnpm run check                   # before a PR: plus the checks the change touches
pnpm run check -- --tier full    # a release or a broad change: everything
```

`--plan` lists the steps without running them; the result is in `.artifacts/verify/summary.md`.

For publish shape:

```sh
pnpm run check:lib
pnpm run check:pack
pnpm run check:examples
```

Runtime, public, and composition changes require a dedicated profile:

```sh
PROFILE=mayfly-my-change script/install-dev.sh
dsh --profile mayfly-my-change
```

Website changes require a build and LAN preview acceptance. Do not merge,
remove the profile, or stop the preview before every applicable human
acceptance completes.
