# @ephemeral-ai/mayfly-cli

`mayfly` opens the independent terminal UI and automatically starts its local background Host. `mayfly server` manages that Host. Exiting the UI detaches its Clients and leaves Host work running.

After the matching split release is published:

```sh
npm install -g @ephemeral-ai/mayfly-cli
mayfly
```

For this development checkout, use Node >=24.9.0 and the pinned pnpm:

```sh
pnpm install --frozen-lockfile
pnpm run build
node packages/cli/lib/bin.js --profile mayfly-dev
```

Use a dedicated `mayfly-<tag>` profile in a worktree. The CLI depends on exact matching Host, Remote and official Harness packages; no separate global dsh installation or runtime archive is required.

```sh
mayfly server                         # start and wait for readiness
mayfly server start
mayfly server stop
mayfly server restart
mayfly server status
mayfly server logs                    # last 100 lines
mayfly server logs --follow
mayfly server enable                  # enable login startup
mayfly server disable                 # disable login startup; keep running
mayfly server start --profile work --port 0
mayfly --profile work
mayfly --resume <session-id>
mayfly --cwd /path/on/host 'Explain this repository'
mayfly -- server is the first word of this task
```

Default profile: `mayfly`. Both processes use `MAYFLY_HOME` (default `~/.mayfly`), with isolated Harness data under `harness/`, private discovery under `run/<profile>/`, and five rotating 10 MiB log files under `logs/<profile>/`. Existing `~/.dsh` data is not migrated. First use initializes a native Web profile and installs the Host bundle; existing profiles with a different recorded release are refused rather than silently upgraded.

Linux uses a systemd user service and macOS a LaunchAgent. Windows uses a hidden detached Mayfly supervisor, without Task Scheduler, Windows Services, or administrator rights. It restarts a crashed Host with bounded backoff and stops retrying after ten consecutive failures; a healthy minute resets the count. Windows `enable` writes only the current user's Run registry entry. Login startup is opt-in on all platforms, and logging out is outside the persistent-runtime guarantee. Native service-manager availability is required on Linux/macOS.

`stop` requests native Host cleanup and ends supervision, with forced termination of the exact owned child after ten seconds if necessary. Running Host work ends with it. A later `mayfly` starts the Host again. `enable` and `disable` do not change current running state. Status exits with 0 for healthy, 3 for stopped and 1 for failed or unknown; a process ID alone never proves readiness. Start/restart accept a concrete `--host` address and `--port` (defaults 127.0.0.1 and 0), save those settings per profile, and wait up to 60 seconds after initialization for readiness.

Host restarts rotate its connection credentials. Relaunch an already open TUI with `mayfly` to acquire the new local connection record.

For an explicitly managed remote Host:

```sh
mayfly server start --print-startup-url
# Transfer that explicit credential output securely to the other machine:
MAYFLY_DSH_STARTUP_URL='<authenticated-url>' mayfly
```

Credentials stay out of argv and ordinary logs. Local discovery uses current-user private records and authenticated control; remote connections use the existing environment URL. A non-secret `--host <HTTP(S)-url>` can override the remote address while its token still comes from that environment variable. Explicit remote inputs cannot be combined with `--profile`, and do not start a local Host.

Remote `--resume`/`--session`, `--cwd`, positional tasks, and `MAYFLY_SESSION_ID`, `MAYFLY_CWD`, `MAYFLY_TASK` keep their existing behavior. No Session is created before the first prompt unless an initial task is submitted. Use `/sessions` or `/resume` for interactive selection. `--help` and `--version` never initialize or start a Host.
