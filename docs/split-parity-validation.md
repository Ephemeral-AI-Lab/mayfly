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
the selected artifacts directory, starts the real dsh web Host on a random
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

## Shared semantic cases and split lifecycle

```sh
node script/split-parity.mjs --scenario all
node script/split-parity.mjs --scenario presentation
node script/split-parity.mjs --scenario tools
node script/split-parity.mjs --scenario approval
node script/split-parity.mjs --scenario network --smoke-only
node script/split-parity.mjs --scenario startup
node script/split-parity.mjs --scenario model-shortcut
node script/split-parity.mjs --scenario panels
```

`smoke` covers startup, help, Unicode draft, an actual model turn and `/new`.
`presentation` switches themes through the picker, keeps a Unicode draft, resizes
to 40×16 and 120×40, and restores the original theme. `tools` drives a native
`parity_probe` call through the actual model/tool loop. `approval` asks the native
approval service, rejects one call, withdraws another pending call through its
real abort signal, then uses Ctrl+C to abort a running native tool. The pending
request signal has a fixture-owned five-second deadline. This distinguishes
native cancellation from card dismissal: rc.2 treats Ctrl+C while the card is
open as rejection. A fixture audit independently verifies execution count and
native approval outcomes.
The fixture is an ordinary Cordis plugin in the isolated test composition; it
does not inject Remote projections or fabricated session events.

`network` routes the actual Host HTTP/WebSocket connection through a loopback
forwarder, destroys active sockets while a native tool is executing, then
restores forwarding. It checks recovery and a single tool completion while the
Host stays alive. This case has no in-process rc.2 equivalent and always reports
`parityVerified: false`. All shared semantic cases capture the published reference
and candidate independently. Passing a native audit alone does not pass a visual
comparison.

`startup` configures the native `startup: splash` preference on both products,
captures the empty splash, creates a real Session, returns with `/new`, browses
its recent row, and resumes it with the keyboard. `model-shortcut` captures
Alt+M cycling the provider's models with an empty prompt and a Unicode draft,
then clears the draft. `panels` creates one real Session and opens `/context`,
`/version`, `/skills`, `/provider`, `/settings`, `/sessions`, `/preset`,
`/permissions`, `/model`, and `/effort`. These three cases acquire eighteen
additional checkpoints in separate reference directories; they do not replace
the initial eighteen. The panel checkpoints prove their initial presentation,
not every write or secondary page available from each command.

Each additional case uses its own published-reference profile home. Native
model/default-setting writes can persist outside the per-run Session storage,
so sharing a profile would let one command change the next case's baseline.
The native startup preference and profile identity are recorded in reference
provenance. Comparing a different startup preference fails before reading grids.

Use `--root /path/to/candidate` to run against another built worktree. Driver and
fixture files come from the verifier's own tree; the Host/Remote runtime comes
from the specified candidate. `--artifacts <dir>` selects a separate evidence
directory and `--results <file>` writes the aggregate report for the gate.

The full code gate keeps one Vitest coverage pass, including deterministic
renderer work budgets, then runs the real split cases. Round acceptance uses
Host/Remote smoke; selected PR runtime acceptance uses the full split case set.
It no longer launches the old in-process scenario, smoke or PTY performance
commands against the newer Harness. Reference differences are reported with
split rerun commands and cannot be resolved by accepting candidate goldens.

Missing checkpoints, tampered reference bytes, changed dimensions, text,
styles, colors and cursor all fail. Only UUID and command-token fields are
normalized. Paths, timing fields and Host endpoint labels need an explicitly
reviewed fixture or field normalization; broad whitespace/color masking is
not allowed.

## Remaining acceptance coverage

The initial split backend is infrastructure, not a completed parity claim.
The rc.2 catalog includes startup/sessionless flows, all themes, narrow/short
terminals, mouse interaction, streaming, approvals, tools and side views.
Cases above cover part of that matrix. All other checkpoints must be driven
through the real Host and added before completion. Animation needs fixed-clock
intermediate frames and real-time PTY review. In-flight detach, same-SessionId
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
