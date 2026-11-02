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
node script/split-parity.mjs --scenario transcript-search
node script/split-parity.mjs --scenario focus-resize
node script/split-parity.mjs --scenario editor-feedback
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

`theme-catalog` switches all 32 palettes and `auto` from the immutable rc.2
catalog through the actual `/theme` command. Each switch keeps a Unicode draft
and captures 80×24, 40×16 and 120×40 frames, for 99 checkpoints. `questions`,
`stats` and `files` also belong to `--scenario all`: they exercise real native
question answers, usage panels, delivered previews and workspace diffs. A
reference failure remains a failed case; it does not silently remove that
workflow from the full gate.

The input cases also run in the default full gate. `transcript-search` enters
the real conversation with Alt+Up, searches in both directions, walks matches
with `n`/`N` and arrows, resizes, and returns through an overlay with its row
cursor retained. `focus-resize` preserves a selected theme and the editor caret
through 40×16, 80×24 and 120×40 layouts. `editor-feedback` checks recalled
history, an unknown slash command with and without arguments, and the empty
prompt's `?` help route. These use production input and shared components;
calling a controller directly is not a substitute for their PTY evidence.

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

The published reference and candidate run different Harness versions. Actual
native model metadata, inherited reasoning effort, and prompt/tool composition
can therefore differ before rendering. See
[split-native-data-differences.md](./split-native-data-differences.md) for the
captured request/projection evidence and the distinction between upstream
data changes and split adaptation defects. A raw comparison retains those
differences; a controlled comparison requires equal inputs configured through
native APIs and independent reference provenance.

## Exact native-difference review

`script/split-native-review.mjs` validates a separate, explicit review decision:

```sh
node script/split-native-review.mjs \
  --review /path/to/native-differences-plan.json \
  --results /path/to/native-differences-review.json
```

The plan records the reviewer's assessment of the relation between native facts and
the changed field. It binds the original strict report, frozen reference
manifest, each differing reference/candidate grid, and every evidence file by
SHA-256. Native facts use checked JSON pointers or an exact native journal
sequence/type/payload assertion. Compressed journals require `zstd`; its CLI
reads all concatenated frames. Source assertions bind the relevant native API
and direct frontend consumer. Model reviews also require independently captured
same-facts checkpoints that pass the original strict comparison.

Each decision names an implemented rule, a concrete reason, evidence ids, and
the exact changed rows, text, style runs, surrounding text and bounded style
span. The checker accepts only the rule's named field shape. It then restores
those specifically reviewed rows in memory and strictly compares the whole
screen. Unexpected text or style rows, cursor/dimension changes, a new grid
digest, missing/tampered evidence, and nonvisual runtime failures reject the
review. A partial API rule additionally requires its explicit limitation in
the captured command UI. It cannot approve a note that exists only in docs.

The result separates `exactCheckpoints` from `reviewedDifferences`. Its status
is `strict-exact`, `reviewed-native-differences`, or `rejected`; the original
`strictStatus`, `strictParityVerified` and `strictFailures` remain visible.
The strict parity CLI and full code gate keep their original failure exit
semantics. Automated or agent review does not replace the owner's final human
acceptance. A successful review neither rewrites raw artifacts nor upgrades
native differences to exact parity. New captures need new reviewed hashes.

New candidate reports include before/after hashes of emitted runtime JavaScript
and persisted native journal/projection files. The observed source checkout
HEAD is explicitly labelled as an observation, without inferring a build
commit. Reference captures retain a separate `native-evidence-<run-id>.json`
linkage file; the immutable reference manifest and screen bytes remain intact.

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
