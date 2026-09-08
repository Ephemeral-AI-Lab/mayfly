# External consumer examples

These packages are opt-in, publish-shaped consumers, outside the release set
and default Mayfly bundle. Read the individual package's `AGENTS.md` for its
contribution contract. Package membership comes from
[`script/package-contract.mjs`](../script/package-contract.mjs).

Use published package imports, native dsh services, and direct Mayfly UI
services; never import runtime internals or add a provider/host facade. Core
owns layout, rendering, focus, width, and narrow-layout fallback. Plugins own
Fiber registrations; the shared user kit is pure wire construction.

Preserve build, coverage, pack, and independent-install validation through
`pnpm run check:examples`. The ecosystem test boots publish-shaped packages,
observes their contributions, and proves Fiber cleanup. Public wire/rendering
changes also need user-kit width coverage and root acceptance requirements.
