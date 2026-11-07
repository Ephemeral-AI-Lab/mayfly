# External consumer examples

These packages are opt-in, publish-shaped consumers, outside the release set
and default Mayfly composition. They reach the TUI through source composition:
an entry passes their Cordis modules to `run(argv, { plugins })` from
`@ephemeral-ai/mayfly/bin`, as `mayfly-ecosystem` does; they ship no dsh
bundle. Read the individual package's `AGENTS.md` for its contribution
contract. Package membership comes from
[`script/package-contract.mjs`](../script/package-contract.mjs).

Use published package imports and the four direct Mayfly UI services; the
TUI's tree has no native dsh services. Never import runtime internals or add a
provider/host facade. Core owns layout, rendering, focus, width, and
narrow-layout fallback. Plugins own Fiber registrations; the shared user kit is
pure wire construction. Compose wire nodes with the `ui.*` builders. The
[UI design](../docs/design/component-library.md) is the target for a planned
refresh, not shipped behavior; the code is the authority for what runs today.

Preserve build, coverage, pack, and independent-install validation through
`pnpm run check:examples`. The ecosystem test boots publish-shaped packages,
observes their contributions, and proves Fiber cleanup. Public wire/rendering
changes also need user-kit width coverage and root acceptance requirements.
