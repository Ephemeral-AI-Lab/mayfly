# Mayfly audit repair results

Corresponds to the [original audit](./2026-09-06-code-audit.md) at baseline
`f9e41c4`. The implementation lives on `fix/audit-20260906`, integrated in
batches by three parallel tasks with cross-review. Code and Linux automated
verification are complete; not yet merged to main, pending manual acceptance.

## Repair status

| # | Result |
| --- | --- |
| A01 | Plugin, update, probe, and rollback uniformly use command/args; the bundled Harness takes precedence and JS runs under Node; Windows npm/pnpm uses cross-spawn; an outdated bundled host prompts to update the launcher |
| A02 | All four registry kinds capture stable ids; admission failures do not register, publish, or bump the revision; mutating the original definition no longer leaves residue or overwrites a contribution |
| A03 | Text copy and Linux/Windows/macOS image probing share a bounded runner; covers hard timeouts, cancellation, output caps, synchronous throws, and EPIPE |
| A04 | File completion and cwd use platform path semantics with drive-letter, UNC, home, and case support; known pi-tui-incompatible input is explicitly routed to the fs fallback while ordinary fds with no results keep the original semantics |
| A05 | Both lists share the core search input with multi-character, Unicode, grapheme deletion, and chunked-paste support; clearing cancels incomplete paste state |
| A06 | Delete/Ctrl-D while editing a field goes to the editor; entity deletion is limited to the browse state and keeps the second confirmation |
| A07 | Long labels on narrow screens now split label/value across lines; cross-review also fixed a duplicated cursor marker, verifying the single cursor is on the edited value row |
| A08 | Provider add/edit/delete uses structured results and dynamic locale; plugin/update status, preflight, rollback, and repair hints are wired to translations, while technical diagnostics keep their original text |
| A09 | A module-private WeakSet recognizes its own immutable snapshots so trusted subtrees can be reused; ordinary frozen objects and instances from other modules are still safely cloned |
| A10 | The source only admits and converts up to 200 eligible entries from the tail; the full projection copy and reference scan were removed; Harness and the checkpoint schema were not modified |
| A11 | Markdown sectioning caches by text revision; width changes or paint invalidation do not re-segment, and identical setText does not invalidate |
| A12 | Wire accessors are rejected at admission without executing the getter; copying uses safe data properties; the renderer keeps independent defense against forged illegal deltas |
| A13 | Shared search input, mention parsing, platform paths, profile argv, and the clipboard runner; the CLI's independent distribution boundary is preserved with no public facade or new subpath introduced |
| A14 | Configured three-platform Node 24 targeted CI and release PTY/ConPTY; the Linux integration run passes, while native Windows/macOS execution and desktop acceptance remain pending |
| A15 | Caches are keyed by OS/arch and check the entry point plus the packaged native sentinel; all publish/repair uses a directory lease covering concurrency and crash-orphaned lock recovery |

## Verification evidence

Environment: Linux x64, Node v24.15.0, workspace pnpm 11.7.0.

| Check | Result |
| --- | --- |
| `pnpm run verify:full` | Passed: workflow tests, types, lint, architecture diagrams, full build, lib, agent docs, standalone examples, full coverage, happy smoke |
| Full Vitest | 179 files passed, 2 skipped; 2982 tests passed, 7 skipped; Windows-specific tests skip on Linux and do not count as Windows verification |
| Coverage | statements 16589/16589, branches 11308/11308, functions 3599/3599, lines 13864/13864 — all 100% |
| Standalone examples | All eight declared scenarios executed with no failures; temporary consumer cleanup passed |
| `check:pack` | All three tarballs passed; external UI-kit install/runtime/types passed |
| CLI distribution | Seven-layer runtime totaling 119,863,019 compressed bytes; 26 platform sentinel packages; CLI JS ~177 KB, keeping the published package free of runtime dependencies |
| Packaged CLI cold start | Unpacked the current-platform runtime from the packaged artifact with an isolated DSH_HOME and ran `plugin --help`, exit 0 |
| Linux portable PTY | boot, Unicode paste, edit, resize, file completion, form edit/cancel, plugin install/uninstall, exit restore — all passed, exit 0 |
| Happy smoke | Real process at 40 columns connected to a mock LLM; `HAPPY_SMOKE_PASS exit=0` |
| Screenshots | No changes after regeneration; no Website source or asset changes |

The first whole-repo run found two old test assumptions inconsistent with the
new contract; they were fixed and the full gate was rerun. The accessor tests
now separately verify provider rejection and renderer defense under a forged
registry delta — the checks were not passed by deleting renderer defense
branches or lowering coverage thresholds.

## Performance comparison

Data is the median of seven samples per group from the same script, in ms.
Input size is 100,000. This is a headless synthetic benchmark on a shared
development machine — not a real-terminal FPS or hardware guarantee; raw P95,
heap growth, and RSS records are in [before](./2026-09-06-performance-before.json)
and [after](./2026-09-06-performance-after.json). Heap growth is not cumulative
allocation.

| Scenario | Before | After |
| --- | ---: | ---: |
| Raw list build, publish, paint | 280.215 | 238.981 |
| Trusted-list republish, paint | 132.684 | 1.192 |
| Reuse trusted items, update only selection and paint | 276.142 | 1.626 |
| List paging, paint | 0.462 | 0.503 |
| After native clone, Mayfly source only | 38.207 | 0.175 |
| Including full native parse and source | 70.640 | 36.795 |

The first pass over raw mutable data still requires a full copy; reuse
performance depends on trusted items produced by the retained library. List
paging shows no attributable gain. Harness full validation/clone, full-array
updates, and sparse cutoff scans can still be O(N); this round does not claim
those costs are eliminated.

Reproduction command (run build first):

```sh
node --experimental-transform-types --expose-gc script/audit-performance.mjs
```

## Manual acceptance

Retained work directory:
`/home/x/dev/deepseek-harness-plugin/mayfly-audit-20260906`. Retained manual
acceptance entry:

```sh
dsh --profile mayfly-audit-20260906
```

- Main flow: open provider configuration and confirm the Chinese title, fields,
  errors, and cancel hints are consistent; inside field editing, Delete only
  deletes a character and does not trigger provider deletion.
- Input: submit multi-character Chinese, emoji, and pasted text in list search
  and confirm filtering is correct; cancelling or clearing leaves no pasted
  content behind.
- Narrow screen: shrink to 40 columns — long field labels and values should
  wrap to separate lines with the edited value and single cursor still visible;
  focus and drafts survive restoring the width.
- Neighboring behavior: ordinary `@` completion, directory continuing
  completion, session switching, BTW, existing form submit/cancel, and terminal
  restoration after exit — no regressions.
- Platform: on Windows verify npm/pnpm without Git Bash and drive-letter/UNC
  paths in a native terminal; on macOS verify the input method and clipboard;
  on Linux desktop verify the system clipboard under Wayland/X11. The detailed
  checklist is in [platform acceptance](../platform-acceptance.md).

In-app plugin install/uninstall was verified automatically against a local
tarball fixture under a temporary standalone DSH_HOME; the manual profile does
not need to install any third-party plugin to confirm this. The update flow was
verified with a simulated registry, processes, and failure-rollback tests — no
real version upgrade was performed.

## Artifacts and remaining boundaries

- PTY results and logs: `.artifacts/platform-pty/` under the work directory
  (ignored; terminal logs are not committed).
- Release packages: `/tmp/mayfly-audit-pack-xaX70M/artifacts/`.
- Standalone home for integrated PTY: `/tmp/mayfly-audit-pty-KfYF4w`; packaged
  CLI cold-start home: `/tmp/mayfly-audit-launcher-pMtaZB`.
- The Windows/macOS CI jobs have not run remotely, and three-platform desktop
  manual acceptance is not complete; no three-platform certification is
  claimed.
- The cache lease is a 120-second stale timeout, 5-second heartbeat, and ~12
  seconds of bounded acquisition retries; extreme cases such as a process pause
  or synchronous filesystem stall beyond the stale window get no strong
  fencing. The native check is existence and size, not full content validation.
- main is still at the original baseline; the production profile is unmodified,
  and nothing was pushed, released, merged, or cleaned up. After manual
  acceptance passes, perform the merge, main-checkout rebuild, and temporary
  artifact cleanup.
