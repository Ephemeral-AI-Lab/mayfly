# @ephemeral-ai/mayfly-cli

The `mayfly` command is an independent terminal UI launcher. It connects to a separately running dsh Host through `@ephemeral-ai/mayfly-remote`; it does not contain, extract, start, or stop a dsh Host, Agent Loop, model provider, tool runtime, or Session store.

Install the launcher and start the Host in a separate terminal with the `mayfly-host` profile:

```sh
npm -g install @ephemeral-ai/mayfly-cli
dsh --profile mayfly-host --host 127.0.0.1 --port 3080
```

Copy the authenticated startup URL printed by that Host into the canonical environment variable, then start Mayfly in another terminal:

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

`--host` changes the HTTP(S) Host URL without accepting credentials, a query, or a fragment; the token is still read from `MAYFLY_DSH_STARTUP_URL`. `--resume` and `--session` select an existing Host Session. Without either, Mayfly creates a Session using `--cwd` or the current working directory. Positional words form one initial task; use `--` before a task that starts with a dash.

`MAYFLY_SESSION_ID`, `MAYFLY_CWD`, and `MAYFLY_TASK` provide environment defaults when the corresponding arguments are absent. Command-line values take precedence. Use `/sessions` or `/resume` inside the TUI for interactive Session selection.

The npm package contains only the small launcher, its documentation, and an exact-version dependency on `@ephemeral-ai/mayfly-remote`. It has no bundled dsh CLI runtime archives and no first-run profile calibration or extraction cache. Reinstall `@ephemeral-ai/mayfly-cli` to upgrade the TUI; upgrade and operate the Host independently with dsh.
