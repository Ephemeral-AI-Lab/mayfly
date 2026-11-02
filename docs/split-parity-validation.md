# Split TUI parity verification

The reference is the published `@ephemeral-ai/mayfly@0.1.4-rc.2`, with source
tag `v0.1.4-rc.2` at `f148e7045cc22a66e62c0cd5203f8eeca1368081` and npm integrity
`sha512-KsNwfM4EN2rizHkPKVoHUXrRH2+WppR7zor6VnEhAJrO11AY6h/02tt5I0BOX04r8+CUfbqTvh5zmLoXl9kj8w==`.

`script/scenarios/split-reference.mjs` verifies the tarball bytes and refuses
comparison against a different reference identity. Candidate captures never
write or update reference grids.

## Run a real integration smoke

Build first, then use an already installed dsh matching the Host package:

```sh
pnpm run build
DSH_BIN=/path/to/matching/dsh node script/split-parity.mjs --smoke-only
```

The command creates a dedicated `mayfly-split-test` profile inside
`.artifacts/split-parity/homes/`, starts the real dsh web Host on a random
loopback port, and launches the built Remote as a separate Node process under
a PTY. It never installs dsh globally or modifies an ordinary user profile.
Optional dependency builds remain denied. It uses the existing deterministic
model endpoint, not a paid provider. Host and Remote credentials stay in child
environments and are redacted from saved logs.

The initial semantic scenario checks startup, help, Unicode editor input, a
complete real model turn, `/new`, clean TUI exit, terminal-mode restoration,
and that detaching the TUI leaves the Host running. Each checkpoint saves a
text/style/cursor grid, with PTY and Host logs and a JSON report. A smoke run
always reports `parityVerified: false`: these are integration results, not a
claim of rc.2 equivalence.

## Capture and compare the published reference automatically

```sh
node script/split-parity.mjs
```

The default command downloads the published reference tarball, verifies its
frozen npm integrity, installs its own artifact-local dsh `0.2.1-rc.2` and the
published optional peer closure, and drives the same semantic steps through the
actual rc.2 TUI. Its package files are never replaced with candidate sources.
It then runs the split candidate and compares every checkpoint. Reference
package and profile lockfile hashes and the step definition hash are recorded.
Subsequent reference captures must reproduce the existing frames and provenance;
changes are refused, not accepted by rewriting an expected grid. Use
`--capture-reference` to run only this reference capture.

The initial acquisition needs registry access. Installs are confined to
`.artifacts/split-parity/published-reference/`, with dependency build scripts
disabled. The optional peers use the exact pins declared by the published
package; they are needed for a complete reference composition. This graph is
kept separate from the candidate's newer Harness graph.

A pre-existing independently frozen capture can also be used:

```sh
node script/split-parity.mjs --reference /path/to/frozen-rc2 --cols 80 --rows 24
```

The reference directory contains `reference.json` with the four reference
identity fields exported as `SPLIT_REFERENCE` and a `checkpoints` map of grid
filenames to SHA-256 digests. For example, `startup-80x24.grid` records the
reference product at the `startup` checkpoint. Generate these frames by driving
the **published reference runtime** through the same `SPLIT_SMOKE_STEPS`, with
the same fixture, theme, locale, clock, workspace display and terminal size.
The split runner intentionally provides no `--update` or candidate-to-reference
copying path. Existing scenario grids can be reused only where the semantic
checkpoint and environment actually match.

Missing checkpoints, tampered reference bytes, changed dimensions, text,
styles, colors and cursor all fail. Only UUID and command-token fields are
normalized. Paths, timing fields and Host endpoint labels need an explicitly
reviewed fixture or field normalization; broad whitespace/color masking is
not allowed.

## Remaining acceptance coverage

The initial split backend is infrastructure, not a completed parity claim.
The rc.2 catalog includes startup/sessionless flows, all themes, narrow/short
terminals, mouse interaction, streaming, approvals, tools and side views.
Those checkpoints must be driven through the real Host and added to the
independent matrix before completion. Animation needs fixed-clock intermediate
frames and real-time PTY review. Reconnect, in-flight detach, same-SessionId
multi-Host isolation and stale replies require additional protocol scenarios.

Commands must retain rc.2 canonical names: `/model`, `/provider`, `/preset`
and `/plugin` are singular. The split branch's plural local names do not by
themselves satisfy these contracts. Inventory must include native Host
commands and aliases, not only frontend command registrations. An untested
command remains unverified even if its handler exists.

`node script/split-parity.mjs --inventory` prints the frozen source registrations,
aliases and source locations. Its `candidateNameMentioned` field is only a
routing hint, not a test result; every entry starts as `unverified`. The static
inventory explicitly excludes the additional native Harness command catalog
and dynamic external extensions, which must be captured in a live composition.

Each partial command must name the missing official API, the delivered behavior,
the unavailable behavior, a user-visible explanation and a regression test.
Plugin writes and raw settings editing have APIs and cannot be excused as API
limitations. Full MCP transport health enumeration and live-Agent-only cold
child presenters have genuine upstream constraints; passive cold history does
not.
