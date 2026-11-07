# Platform acceptance

The `native platform regressions` CI job builds a clean checkout on Node 24 across Linux, Windows and macOS, runs the current CLI suites and native command/clipboard regressions, and drives a real background Host plus independent PTY/ConPTY. Release registry installs use the same supported Node 24 matrix (minimum runtime: 24.9.0).

Linux runners prepare a systemd user manager and its D-Bus environment; macOS runners require their GUI launchd domain. Windows uses the Mayfly hidden detached supervisor, with Git Bash directories removed from the test subprocess PATH. JavaScript entries execute through the selected Node binary. Build scripts execute pnpm JavaScript through Node, preserving paths with spaces and Chinese characters.

`script/smoke-platform-pty.mjs` exercises:

- All four resolved package versions and authenticated official HTTP/WebSocket Session list/create/open.
- Native service startup, login enable/disable preserving the running Host, owned-child crash recovery, and restart rotating credentials.
- Independent TUI startup, Unicode bracketed paste, backspace, 100/40/100-column resize and the command panel.
- Clean terminal restoration, TUI exit keeping Host alive, redacted logs, and explicit stop preventing recovery.

The full split gate separately covers filesystem completion, providers and native plugin actions. Each platform uploads redacted `terminal.log`, `commands.json` and `result.json`. These automated results do not establish manual desktop acceptance below.

By default the driver locates the installed global candidate CLI and creates a temporary isolated data root:

```sh
node script/smoke-platform-pty.mjs
```

For local source acceptance, build first and supply the CLI entry. A supplied profile must use `mayfly-<tag>`. An explicit `MAYFLY_HOME` is retained for inspection; the driver stops its Host and disables login startup on exit.

```sh
MAYFLY_SMOKE_LAUNCHER="$PWD/packages/cli/lib/bin.js" \
MAYFLY_SMOKE_PROFILE=mayfly-audit \
node script/smoke-platform-pty.mjs
```

## Background Host acceptance

Exercise `mayfly server start|stop|restart|status|logs|enable|disable` on all three platforms using a dedicated `MAYFLY_HOME` and `mayfly-<tag>` profile. Verify automatic startup on `mayfly`, terminal closure and TUI exit leaving Host running, authenticated readiness, explicit stop preventing recovery, crash recovery, private credential records, and enable/disable preserving current running state. Record native platform evidence separately from command-contract unit tests.

Linux uses a systemd user service; macOS uses a runtime LaunchAgent, with a login plist only when enabled. Windows uses a hidden detached supervisor, authenticated named-pipe control, bounded crash backoff and a current-user registry Run entry for explicit login startup. Check spaces/Chinese characters in installation paths and missing Node/CLI paths after an installation move. No Windows Task Scheduler or Windows Service is used. User logout is outside the uptime guarantee.

## Manual desktop acceptance

Native PTY logs cannot prove that a graphical terminal's input method, system
clipboard, or desktop protocols work. Before release, run the same checklist in
the following real environments and record versions and results:

| Environment | Required scenarios |
| --- | --- |
| Linux Wayland and X11 | Chinese input method, text and image clipboard, missing helper, OSC52 feedback on copy failure |
| Windows Terminal / ConPTY | No Git Bash, Chinese input method, UTF-8 paste, clipboard image paste (screenshot or copied image files stage through PowerShell into a paste marker; an unavailable powershell.exe is named in the notice), drive-letter and UNC completion, npmrc mirrors, in-app plugin actions |
| macOS Terminal or iTerm2 | Chinese input method, pbcopy, Finder image/file paste, screenshot/TIFF clipboard image paste (osascript coercion, Chromium TIFF converted through sips; an unavailable osascript or sips is named in the notice), window resize, and terminal restoration after exit |

The `prompt` node (roadmap slice 1.9b) keeps the terminal editor's own paste and input-method
behavior, so each platform also checks it on the UI gallery's prompt pane
(`example.ui-gallery.prompt`) or a profile that mounts one: a Chinese input method composes in the
prompt and the placeholder is gone once text commits; a large bracketed paste folds into a
`[paste #N +M lines]` marker and sends in full; a multi-line paste keeps its line breaks and does
not send; a paste while a completion list is open does not accept it; `Alt+Enter` or `Ctrl+J` insert
a line break; and at 40 columns the tokens fold behind `+N` without pushing the cursor off the row.

Every platform also checks Delete inside form editing, long label values on
narrow screens, original-input restoration after cancel, and no leftover child
processes after hot reload or exit. SSH/tmux, image display protocols, and
automatic theme are recorded separately as an extended matrix; automated passes
do not replace these desktop results.

## Management lock boundaries

The unified CLI serializes operations with a private owner record and reaps only a lock whose process is absent. Supervisor control authenticates both a private secret and exact generation. A persisted PID alone never authorizes stopping a process. The former extracted-runtime cache is removed; normal package-manager installation owns dependency integrity.
