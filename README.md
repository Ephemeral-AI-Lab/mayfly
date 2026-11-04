# Mayfly

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="website/public/brand/banner-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="website/public/brand/banner-light.svg">
    <img src="website/public/brand/banner-light.svg" width="720" alt="Mayfly — ephemeral agents, enduring works">
  </picture>
</p>

[![CI](https://github.com/Ephemeral-AI-Lab/mayfly/actions/workflows/ci.yml/badge.svg)](https://github.com/Ephemeral-AI-Lab/mayfly/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@ephemeral-ai/mayfly?label=npm)](https://www.npmjs.com/package/@ephemeral-ai/mayfly)
[![downloads](https://img.shields.io/npm/dm/@ephemeral-ai/mayfly)](https://www.npmjs.com/package/@ephemeral-ai/mayfly)
[![Node](https://img.shields.io/badge/node-%3E%3D24.9.0-339933)](#unified-command)
[![pnpm](https://img.shields.io/badge/pnpm-11-F69220)](#unified-command)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

English | [中文](README.zh.md)

Mayfly is an independent terminal frontend for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). The product runs as two processes: a native dsh **Host** and a **Remote TUI** connected through the official HTTP/WebSocket Client. The Host owns Agents, models, tools, and Sessions; the TUI owns input, themes, panels, and terminal rendering. Closing the TUI detaches it while Host work continues.

This development branch targets official Harness `0.2.2-alpha.3`. The published Mayfly `0.1.4-rc.2` is the immutable reference for appearance, keys, and workflows. Shared presentation is being carried into the split runtime; complete visual parity still requires the acceptance described in [split validation](docs/split-parity-validation.md).

## Unified command

The new CLI starts a background Host automatically and connects the independent TUI. From a built checkout:

```sh
pnpm install --frozen-lockfile
pnpm run build
node packages/cli/lib/bin.js --profile mayfly-dev
node packages/cli/lib/bin.js server status --profile mayfly-dev
node packages/cli/lib/bin.js server stop --profile mayfly-dev
```

After a matching release is published, install `@ephemeral-ai/mayfly-cli` globally and use `mayfly` and `mayfly server start|stop|restart|status|logs|enable|disable|upgrade`. Linux uses systemd user services, macOS LaunchAgents, and Windows a hidden Mayfly supervisor. Login startup is opt-in. Data defaults to `~/.mayfly`, with `MAYFLY_HOME` overriding it; credentials are exchanged through private local discovery. See the [CLI manual](packages/cli/README.md) for instances, logs, remote connections and lifecycle limits.

Upgrade the external CLI after stopping the old Host and backing up `MAYFLY_HOME`, then run `mayfly server upgrade` on the original profile to retain its Sessions. CLI-managed linked profiles use this explicit installer path; `/update` cannot upgrade them. See [upgrades and existing data](website/en/guide/upgrade.md) for the exact commands, rollback, and the old `~/.dsh` boundary.

## Native development startup

Use Node `>=24.9.0`, pinned pnpm `11.7.0`, and an isolated official dsh `0.2.2-alpha.3` executable. These split packages are development artifacts; install from this checkout or verified release tarballs. The installer checks the dsh version and keeps the global installation unchanged.

```sh
pnpm install --frozen-lockfile
DSH_BIN=/path/to/dsh PROFILE=mayfly-split-accept script/install-dev.sh
```

The installer builds the workspace, creates a dedicated profile from the native Web template, and adds `@ephemeral-ai/mayfly-host`. It reuses an existing profile and rejects the shared `mayfly` and `default` profiles. Launch both processes:

```sh
# Terminal 1: Host
/path/to/dsh --profile mayfly-split-accept

# Terminal 2: TUI; copy the authenticated URL printed by the Host
MAYFLY_DSH_STARTUP_URL='<URL printed by Host>' script/mayfly-remote.sh
```

Model credentials, provider settings, permission presets, and session files belong to the Host. The Host emits one `mayfly host: <url>` readiness line. Supply that authenticated URL through `MAYFLY_DSH_STARTUP_URL`; the TUI rejects credentials in command-line arguments. `--host` accepts a non-secret HTTP(S) URL while obtaining its token from the environment.

The TUI supports an initial task, an existing Session, and a Host working directory:

```sh
# Set the authenticated URL once in this terminal
export MAYFLY_DSH_STARTUP_URL='<URL printed by Host>'
script/mayfly-remote.sh 'Explain this repository'
script/mayfly-remote.sh --resume <session-id>
script/mayfly-remote.sh --cwd /path/on/host 'Run the relevant checks'
```

`MAYFLY_SESSION_ID`, `MAYFLY_CWD`, and `MAYFLY_TASK` provide defaults when corresponding arguments are absent. A launch without a task or resume id stays sessionless until the first prompt. `/new` and `/clear` return to that start view without creating an empty Session or stopping existing work. Rebuild with `pnpm run build` after source edits; rerun the installer when the dependency graph changes. The unified CLI uses this same Remote entry after starting and discovering its local background Host.

## Use the TUI

The shared layout contains the conversation, activity and notification rows, editor, and status/views lane. It renders Markdown tables, closed Mermaid fences, tool cards, file diffs, approvals, and questions. Theme changes preserve the native editor's draft, cursor, undo, history, paste, and completion state. `/theme custom <path> [<base theme>]` reads a palette on the TUI machine; `/theme` changes live presentation without saving the Host's default. Use `/settings` or onboarding to change persisted preferences.

`/help` and slash completion reflect the selected Host's actual command catalog and the mounted local features. A writable Session adds native Host commands; readonly views do not advertise writable commands. Canonical command names remain singular: `/model`, `/provider`, `/preset`, and `/plugin`.

| Workflow | Commands and behavior |
| --- | --- |
| Session navigation | `/sessions` (`/resume`) opens the workspace/session browser; an id resumes directly. `/rename <title>` renames the selected Session. `/fork` creates and selects a branch at the current native fork boundary; extra arguments are ignored. `/rewind` opens the reference earlier-turn picker with prompt/response previews and creates a selected branch while preserving the original Session. |
| Models and configuration | `/model [name]`, `/effort [level]` (`/thinking`), `/provider`, `/preset [name]`, `/permissions`, and `/settings` use native Host catalogs and writes. Before a Session exists, model and preset choices set Host defaults. |
| Plan mode | `/plan` enters plan mode, `/plan off` leaves it, and `/mode` or Shift+Tab toggles it. `/plan <message>` sends a native plan prompt in an existing Session; without a Session it asks you to send an ordinary message first. A sessionless mode choice is admitted before the first ordinary prompt; a failed admission sends no prompt. Alt+M cycles models within the current provider. |
| Information | `/context`, `/stats`, `/skills`, `/tools`, `/mcp`, `/files`, `/changes [seq]`, `/trace [copy <seq>\|copy all]`, and `/version` inspect native state or readonly Host projections. |
| Work and side conversations | `/jobs`, `/goal`, and `/schedule` use the enabled Host services. `/goal` keeps the native parser, status output and objective attachments; its status-row edit action puts the objective back in the prompt. `/schedule` shows the selected Session's reminders. `/btw <question>` opens a side conversation inheriting the complete current history, including an unfinished first turn; `/agents` browses the complete native descendant tree. F7 returns to the previous conversation and F8 closes its view. Closing a view keeps Host work running. |
| Local output and exit | `/copy` writes to the TUI machine's clipboard; `/export [full] [<path>]` (`/save`) writes on the TUI machine: relative paths use its working directory, absolute paths are supported, parent directories are created, and existing files are overwritten. `/quit` (`/q`, `/exit`) detaches and exits. |
| Additional Remote controls | `/host`, `/attach`, `/detach`, `/host-status`, `/account`, `/language`, and `/onboarding` appear in the Remote help section. |

Enter queues a prompt and Ctrl+Enter steers it through the official Client. Readonly conversations preserve drafts and refuse writes. A cold continuable child resumes only when the user explicitly replies through its native address. `/agents stop <id>` drains a live continuable leaf; a child with live descendants is refused. The selected conversation's interrupt uses native cancellation authority and keeps queued input.

Attachment-capable native commands receive images and uploaded file receipts in their original order. A refusal before admission restores the draft and attachments. An admitted command consumes them even when its native result reports an error. `/skills` shows the selected Session's native source/provider metadata and catalog completeness; a Host without the optional Mayfly catalog capability explicitly identifies the missing metadata.

`/changes [seq]` reads comparisons still retained by the native Host service without activating a Session. After a Host restart or Session disposal, the comparison may be unavailable and the browser shows an empty state.

## Partial behavior and upstream limits

These rows describe the remaining official API limits. Additional capabilities belong in Mayfly Host composition and serializable Remote methods, using public native APIs; this project does not extend dsh upstream to fill them.

| Area | Implemented behavior and remaining boundary |
| --- | --- |
| `/mcp` connection details | Official alpha.3 exposes no public configured-server/transport-health catalog. The panel lists servers discoverable from tool schemas and shows unknown connection state and absent transport/endpoint values. Resources/templates and explicit resource reads use native tools. A composition providing the optional sanitized catalog can add connection details. |
| Remote TUI extension hot loading | Host bundle changes use the native plugin manager. The official API provides no dynamic TUI extension mount; the preset browser marks this boundary. Frontend extensions require source integration and a TUI restart. |
| Cold child tool cards and controls | Passive native history and projections work. Without a live child Agent, custom presenters use generic durable tool cards and Agent-scoped controls report unavailable. Browsing never activates a child or borrows its parent's Agent. An explicit continuable-child reply uses the native addressed path. |
| `/update` Host startup check | `/update [<version>]` stages and checks the exact frontend release graph, confirms, upgrades both installations, verifies versions, and compensates failed changes. `/update recover` restores an interrupted transaction on its original Host. The official Host API provides no isolated Host boot check; the confirmation and result explicitly require restarting both processes and checking Host startup. Linked/read-only and non-npm frontend installations use their original installer. |

`/plugin` installs, updates, removes, and enables Host bundles through the native plugin manager. `/settings` supports revision-bound form changes and a local external editor for the actual Host settings document. Raw-document saves acquire the native profile lock, compare the revision under that lock, and replace the file atomically. This is partial conflict protection: an external editor that ignores the lock can still race after the final revision check. A conflict preserves the edited draft for review. Plugin changes report their restart boundary; a cancelled or stale write is never silently retried. `/schedule` and other optional features state when their Host service is absent.

`/stats` history requires Host-wide authorization even when limited to the current workspace, because it can expose sibling Sessions. Permission for the selected Session alone allows only its own statistics; a denied history request reports that boundary without starting a history scan.

Updates hold one cross-process lock through staging, installation, verification, and compensation. An interrupted transaction retains its recovery marker and log. Recovery refuses while an earlier npm writer is still alive; an unconfirmed worker startup reports the marker path and requires manual inspection before repair.

## Architecture and extensions

The release set contains five packages:

| Package | Responsibility |
| --- | --- |
| `@ephemeral-ai/mayfly-host` | Native Host composition, durable Mayfly projections, and generated `mayflyHost` Remote methods. |
| `@ephemeral-ai/mayfly-remote` | Official Client transport, Host/Session selection, feature controllers, and standalone TUI composition. |
| `@ephemeral-ai/mayfly` | Shared renderer, themes, editor/transcript controllers, and readonly presentation subpaths. No root plugin, dsh bundle, patch, or preset payload is published. |
| `@ephemeral-ai/mayfly-ui` | Renderer-neutral node contracts, builders, and the four UI services/provider. |
| `@ephemeral-ai/mayfly-cli` | Unified CLI for background Host management and independent TUI startup. |

<!-- BEGIN diagram:mayfly-layers -->
<!-- single source: docs/diagrams/mayfly-layers.en.mmd — edit the .mmd, then `pnpm run diagrams:sync` -->
```mermaid
flowchart TB
    HOST["native dsh Host process<br/>dsh-base · dsh-web-app · mayfly-host"]
    STATE["native Agents · Sessions · models · tools<br/>durable Mayfly projections"]
    WIRE["official Client HTTP/WebSocket<br/>serializable Remote DTOs · native file routes"]
    REMOTE["independent Remote TUI process<br/>HostKey + SessionRef selection · local feature state"]
    UI["four direct Mayfly UI services<br/>panes · status · overlays · editor extensions"]
    CORE["shared Mayfly core<br/>only pi-tui · ANSI · terminal · width owner"]
    TERM["terminal"]

    HOST --> STATE
    STATE <--> WIRE
    WIRE <--> REMOTE
    REMOTE --> UI
    UI --> CORE
    CORE --> TERM
```
<!-- END diagram:mayfly-layers -->

Host plugins are ordinary Cordis plugins using documented native dsh services. TUI plugins contribute nodes through `mayflyPanes`, `mayflyStatus`, `mayflyOverlays`, and `mayflyEditorExtensions` in the TUI's own Cordis tree. A plugin needing Host state uses the official Client/Remote protocol and serializable DTOs; Agent, Session, Tool Definition, callbacks, and renderer objects never cross processes. The removed in-process `mayflyCurrentAgent` and app/interaction entries are not public extension APIs. [Architecture](docs/mayfly-architecture.md) and [service seams](docs/mayfly-seams.md) describe the current boundaries.

## Development and verification

Use a dedicated worktree and `mayfly-<tag>` profile. `pnpm run verify:changed -- --plan` shows selected checks, `pnpm run verify:changed` runs them, and `pnpm run verify:full` runs the full architecture gate. Package imports resolve built `lib/`; a fresh checkout needs a build before tests that import package names.

[Split validation](docs/split-parity-validation.md) defines immutable reference acquisition, real Host/Remote HTTP/WebSocket and PTY scenarios, and cell-grid comparison. Smoke success and a reused shared component do not establish visual parity. Reference output must be captured independently of the candidate, and acceptance must include the selected workflows, terminal widths, themes, cancellation, and lifecycle cases.

Maintainer boundaries live in [AGENTS.md](AGENTS.md) and package instruction files. The published `0.1.4-rc.2` reference and historical source fixtures are validation inputs; they do not provide a second supported product installation path.
