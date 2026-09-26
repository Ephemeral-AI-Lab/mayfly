# Platform acceptance

A PR's `native platform regressions` job verifies the launcher, cache repair,
host command selection, and the clipboard subprocess on Node 24 across Linux,
Windows, and macOS. The Windows-specific tests use `npm.cmd` and `pnpm.cmd`
under paths containing spaces and Chinese characters, without relying on Git
Bash.

Release candidates keep the three-platform Node 22/24 install matrix; Node 24
additionally validates the full profile composition and runs the native
PTY/ConPTY via `script/smoke-platform-pty.mjs`. The flow covers:

- Startup, Unicode bracketed paste, backspace, and 40/100-column resize.
- File completion, provider form editing, and cancellation.
- In-app install and uninstall of a local tarball marketplace fixture, with no
  third-party plugin publishing required.
- Clean exit and bracketed-paste terminal-mode restoration.

Each platform uploads `terminal.log`, `result.json`, and the startup
calibration log as release artifacts. The Windows subprocess PATH excludes the
Git Bash executable directory. Launching a JavaScript entry uses the current
Node and never treats `.js` or `.cmd` as a POSIX executable.

By default the driver exercises the installed global candidate launcher:

```sh
node script/smoke-platform-pty.mjs
```

Local source acceptance can point at an installed standalone profile.
`DSH_HOME` must be given explicitly, and the profile must use `mayfly-<tag>`;
never point at the production profile. For example:

```sh
DSH_HOME=/tmp/mayfly-acceptance \
MAYFLY_SMOKE_PROFILE=mayfly-audit \
MAYFLY_SMOKE_DSH_JS=/absolute/path/to/dsh/lib/bin.js \
node script/smoke-platform-pty.mjs
```

## Manual desktop acceptance

Native PTY logs cannot prove that a graphical terminal's input method, system
clipboard, or desktop protocols work. Before release, run the same checklist in
the following real environments and record versions and results:

| Environment | Required scenarios |
| --- | --- |
| Linux Wayland and X11 | Chinese input method, text and image clipboard, missing helper, OSC52 feedback on copy failure |
| Windows Terminal / ConPTY | No Git Bash, Chinese input method, UTF-8 paste, drive-letter and UNC completion, npmrc mirrors, in-app plugin actions |
| macOS Terminal or iTerm2 | Chinese input method, pbcopy, Finder image/file paste, window resize, and terminal restoration after exit |

Every platform also checks Delete inside form editing, long label values on
narrow screens, original-input restoration after cancel, and no leftover child
processes after hot reload or exit. SSH/tmux, image display protocols, and
automatic theme are recorded separately as an extended matrix; automated passes
do not replace these desktop results.

## Cache lock boundaries

Cache publishing uses a directory lease with a 120-second stale timeout and a
5-second heartbeat; acquisition retries are bounded at roughly 12 seconds.
Contention errors advise retrying later; locks orphaned by a crash recover
automatically after expiry without deleting the whole cache. Inside the lock
only bounded verification and rename run; recursive deletion happens after the
lock is released. The lease does not guarantee strong exclusivity if a process
pause or synchronous filesystem stall exceeds the stale window. The native
file check verifies existence and size, not per-file content hashes or a full
dependency-tree validation.
