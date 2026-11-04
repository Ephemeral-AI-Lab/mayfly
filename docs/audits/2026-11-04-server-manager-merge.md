# Unified CLI and background Host merge

## Authorization and revisions

The owner explicitly requested “合并到主分支” on 2026-11-04 after the implementation,
verification results, remaining full-gate failures and native platform limits
were reported. This authorizes the merge; it does not establish that Windows
or macOS native acceptance passed.

- Previous main: `d9337644`.
- Implementation: `59297aa9` on `feat/server-manager`.
- Main merge: `0239d5da`, with no conflicts and an identical source tree to the
  implementation commit.

The change supplies one `mayfly` entry for the independent TUI and background
Host management. Linux uses systemd user services, macOS uses LaunchAgents,
and Windows uses Mayfly's own detached supervisor. Login startup is opt-in.

## Verification before merge

- 537 test files passed and two were skipped; 9,229 tests passed and two were
  skipped. Executable source retained per-file 100% statements, branches,
  functions and lines coverage.
- Typecheck, lint, builds, library exports, package contracts, examples,
  workflow checks, diagrams, agent docs and the strict Website build passed.
- The actual five-artifact packed install initialized a fresh native profile,
  authenticated an official Client, and exercised Session list/create/open/
  detach. TUI startup automatically started the Host; 100×30 and 40×24 PTYs
  exited cleanly while the Host remained running.
- Linux lifecycle checks covered terminal hangup, explicit stop/restart,
  status, enable/disable preserving current activation, crash recovery and
  credential redaction in logs.
- Website preview routes `/guide/`, `/en/guide/`, `/guide/faq.html` and
  `/en/guide/faq.html` returned HTTP 200 at `http://192.168.8.188:4187/`.

The original `verify:full` result remains **FAIL**. Its registry installation
timeout was resolved by a subsequent independent smoke run using
`MAYFLY_SMOKE_UPSTREAM_REGISTRY=https://registry.npmmirror.com`, including the
metadata streaming fix. Direct npmjs requests timed out in this environment.

All four remaining failed split scenarios were reproduced on unmodified main
`d9337644`, with identical failure lists after normalizing checkout paths:

| Scenario | Failures | Classification |
| --- | --- | --- |
| panels | 4 | Existing context/version, preset and model presentation differences against published rc.2 |
| stats | 2 | Existing context and Harness version differences |
| editor-feedback | 1 | Existing `/changes` help entry shifts later rows |
| files | 1 | Published reference capture fails while waiting for `Description:` to disappear; candidate comparison is not reached |

Reference goldens were not changed. Windows and macOS command/lifecycle unit
tests passed; native desktop lifecycle acceptance remains pending. This record
does not claim a green full architecture gate or three-platform native parity.

Original reports and receipts remain in the implementation worktree
`/home/x/dev/mayfly-server-manager/.artifacts/verify/` and
`.artifacts/server-smoke/`, including `verification.md`, `packed.json`,
`result.json`, `pty.log`, `real-client.log` and the four `baseline-*.json` files.

## Main rebuild and cleanup

After the merge, main passed frozen-lockfile offline installation, a complete
runtime build, all 53 library/export claims, and side-effect-free CLI help and
version smoke. All 70 generated release-package JavaScript files matched the
verified implementation build byte for byte. The strict Website build also
passed on main (21.21 seconds).

The two dedicated Hosts were stopped and login startup disabled. Profiles
`mayfly-server-accept` and `mayfly-packed-accept`, their private runtime records
and their exact systemd user units were removed from this task's isolated
data roots. The port 4187 Website preview was stopped. Evidence and worktrees
remain available; production Mayfly and global dsh profiles were not changed.
