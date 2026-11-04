# Slash commands reference

Typing `/` triggers fuzzy autocomplete and discovery hints (see [Input editor](/en/features/editor)); the `/help` overlay lists registered commands live — if anything differs, trust `/help`.

## Built-in commands

| Command | Aliases | Arguments | Description | Source |
| --- | --- | --- | --- | --- |
| `/quit` | `/q` `/exit` | — | Exit Mayfly | Remote frontend |
| `/new` | `/clear` | `[preset]` | Return to the start screen; the next message creates the new session (optionally under a chosen agent preset) | Remote frontend |
| `/fork` | — | — | Fork at the current native boundary; extra arguments are ignored | Remote frontend |
| `/rewind` | — | — | Create a safe branch from an earlier user turn | Remote frontend |
| `/sessions` | `/resume` | `[<session-id>]` | Browse sessions by workspace (cwd), then open a conversation; an id resumes directly | Remote frontend |
| `/rename` | — | `[<name>]` | Rename the current session (no name opens an editor) | Remote frontend |
| `/btw` | — | `<question>` | Create a temporary side Agent and switch the complete UI to it; empty input closes | Remote frontend |
| `/agents` | — | `[stop <id>]` | Browse the subagent tree, view a child, or stop a continuable child | Remote frontend |
| `/jobs` | — | — | Browse the current Agent's background jobs (list, detail, Read output) | Remote frontend |
| `/help` | — | — | Show available commands and key bindings | Remote frontend |
| `/mode` | — | — | Toggle plan mode (same as `Shift+Tab`; before a session, sets the next one) | Remote frontend |
| `/plan` | — | `[off]` before a session | Native plan command; with no session, `/plan` and `/plan off` set the pending plan mode (a message argument needs a session) | `dsh-plan-mode` (native) |
| `/model` | — | `[id]` | Switch the session model (no argument opens the picker) | Remote frontend (model-commands) |
| `/effort` | `/thinking` | `[level]` | Switch the thinking effort (no argument opens the selector) | Remote frontend (model-commands) |
| `/provider` | — | `[list \| switch <name> \| add]` | List providers, switch the route, or add one | Remote frontend (model-commands) |
| `/preset` | — | `[name]` | List agent presets, switch a blank session, or set the default before one starts | Remote frontend (preset-commands) |
| `/permission` | — | `[name]` | Native permission command: list or switch the sandbox/approval preset | `dsh-permission-presets` (native) |
| `/permissions` | — | — | Open Mayfly's permission-preset panel for the current Agent | Remote frontend (`permission-panel`) |
| `/tools` | — | — | List the tools visible to the current session | Remote frontend (tools-commands) |
| `/mcp` | — | — | Browse the MCP servers the host connects to and their tools | Remote frontend (mcp-commands, S34) |
| `/skills` | — | — | List available skills (the `#` prompt invokes one) | Remote frontend (skills-command) |
| `/theme` | see [Theming](/en/guide/theme) | | List or switch themes | Remote frontend (theme-switch) |
| `/init` | — | — | Analyze the codebase and write `AGENTS.md` | Remote frontend (session-init) |
| `/stats` | — | — | Show this session, the history of your sessions (activity heatmap, streaks), and the usage and cost per model | Remote frontend (stats-command) |
| `/context` | — | — | Show token usage and the context window | Remote frontend (session-commands) |
| `/version` | — | — | Show the Mayfly and harness versions and the live model | Remote frontend (session-commands) |
| `/changelog` | — | — | Show the release changelog (what's new, one section per release, the running version badged `· current`) | Remote frontend (session-commands) |
| `/trace` | — | `[copy <seq> \| copy all]` | Inspect the current session's execution timeline; copy one item or the full trace | Remote frontend (trace-command) |
| `/changes` | — | `[seq]` | Browse workspace changes still retained by the native Host | Remote frontend |
| `/update` | — | `[version]` | Safely update Mayfly (pre-flight, snapshot, boot smoke, automatic rollback; a bare call is a read-only check) | Remote frontend (update-command, D52) |
| `/settings` | — | — | Edit user settings by namespace (two-level panel, every change writes through; see [Configuration](/en/guide/config)) | Remote frontend (settings-command) |
| `/plugin` | — | `[install <id> [--source npm\|github] \| uninstall <id> \| info <id> \| list \| refresh]` | Browse, install, and remove marketplace plugins (official, dsh, and community tiers; cache-first with stale serving offline; see the [marketplace repository](https://github.com/Ephemeral-AI-Lab/dsh-plugins)) | Remote frontend (plugin-commands) |
| `/save` | — | `[full] [<path>]` | Save the current session as a Markdown file (the projected transcript, or the full event stream with `full`) | Remote frontend (session-export) |
| `/copy` | — | — | Copy the last assistant message to the clipboard | Remote frontend (session-export) |

## Sessions and models

- **`/sessions` / `/resume <session-id>`** — `/resume` is the alias of `/sessions`: with an id it resumes directly; without one it lists **native workspaces** grouped by the Workspace registry. The workspace holding the displayed conversation appears first, and each row shows its session count. Type to filter paths, then press **Enter** to browse that workspace.

  The workspace panel reads the native Session Controller catalog: names, status badges (`current`, `running`, `archived`, `Reminders`, `migration required`), the title/model/usage hints a summary carries, and a lineage tree for sessions in that workspace. Type to filter names or IDs. **Enter** opens details with Open/Archive/Restore actions. A `migration-required` session shows its cached values and a notice; Mayfly never starts migration on its own. **Workspaces** or **Escape** returns after editing/filtering ends; failed reads show a refresh hint.

  **Search contents** inside a workspace searches that directory's conversations. **Search all contents** on the workspace picker searches across directories. Content search requires the native Harness search capability.

  ![Sessions grouped by working directory](/shots/app-sessions.svg)

  ![Conversations inside a workspace](/shots/app-session-workspace.svg)

- **`/rename [<name>]`** — rename the current session: an argument renames directly, a bare call opens a one-field editor prefilled with the current name. A user name pins the title, so automatic titling no longer replaces it; the name shows on the editor's top border and in `/sessions`.
- **`/fork`** — ignores extra arguments and uses the current native fork boundary; returns `cannot fork while the agent is running` while the agent is not idle.
- **`/rewind`** — lists the current session's direct user turns in one level. Selecting a turn creates an ordinary child session from the complete boundary before it; the parent is never truncated or deleted and remains resumable through `/sessions`. A running agent is refused.
- **`/btw` / `/agents`** — open side conversations beside main; several can stay open, and a new BTW replaces the previous one. Every conversation renders in the transcript pane: a live BTW/continuable child drives the complete layout and editor, while a one-shot or cold child is read from native history and marked `read-only` or `reply to resume`. The status bar explicitly shows `F7 switch · F8 close`. `/agents stop <id>` accepts only live continuable children without live descendants, while browser stops require selecting Yes in a Yes / No confirmation; cold/inactive children are not falsely reported as stopped, and parents must be stopped leaf-first so Harness recursive teardown cannot widen the operation.
- **`/model` / `/effort`** — no argument opens the model picker or horizontal effort selector. Non-wrapping `←` `→` moves provider/effort tabs, `Enter` descends, and content-level Tab reaches actions. `Enter` commits **`Set as default`**: switch and persist as the new default. With an argument they switch directly and persist. The panel-free shortcut **`Alt+M`** cycles through the current provider's models (draft preserved; see the [key reference](/en/reference/keys)).
- **`/provider`** — three subcommands: `list` shows providers and the current route; `switch <name>` switches; `add` starts the add-provider flow.
- **`/preset`** — switches the agent composition over the thin-host roster (upstream `standard` / `minimal` / `ptc` / `cordis`, plus Mayfly `mayfly-cordis`): a session's tool surface, persona, and plan mode come from its preset. There is no `code` alias. A **blank session** switches that session, while with no session the pick writes the default the first and later new sessions take. A started session returns `cannot switch presets: this session has already started`; before one starts, a picker selection is reported as `Default preset: <name>`. Reminder tools (`schedule_*`) are preset-scoped: `standard`, `ptc`, `cordis`, and `mayfly-cordis` mount `tool-schedule`; `minimal` omits it. The Host-wide `schedule` service is enabled by the native Web composition unless the profile disables it.

## Modes and approval

- **`Shift+Tab` plan toggle**: normal ↔ plan, executing only `/plan` or `/plan off`. Before a session exists, `Shift+Tab`, `/mode`, `/plan` and `/plan off` set the pending mode shown as `plan…`; the session created by the first message enters plan mode before running that message. Enter YOLO with `/permission danger-full-access` and exit it with `/permission workspace-write`; YOLO can remain active alongside plan (see [Session modes](/en/features/modes)). Mayfly does not register `/yolo` or `/yes`.
- **`/permission`** — the native command lists/switches permission presets (named bundles of sandbox mode + approval policy) and keeps its name and argument form. Mayfly's `/permissions` opens the same single-select panel shape as `/preset` for the current Agent; a danger preset opens a Yes / No confirmation with No focused initially.
- **`/mcp`** — a three-level panel browsing the MCP servers the host connects to: server picker → server panel (a config pseudo-row + raw tool rows) → detail (config status / redacted connection / policy, or a tool's schema). Read-only — servers are added via profile patch (see [dsh/mcp](/en/dsh/mcp)); the empty state points the way.
- **`/init`** — the agent analyzes the codebase and writes `AGENTS.md` in the project root: if one exists it is read first, still-accurate content carries forward, and the file is rewritten into one coherent, up-to-date document (not appended), in the language the project's own docs mainly use.

## Info and saving

`/stats` history requires global Host authorization in both workspace modes;
Session-only authorization permits only that Session's own digest. Rejection
is shown before other history is read. Raw settings saves share the native
profile lock and atomically replace the document after comparing its revision;
editors ignoring that lock receive only partial conflict protection.

- **`/changes [seq]`** — reads workspace comparisons still retained by the native Host; without an argument it uses the latest comparison. A Host restart or Session disposal may leave no record available, producing an empty state. Browsing never activates a Session or restores a separate history store.
- **`/save [full] [<path>]`** — saves the current session as Markdown: the projected transcript by default, or the full event stream with `full`; without a path it writes the default filename `mayfly-export-{id8}-{YYYYMMDD-HHMMSS}.md`.
- **`/copy`** — the last assistant message's text goes to the clipboard: OSC 52 first (the escape sequence travels over stdout to the local terminal emulator, so **SSH sessions still reach the local clipboard**), with a fallback pipeline behind it.
- **`/trace`** — reads the current execution timeline through the harness's official session query; Up/Down selects an item, Enter opens full JSON, PageUp/PageDown scrolls details, `c` copies one item, and `a` copies the complete trace.
- **`/theme`** — full usage `usage: /theme [<theme>|auto|custom <path> [<base theme>]]`, see [Theming](/en/guide/theme).
- **`/quit`** — detaches and exits the frontend, including before a Session exists. Host work continues.

Frontend commands run locally; native commands are discovered for the selected Session and sent through official Client transport. Host handlers return serializable results, while native commands such as `/plan <message>` keep their own prompt-admission semantics. Without a Session, `/plan` and `/plan off` only set pending mode; `/plan <message>` refuses and asks for an ordinary message first. Aliases are frontend rewrites. `/permission` remains native, with `/permissions` as the frontend panel name.

## Parked commands

These names are not registered frontend commands in the current release. Any future capability belongs in Mayfly Host/Remote composition using public native APIs:

- `/reload` `/tasks` — deferred (task management goes through profile/config files)
- `/archive` `/delete` — no frontend commands; `/sessions` provides native archive actions
- `/import` — session-format version strictness undecided
- `/diff` (uncommitted-changes panel) and the full-screen approval diff preview — re-evaluated with dogfood feedback after release
- `/debug` — no frontend diagnostics-export command

After installing the Agent Team plugin and selecting its `team` preset, `/team` inspects the readonly roster and task board. `/schedule` lists the current Agent's native session reminders (overdue first, readonly; the Host `schedule` service must be available and the preset's `tool-schedule` row supplies the reminder tools). `/files` opens recorded file deliveries. Cold continuable child history offers `i` to reply through the native child address; browsing does not activate it. See [Team configuration](/en/features/team).
