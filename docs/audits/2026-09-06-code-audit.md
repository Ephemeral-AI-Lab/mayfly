# Mayfly code audit report

Audit baseline: `f9e41c4428ce3c1a49e2712ba19bf5935cef7ab1`. Report date:
2026-09-06. This report is an audit record of that commit; it does not define
the current API and does not indicate fixes were implemented.

## Conclusion

Mayfly's main problem is not a lack of architectural constraints but that some
constraints do not carry through complete workflows. Core already unifies
terminal width, theme, and UI compilation; contribution services, session
generations, and fixed screen slots also have a decent test base. But there are
still reproducible inconsistencies between the launcher and in-app commands,
between snapshot and registration lifecycles, and between text editing and
entity operations.

Fix two P1s first: in-app plugin operations/updates do not use the bundled
Harness delivered by the launcher; and registry publish/cleanup still
references the caller-mutable `definition.id`. Then work through search input,
Delete semantics, narrow-screen forms, Windows paths, and clipboard timeouts.
Performance work should cover the whole path from producer to terminal —
optimizing only visible-row painting cannot address the event-loop cost of
large lists and long sessions.

This record lists 13 code problems/technical-debt items and 2
reliability/verification risks. Severity indicates the order of work, not a
security rating: P1 is an important workflow or lifecycle correctness problem;
P2 is a condition-triggered functional defect or scale bottleneck; P3 is a
lower-priority cost or consistency issue. No P0 was identified, and the absence
of other severe problems is not claimed.

## Scope and evidence

- Read the maintenance boundaries of the root and the ui, mayfly, and cli
  packages plus the current architecture documents; did a directory-level scan
  of the three packages, tests, build/release scripts, and CI, and deep-read
  the call chains this report touches. Not every source line was read, and
  historical documents were not treated as behavioral evidence.
- Key paths: CLI startup and the bundled runtime, in-app plugin/update, the
  four UI registries, UI builder/validator/compiler, surfaces, terminal
  layout, transcript projection/cache, form/select/panel, file completion,
  clipboard, external editor, locale.
- Ran `pnpm exec vitest run` on Linux, Node v24.15.0, pnpm 11.7.0: **174 test
  files passed, 1 skipped; 2888 tests passed, 6 skipped; 21.85 s**.
- Ran source-level minimal reproductions separately using Node's
  `--experimental-transform-types`; forms and selectors used the repository's
  existing headless test doubles. Performance data are microbenchmarks with
  synthetic input on this machine — not FPS, P95, or cross-machine numbers for
  real user sessions.
- This round did not rebuild the whole workspace and did not run the
  coverage/full gate, release-package acceptance, real model requests, or a
  real Windows/macOS TUI. The existing workspace `lib/` participates in
  package-name dependency resolution; passing tests are no substitute for a
  fresh build and three-platform acceptance.
- No runtime code was modified, no profile installed, no dependency updated,
  nothing published.

## Findings list

| # | Priority | Finding | Evidence type |
| --- | --- | --- | --- |
| A01 | P1 | In-app plugin/update ignores the bundled dsh path, and discovery depends on a POSIX shell | Call chain confirmed |
| A02 | P1 | Mutating `definition.id` after registration leaves stale contributions and wrong registry keys | Source-level minimal reproduction |
| A03 | P2 | Text-copy timeout is not guaranteed to terminate, inconsistent with image paste's timeout policy | Source and subprocess-mechanism reproduction |
| A04 | P2 | File completion and cwd display have wrong Windows path assumptions | Source and win32 path-computation reproduction |
| A05 | P2 | Both list-search implementations reject multi-character input | Headless reproduction |
| A06 | P2 | Delete while editing a form field is intercepted by the entity-delete action | Headless reproduction plus real-caller confirmation |
| A07 | P2 | A narrow screen / long label can clip the field value entirely | Headless reproduction |
| A08 | P2 | The provider and other workflows are not fully wired into the existing locale mechanism | Call chain confirmed |
| A09 | P2 | Large lists are still synchronously deep-cloned and frozen before the provider | Source and microbenchmark |
| A10 | P2 | Streaming transcript updates still run full scans/validation proportional to history size | Source and microbenchmark |
| A11 | P3 | Markdown still re-segments the full text before the cache can hit | Call order confirmed |
| A12 | P3 | freezeWire preserves getters, so a frozen result is not necessarily a stable data snapshot | Source-level minimal reproduction |
| A13 | P3 | Several duplicated input, path, process, and profile logics have already drifted behaviorally | Implementation comparison |
| A14 | P2 | The three-platform release matrix does not cover the real three-platform TUI workflow | CI verification gap |
| A15 | P3 | A runtime cache hit validates only the manifest, not entry/platform integrity | Conditional reliability risk |

## P1: fix first

### A01 In-app commands do not use the Harness delivered by the launcher

Location: [CLI main.ts](../../packages/cli/src/main.ts#L86),
[updater/profile.ts](../../packages/mayfly/src/interaction/updater/profile.ts#L74),
[plugin-commands.ts](../../packages/mayfly/src/interaction/plugin-commands.ts#L168),
[update-command.ts](../../packages/mayfly/src/interaction/update-command.ts#L359).

The launcher passes the bundled entry into the child process via
`MAYFLY_DSH_BIN: host.binJs`. In-app `findDshBin()` only checks `DSH_BIN`,
otherwise it runs `sh -c 'command -v dsh'`; a source search found no in-app
consumer of `MAYFLY_DSH_BIN`.

Triggers and impact:

- Only `@ephemeral-ai/mayfly-cli` installed, no global dsh: Mayfly starts, but
  plugin install/uninstall or update paths report dsh not found.
- Another global dsh version exists: in-app operations pick the global version
  and lose the launcher's pinned-Harness guarantee.
- Native Windows has no `sh`: discovery fails outright. Installing Git Bash is
  not a prerequisite this workflow should implicitly require.

There is also a next layer of Windows problems:
[updater/io.ts](../../packages/mayfly/src/interaction/updater/io.ts#L73) uses
`spawn` without a shell;
[registry.ts](../../packages/mayfly/src/interaction/updater/registry.ts#L122)
launches `npm` directly. For the common npm.cmd installation this execution
path lacks the ComSpec/PATHEXT handling the launcher already has, and may fall
back to the public registry and lose the npmrc mirror configuration.

Recommendation: centralize "executable + fixed leading arguments" resolution
inside the runtime. A bundled JS entry should be launched through
`process.execPath`; do not merely add the env name to the lookup and then keep
treating `.js` as a platform executable. Add end-to-end tests for the
no-global-dsh, different-global-version, Windows npm.cmd, and
path-with-spaces cases.

### A02 The registry does not truly isolate the caller's definition

Location: [services.ts](../../packages/ui/src/services.ts#L192). The same
closure pattern exists in the pane, status, overlay, and editor-extension
registries.

Although `admittedDefinition = freezeWire(definition)` is stored, later
publish/remove still reads `definition.id` on the original object.
TypeScript's readonly interface does not stop a caller from keeping the
original mutable object, and JS consumers are not bound by types at all.

Actual reproduction: register `audit.a`, change the original definition.id to
`audit.b`, then set and dispose:

```text
after set     [ [ 'audit.a', 'audit.a' ], [ 'audit.b', 'audit.a' ] ]
after dispose [ 'audit.a' ]
```

The two array columns are entry.id and entry.definition.id. The result both
creates identity inconsistency and leaves a stale contribution after dispose.
If changed to another existing id, it can even write a registry entry that does
not belong to this handle.

Recommendation: every subsequent map operation, event, and cleanup captures
the admitted stable id; fix all four services together. Add regression cases
for "mutate the original object then set/dispose" and "change to an existing
id", verifying nothing survives Fiber unload.

## UI/UX and functional consistency

### A05 List search cannot handle multi-character input

Location:
[select-list.ts](https://github.com/Ephemeral-AI-Lab/mayfly/blob/f9e41c4428ce3c1a49e2712ba19bf5935cef7ab1/packages/mayfly/src/interaction/select-list.ts#L170),
[frontend-panel.ts](https://github.com/Ephemeral-AI-Lab/mayfly/blob/f9e41c4428ce3c1a49e2712ba19bf5935cef7ab1/packages/mayfly/src/interaction/frontend-panel.ts#L158).

Both decide printable text with `data.length === 1 && data >= ' '`. As a
result, a single event carrying `ab`, `中文`, or an emoji of UTF-16 length 2
does not update the search term. Single-character Chinese does not necessarily
fail; the problem is the length assumption on input events, not Chinese
itself.

Headless results: `ab -> null`, `中文 -> null`, `😀 -> null`, `a -> a`, where
null means no filter. Whether IME sequential commits, paste, or merged
terminal input form such events needs real-terminal testing; that the
controller itself rejects these inputs is already confirmed.

Recommendation: reuse core's text-input/paste semantics — distinguish
printable text, control sequences, and bracketed paste inside core — and have
both list controllers share the same search-input logic. Do not simply accept
every multi-character string, or escape sequences become search terms.

### A06 Delete still triggers entity deletion while a field is being edited

Location:
[form-panel.ts](https://github.com/Ephemeral-AI-Lab/mayfly/blob/f9e41c4428ce3c1a49e2712ba19bf5935cef7ab1/packages/mayfly/src/interaction/form-panel.ts#L123),
[keys.ts](../../packages/mayfly/src/interaction/keys.ts#L133),
[provider-add.ts](../../packages/mayfly/src/interaction/provider-add.ts#L486).

`ACTION_DELETE` binds both Delete and Ctrl-D. The form calls `onDelete`
directly before forwarding to the text editor, without checking whether a
field is currently being edited. The provider edit form happens to register
this callback.

Headless reproduction: enter field editing, send Delete, and the entity-delete
callback is invoked. The real provider path then enters a second confirmation,
so this is not "Delete immediately deletes credentials"; the actual problem is
that normal character editing is interrupted and the current edit step ends
early.

Recommendation: while in text-editing state, give Delete/Ctrl-D to the editor;
entity deletion should use an explicit separate action or only take effect in
the browse state. Hints must also follow the current state. Regression tests
must assert the character change at the cursor and that the entity-delete
callback did not run.

### A07 Not overflowing the width is not the same as being usable narrow

Location:
[ui-compiler.ts](../../packages/mayfly/src/core/ui-compiler.ts#L435).

Field painting first computes the full label width, sets the value's minimum
available width to 1, then truncates "full label + value" as a whole. When the
label already fills `available`, the value's column still sits outside the
clipped region, and subsequent-line indent also consumes the full width.

In a 20-column form, the label `A very long field name` makes the initial
value `VISIBLE_VALUE` completely invisible. Real fields with long hints also
trigger this — it is not limited to extreme labels. The existing width scan
guarantees the terminal is not overflown but cannot detect this usability
defect.

Recommendation: when width is insufficient, switch to a two-line label/value
layout, or reserve a minimum width for the edit region and truncate the label;
while focused, the value and cursor must be visible. Tests should check
content presence, cursor visibility, and editability across 20/40/80 columns
and Chinese/English labels.

### A08 Locale integration has workflow gaps

Location:
[provider-add.ts](../../packages/mayfly/src/interaction/provider-add.ts#L155),
[provider-add.ts](../../packages/mayfly/src/interaction/provider-add.ts#L486),
[form-panel.ts](https://github.com/Ephemeral-AI-Lab/mayfly/blob/f9e41c4428ce3c1a49e2712ba19bf5935cef7ab1/packages/mayfly/src/interaction/form-panel.ts#L135).

The shared form/select controllers already take a `t` parameter, but the
provider's fillForm and edit-form construction do not pass a translator;
dynamic `Configure ${route}` strings, field hints, errors, and the delete
confirmation also keep hardcoded English. Meanwhile the settings/plugin pages
already use locale.

Impact: after choosing Chinese, adjacent configuration workflows show titles,
descriptions, and error feedback in different languages. Adding dictionary
entries alone cannot fix call paths that never wire in a translator; dynamic
string concatenation should also move to placeholders.

Recommendation: audit locale by complete workflow rather than only testing
dictionary registration. Prioritize provider onboarding/edit/delete, plugin
operation failures, and update failures; keep allowing paths, model names,
and third-party raw diagnostics to remain untranslated.

## Cross-platform and process behavior

### A03 Text copy has no hard timeout guarantee

Location:
[clipboard-write.ts](../../packages/mayfly/src/interaction/clipboard-write.ts#L50),
[clipboard-probe.ts](../../packages/mayfly/src/interaction/clipboard-probe.ts#L76).

Text copy uses `spawn(..., { timeout: 3000 })` without a `killSignal` and
without a separate timeout settle; it finishes only after `close`. Node sends
SIGTERM by default, and a helper that ignores or blocks in SIGTERM handling can
hold `close` forever.

The image-paste shared runner already uses SIGKILL explicitly, and a comment
even records wl-clipboard's TERM problem under an abnormal compositor. So this
is not a theoretical style difference — existing experience simply did not
cover the sibling path.

Starting a controlled Node helper that ignores SIGTERM with the same spawn
options: still alive past 3 s, then terminated by an explicit SIGKILL from the
audit program at 3.5 s. This round did not manufacture a failure on a real
Wayland compositor.

Impact: `/copy` can wait on the native tool indefinitely, and fallback results
from other tools and OSC52 cannot complete on time. Recommendation: unify a
process primitive with a hard deadline, output cap, and stdin-close error
handling; keep the normal exit behavior of real helpers.

### A04 Windows file-path semantics are not carried through

Location:
[file-mention.ts](../../packages/mayfly/src/interaction/file-mention.ts#L140),
[file-mention.ts](../../packages/mayfly/src/interaction/file-mention.ts#L258),
[file-mention.ts](../../packages/mayfly/src/interaction/file-mention.ts#L287),
[status-cwd.ts](../../packages/mayfly/src/transcript/status-cwd.ts#L34).

Confirmed concrete problems:

- Directory listing judges absolute paths only via `startsWith('/')`.
  `C:/Users/demo/` is treated as relative, and under the current branch
  `path.win32.join('C:/repo', base)` yields `C:\repo\C:\Users\demo\`.
- Scanning uses the platform `join` producing backslash paths, while the
  scoring depth uses `split('/')`; the depth of `src\core\index.ts` computes as
  0, and `src/core` does not match that candidate either.
- The mention tail only looks for `/` and cannot consistently handle a
  backslash directory typed by a Windows user.
- The footer cwd's home abbreviation and segmentation likewise only recognize
  `/`; a deep native Windows path cannot be abbreviated as designed, losing key
  information earlier on narrow screens.

Recommendation: distinguish filesystem absolute paths from UI display paths
and normalize at the internal boundary; use the platform path API to judge
drive/UNC/absolute. Add tests covering drive letters, UNC, backslashes, forward
slashes, spaces, Chinese characters, and missing fds. The path.win32
reproduction on Linux proves the algorithm is wrong — it does not count as
completed real-Windows acceptance.

## TUI performance

### A09 List windowing does not cover snapshot production and publishing

Location: [builders.ts](../../packages/ui/src/builders.ts#L55),
[services.ts](../../packages/ui/src/services.ts#L172),
[ui-compiler.spec.ts](../../packages/mayfly/tests/core/ui-compiler.spec.ts#L1874).

`freezeWire` recursively clones then deepFreezes every time; the builder runs
it once when constructing the list and `registry.set` runs it again, even when
the object is already a frozen value made by the builder. Core's visible-item
admission can be viewport-bounded, but the work above always runs on the full
data.

Measured single freezeWire on a simple list, this machine:

| Items | Sync time |
| --- | --- |
| 1,000 | ~4 ms |
| 10,000 | ~15 ms |
| 100,000 | ~166 ms |

These are single microbenchmarks with JIT/GC and machine noise; the full
builder + provider + compiler duration is not included. The existing
100,000-item test hands the raw list straight to the compiler and does not
measure the public builder/provider path.

Recommendation: without weakening caller isolation, use internal trusted
identity/structural sharing for data produced by the library itself and
verified immutable, avoiding repeated copies; do not treat every
`Object.isFrozen` object as a safe snapshot. Build an end-to-end large-list
benchmark from register/set to input responsiveness, measuring first publish,
small updates, and scrolling separately.

### A10 Streaming updates still carry a cost that grows with history length

Location:
[projection.ts](../../packages/mayfly/src/conversation/projection.ts#L145),
[official-model.ts](../../packages/mayfly/src/transcript/official-model.ts#L288),
[official-model.ts](../../packages/mayfly/src/transcript/official-model.ts#L370).

Updating a live entry uses findIndex plus array copies; the source's onChanged
runs Zod safeParse over the complete projection; incrementalStreamingModel
then flatMaps all entries to determine what changed. The 200-entry render
window comes after these steps and cannot bound the earlier cost. The parsed
`parsed.data` from Zod validation is not yet reused as model input.

Seven warmed-up measurements on simple assistant entries give safeParse
medians of roughly: 1,000 items 0.48 ms, 10,000 items 4.04 ms, 100,000 items
31.58 ms. Tool-result recursive JSON data is more complex; its impact was not
quantified here, and real token frequency was not measured.

Recommendation: keep the Harness projection as the single source of state and
bound revalidation using stable entry identity, updatedSeq, or existing
incremental facts; do not fold session events in the renderer again for
performance. Add a benchmark over history size × delta frequency and observe
event-loop delay, allocation volume, and final content consistency.

### A11 Markdown still full-scans before the cache can hit

Location:
[components.ts](../../packages/mayfly/src/core/components.ts#L582).

The Markdown adapter's render first runs splitRichDocument, then decides
whether it contains Mermaid, and only then checks the Mermaid render cache.
Documents without Mermaid are also rescanned every time, and repainting
identical Mermaid-containing text pays the segmentation cost first too.

Recommendation: invalidate the segmentation cache at setText and let render
reuse the segmented result directly; move the text-revision/width cache check
earlier. The transcript's outer entry cache already skips some calls, so this
item does not mean "every terminal frame fully parses Markdown" — lower
priority than A09/A10.

## Architecture and reuse

### A12 A frozen object does not necessarily form an immutable data snapshot

Location: [builders.ts](../../packages/ui/src/builders.ts#L69),
[ui-validator.ts](../../packages/mayfly/src/core/ui-validator.ts#L109).

cloneWire copies accessor descriptors verbatim. In the minimal reproduction,
after freezing a text node whose content getter references an external
variable, mutating that variable leaves `Object.isFrozen(node)` true while
`node.content` has changed.

Core's validator rejects accessor fields — which effectively reduces rendering
risk, and this report does not describe it as a renderer-admission bypass. The
problem is that the builder/provider's "already-frozen snapshot" semantics
disagree with the renderer's "must be plain data" semantics, and can also let
other registry subscribers observe revisionless changes.

Recommendation: explicitly reject accessors at the public wire boundary and
verify the getter is not executed; schema admission stays core's division of
responsibility. Do not actively execute arbitrary getters to obtain a snapshot.

### A13 The cost/benefit boundary of duplicated logic needs redrawing

| Function | Implementation location | Current problem and recommendation |
| --- | --- | --- |
| List query/input/cancel | interaction/select-list.ts, frontend-panel.ts | Separately maintained query/filterEditing and input judgement, both missing multi-character input; share the pure input-state transition, keep each business layout |
| Mention token extraction | interaction/file-mention.ts:43, core/components.ts:171 | Duplicated delimiter/scanning in two places, both recording the quoted-space limitation; centralize pure parsing in a neutral internal module |
| profile argv parsing | app/exit-epitaph.ts:78, interaction/updater/profile.ts:45 | Duplicated algorithm, the latter citing "crossing the app package needs a new export" as justification; both are now in the same runtime package and can share an internal pure helper — no new public export needed |
| Clipboard subprocess | interaction/clipboard-probe.ts, paste-image.ts, clipboard-write.ts | Timeout strategies already diverge per A03; share bounded execution and error-classification primitives while preserving platform-protocol differences |
| Process execution in CLI and updater | cli/internals.ts, interaction/updater/io.ts | Windows, stdin, and failure diagnostics are inconsistent; the CLI's independent distribution boundary is a real reason — the CLI cannot simply depend on the full runtime, but at least share contract tests/cases |
| The four UI registries | ui/services.ts | A02's closure defect repeated four times; extracting a small stable-identity/lifecycle primitive suffices — no new service facade needed |

Another maintenance hotspot: `core/ui-compiler.ts` is about 2218 lines,
`ui-validator.ts` about 928, `core/terminal.ts` about 984, and
`settings-command.ts` about 1059. File length itself is not a defect; the risk
is that responsibility changes easily entangle validation, focus, and
painting. Recommend incremental splits around the existing control-state,
admission, and layout boundaries — avoid a one-shot compiler rewrite.

Parts that should not be misjudged as redundant: the public root/subpath
re-exports, the four distinct UI-registry semantics, live auxiliary Agents
reusing the main transcript, the readonly transcript panel, and the different
OS clipboard protocols. They serve distribution, lifecycle, or product
semantics respectively.

## Verification and reliability risks

### A14 The release matrix does not prove the three-platform TUI works

Location: [ci.yml](../../.github/workflows/ci.yml#L27),
[release.yml](../../.github/workflows/release.yml#L96).

The daily full code gate runs only on Ubuntu. The release matrix does include
Linux/Windows/macOS and Node 22/24, but cross-platform coverage mainly verifies
CLI install, version, and `plugin --help`; the profile composition, install
results, and real PTY boot/exit are all gated behind Linux + Node 24.

So the current evidence supports "cross-platform distribution and host
materialization are verified", not "Windows/macOS interactive workflows are
already equivalent to Linux". A configuration with 100% line coverage cannot
cover real shells, input methods, console encodings, clipboards, or focus
behavior.

Recommendation: add platform-targeted tests on PRs; on release candidates run
native ConPTY/macOS PTY boot, input, resize, exit-restore, plus in-app plugin
operations. Do not just drop the existing Linux shell smoke verbatim into a
Windows runner.

### A15 Runtime cache validity checking is weak

Location: [runtime.ts](../../packages/cli/src/runtime.ts#L37),
[runtime.ts](../../packages/cli/src/runtime.ts#L61).

readRuntime only checks the version and bin fields of the dsh package.json —
it does not verify the bin file exists, nor the current platform's native
layer; the cache-directory key only contains the Mayfly/Harness versions. A
cache whose manifest survives but whose entry was cleaned keeps hitting, and
sharing DSH_HOME across OS/architecture has no platform isolation.

This is a reliability risk for corrupted-cache/shared-home scenarios; this
round did not simulate deleting a user cache, and a normal first unpack is not
claimed to produce a half-baked result. The concurrent publish design of
synchronous unpack + temp dir + rename is still reasonable.

Recommendation: include target OS/arch in the cache key; on a hit, check the
entry point and a few platform sentinels, falling back to a recoverable
rebuild. Design it together with the startup-cost constraint that should not
rescan all of node_modules every run.

## Overall assessment by dimension

| Dimension | Existing strengths | Main weaknesses |
| --- | --- | --- |
| UI/UX consistency | canonical surfaces, semantic colors, shared hint/keymap, common form/list foundations | editing/deleting semantic conflicts; search input forked; narrow-screen fields invisible; incomplete translation workflows |
| Linux | plenty of CI, whole-tree, width, and process-test evidence | hard timeout for Wayland copy; in-app command discovery when only the launcher is installed |
| Windows | CLI has ComSpec preflight and a layered native payload | in-app POSIX shell/npm spawn, drive-letter/separator issues; no real TUI acceptance |
| macOS | native clipboard probe, darwin payload; shared Node path behavior close to Linux | insufficient real-machine evidence for TUI/IME/external editor; the launcher discovery problem applies too |
| Architecture | core is the terminal owner; native service graph; generation and Fiber cleanup mechanisms | registry identity is not isolated; some post-migration duplicated code is still justified by old package boundaries |
| Performance | transcript entry cache/200-entry window; list admission window; bounded Mermaid and diff computation | full provider copies, full projection validation/scans, repeated Markdown work before the cache |
| Tests | many source tests, width checks, lifecycle/replay tests | structural coverage outweighs scenario coverage; microbenchmark/real-interaction budgets missing; narrow cross-platform matrix |

## Items still needing real-machine verification

The following are not confirmed defects:

- Windows `clip.exe` input encoding for UTF-8 Chinese/emoji, and the combined
  behavior of the PowerShell clipboard with ConPTY.
- Windows external-editor shell quoting for directories with spaces or percent
  signs, and `code --wait` behavior; the existing quote helper only wraps in
  double quotes and escapes backslashes, without fully covering cmd.exe
  expansion rules.
- macOS Option/Meta, IME commits, terminal theme notifications, and
  OSC52/image fallbacks across terminal emulators.
- Local/remote clipboard targets under SSH/tmux and output recovery; this
  report does not automatically equate native success with content reaching
  the user's desktop clipboard.
- Child-process reaping when theme/reload/quit happens while an async external
  editor is still running; input-plugin already has unloaded write-back
  interception, but the launcher itself takes no AbortSignal parameter.
- Streaming FPS, keypress-to-paint delay, RSS, and GC in real long sessions.
  Microbenchmarks only prove where the work is, not the actual stall fraction.

## Remediation order and acceptance recommendations

### Phase 1: correctness and main workflows

Fix A01/A02/A03/A05/A06/A07/A04. For each, first add a regression case proving
the user-visible result, then change the implementation. Prioritize Windows
environments without Git Bash and with only mayfly-cli installed; form tests
must include Delete while typing and long labels on narrow screens — not just
screenshot widths.

### Phase 2: performance across the whole update chain

Measure builder -> provider -> compiler -> render first, then projection delta
-> transcript -> render; use 1k/10k/100k scales to observe growth curves.
Distinguish first open, steady repaint, small updates, and size changes. Handle
A09/A10 according to measurements, then optimize A11.

Recommended metrics: input-response and frame-time P50/P95, max event-loop
delay, allocation per update, and peak RSS. Budgets should be established on
target hardware — do not treat this report's synthetic data as acceptance
thresholds.

### Phase 3: reuse and language consistency

Handle A08/A12/A13, prioritizing merges of pure logic that has already drifted
functionally, while keeping the existing package/service boundaries. Do not add
a Mayfly manifest, plugin host facade, or new public subpath for the sake of
DRY. Run complete provider/settings/plugin flows in both locales.

### Phase 4: platform acceptance and cache recovery

Fill A14/A15. The minimum matrix covers Linux Wayland/X11, Windows
Terminal/ConPTY, and macOS Terminal or iTerm2; every platform verifies boot,
input method/paste, resize, form editing, file completion, in-app plugin
operations, and terminal restoration after exit. SSH/tmux, image protocols,
and automatic theme switching can form an extended matrix.

Subsequent fixes that touch user behavior should follow the repository rules
of using a dedicated worktree/profile and running the change-aware gate;
public UI, architecture, composition, and similar changes run the full gate
and deliver a scenario-specific manual acceptance checklist.
