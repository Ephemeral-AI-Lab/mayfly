# Configuration: models, providers, and themes

The split implementation uses Harness `0.2.2-rc.1`. Host owns native
configuration, credentials, model defaults, permissions, and Sessions. Theme
application, clipboard, exports, and external editor processes run on the
Remote TUI machine.

| Configuration | UI entry | Owner |
| --- | --- | --- |
| Providers and credentials | `/provider`, `/provider add` | Native Host provider/credentials controllers |
| Model and reasoning effort | `/model`, `/effort`, `Alt+M` | Native Host catalogs, defaults, and Session Controller |
| Agent preset | `/preset` | Native Host preset registry |
| Sandbox and approval | `/permissions`, native `/permission` | Native Host permission services |
| Locale and persistent theme default | `/settings` | Host settings; TUI applies presentation locally |
| Current theme | `/theme`, `/theme custom <path> [<base theme>]` | TUI; custom files are local |
| Host bundles | `/plugin` | Native Host plugin manager |

## Models and providers

Configure `DEEPSEEK_API_KEY` in the Host process, or use `/provider` for native
credential flows. Keys never enter projections or returned settings forms;
a blank secret field does not contain the saved value.

`/model` and `/effort` open their pickers without arguments and request native
writes with arguments. Sessionless selections update Host defaults for the
first Session. Native `@deepseek-ai/dsh-agent` owns the Session's
`modelSelection` projection; writes go through Session Controller. `Alt+M`
cycles within the current provider while preserving the draft.

Host public APIs own provider setup, configurable catalogs, model metadata,
and validation. Follow the [Harness reference](https://deepseek-harness.github.io/deepseek-harness/reference/)
and the current Host for configuration formats and persistence paths. Old
`settings.yaml` and old Mayfly patches do not define alpha.2's configuration
contract.

## Settings forms and the raw document

`/settings` lists namespaces and opens their field forms. Forms preserve
descriptor/field revisions and save through native settings writes. A conflict
requires a refresh and user review; it is never silently retried. Readonly or
missing services explain the refusal.

The whole-document editor reads the actual Host settings document and opens
a local temporary copy using `$VISUAL`, `$EDITOR`, or the configured editor
command on the TUI machine. It sends edits back to Host without opening a Host
filesystem path locally. Cancellation, launch failure, and conflicts retain
the appropriate draft and feedback.

Raw saves acquire the shared native profile lock, compare the SHA-256 revision,
atomically replace the file, and read the returned document under the lock.
This coordinates independent Host writers and native configuration writes.
Conflict protection remains partial: an external editor ignoring the lock can
write after the final revision check, so it is not a full CAS guarantee.

## Locale and themes

`/language` or `/settings` selects English, Simplified Chinese, or the system
default. `/settings` persists the default theme; `/theme` changes only the current
presentation. Core/theme reload preserves frontend forms, selection, editor
caret, undo, history, pastes, and completion state. Custom palette files remain
on the TUI machine. See [themes](/en/guide/theme).

## Startup and modes

Without a task or resume id, startup creates no Session. `/model`, `/effort`,
and `/preset` set Host defaults; `/plan`, `/plan off`, `/mode`, and `Shift+Tab`
set pending plan mode. The first ordinary prompt creates a Session, admits
plan mode, and only then sends the prompt. Failed admission sends no prompt.
Sessionless `/plan <message>` refuses and asks for an ordinary message first.

Plan and permissions are independent. `Shift+Tab` toggles only planning. YOLO
means the actual current `danger-full-access` sandbox and `never` approval
policy and may remain active alongside plan. It comes from native current
permission facts, including custom or withdrawn presets, rather than a guess
from the preset name.
