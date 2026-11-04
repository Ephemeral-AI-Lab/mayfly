# Quickstart

::: info Current development line and reference
The split implementation targets Harness `0.2.2-rc.1` and runs a native Host
plus an independent Remote TUI. Published Mayfly `v0.1.4-rc.2` is the immutable
UI, key, and workflow reference; it does not mean the split artifacts below
have been published. Install development artifacts from this workspace or a
verified matching tarball set.
:::

Read [upgrades and existing data](/en/guide/upgrade) before upgrading an existing installation.

## One command to start

After building this checkout, open the TUI directly. The CLI initializes a dedicated instance, starts its background Host and connects:

```sh
pnpm install --frozen-lockfile
pnpm run build
node packages/cli/lib/bin.js --profile mayfly-dev
```

After a matching release is published, install with `npm install -g @ephemeral-ai/mayfly-cli` and run `mayfly`.

```sh
mayfly server              # same as start; runs in the background
mayfly server stop
mayfly server restart
mayfly server status
mayfly server logs --follow
mayfly server enable       # opt into login startup
mayfly server disable      # disable login startup; keep Host running
mayfly server start --profile work
mayfly --profile work
```

Linux uses systemd user services, macOS a LaunchAgent, and Windows Mayfly's own detached supervisor without administrator rights. Exiting the TUI leaves Host running. `server stop` ends Host work; the next `mayfly` starts it again.

Data defaults to `~/.mayfly`, overridden by `MAYFLY_HOME`, without migrating existing `~/.dsh` state. Local discovery uses current-user private records; credentials stay out of logs. Remote connections still use `MAYFLY_DSH_STARTUP_URL` and do not start a local instance. Explicit URL output is available through `mayfly server start --print-startup-url`; never put that credential URL in argv.

The native development workflow below remains useful for debugging the two processes independently.

## Prerequisites

| Dependency | Version |
| --- | --- |
| Node | `>=24.9.0` |
| pnpm | Repository-pinned `11.7.0` |
| dsh CLI | Independently installed official `0.2.2-rc.1` executable |

## Install a dedicated Host profile

From the repository root:

```sh
pnpm install --frozen-lockfile
DSH_BIN=/path/to/dsh PROFILE=mayfly-split-accept script/install-dev.sh
```

The installer builds the workspace, creates a dedicated profile from the native
Web template, and adds Mayfly Host. It checks dsh's version without changing the
global installation and refuses shared `mayfly` and `default` profiles. Shared
`@ephemeral-ai/mayfly` provides renderer and presentation subpaths; it is not an
installable Host bundle.

## Launch two processes

```sh
# Terminal 1: Host; configure the model key in this process
DEEPSEEK_API_KEY='<your key>' /path/to/dsh --profile mayfly-split-accept

# Terminal 2: TUI; copy the authenticated URL printed by Host
MAYFLY_DSH_STARTUP_URL='<Host URL>' script/mayfly-remote.sh
```

Supply the authenticated URL only through the environment. Keep it out of argv,
logs, and commits. Host owns credentials, providers, permissions, and Sessions.
Closing the TUI detaches it while Host work continues.

Without a task or resume id, the first ordinary message creates the Session.
Use `script/mayfly-remote.sh 'explain this repository'` for an initial task,
`--resume <session-id>` to resume, or `--cwd <path>` for a Host directory.
`/new` and `/clear` return to startup without creating an empty Session.

## Start using it

- Type `/` or `/help` for the actual Host and frontend command catalog.
- Configure native providers through `/provider`; choose a model with `/model` and `/effort`.
- `/theme` changes the current TUI theme; `/settings` persists defaults. Theme changes preserve the editor draft.
- Sessionless `/plan` sets the next Session's mode; `/plan <message>` needs an existing Session.
- `/quit` detaches and exits the TUI, leaving Host work running.

Rebuild after source edits and reinstall the dedicated profile after dependency
changes. See [configuration](/en/guide/config) and
[contributing](/en/plugins/contributing) for validation and plugin integration.

## Interface reference

<p align="center">
  <img src="/shots/app-conversation.svg" width="720" alt="Mayfly terminal transcript, tool card, editor, and status bar reference">
</p>
