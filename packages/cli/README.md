# @ephemeral-ai/mayfly-cli

The `mayfly` command is an independent terminal UI launcher. It connects to a separately running dsh Host through `@ephemeral-ai/mayfly-remote`; it does not contain, extract, start, or stop a dsh Host, Agent Loop, model provider, tool runtime, or Session store.

For the current development branch, use the repository's canonical installer
and launcher with an isolated official dsh `0.2.2-alpha.2`:

```sh
pnpm install --frozen-lockfile
DSH_BIN=/path/to/dsh PROFILE=mayfly-cli-accept script/install-dev.sh
# Terminal 1
/path/to/dsh --profile mayfly-cli-accept
# Terminal 2: copy the authenticated URL printed by Host
MAYFLY_DSH_STARTUP_URL='<authenticated-url>' script/mayfly-remote.sh
```

When a matching verified split release is published, `npm -g install
@ephemeral-ai/mayfly-cli` installs this launcher and its exact Remote version.
The `mayfly` command then uses the same authenticated startup environment:

```sh
export MAYFLY_DSH_STARTUP_URL='<authenticated-url-printed-by-host>'
mayfly
```

The URL must be HTTP(S) and contain exactly one non-empty `token` query parameter. The token and resulting cookie remain in process memory and are never accepted as command-line arguments or included in ordinary diagnostics. Do not put the authenticated URL in `mayfly` argv. Existing terminal sessions can instead supply the value through their secret-safe environment mechanism.

Mayfly supports only independent Remote options:

```text
mayfly [--host <non-secret-url>] [--resume <session-id>] [--cwd <path>] [task ...]
mayfly --session <session-id>
mayfly --version
mayfly --help
```

`--host` changes the HTTP(S) Host URL without accepting credentials, a query, or a fragment; the token is still read from `MAYFLY_DSH_STARTUP_URL`. `--resume` and `--session` select an existing Host Session. Without either and without a task, Mayfly stays sessionless until the first prompt. Session creation uses `--cwd` or the launcher's current directory, interpreted as a path on Host. Positional words form one initial task; use `--` before a task that starts with a dash.

`MAYFLY_SESSION_ID`, `MAYFLY_CWD`, and `MAYFLY_TASK` provide environment defaults when the corresponding arguments are absent. Command-line values take precedence. Use `/sessions` or `/resume` inside the TUI for interactive Session selection.

The npm package contains only the small launcher, its documentation, and an exact-version dependency on `@ephemeral-ai/mayfly-remote`. It has no bundled dsh CLI runtime archives and no first-run profile calibration or extraction cache. Reinstall `@ephemeral-ai/mayfly-cli` to upgrade the TUI; upgrade and operate the Host independently with dsh.
