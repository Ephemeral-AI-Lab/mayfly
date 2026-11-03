# FAQ

## Why not a plain `npm install @ephemeral-ai/mayfly`?

The shared package contains renderer and readonly presentation subpaths. The
current product uses `mayfly-host` in a native dsh profile and an independent
`mayfly-remote` TUI. The small `mayfly-cli` launcher depends on the exact Remote
version; it does not bundle or start Host. Follow the [split quickstart](/en/guide/).
Published `0.1.4-rc.2` is the immutable UI reference; current development targets
Harness `0.2.2-alpha.2` and requires matching verified build artifacts.

## The install resolves an older release?

pnpm's `minimumReleaseAge` can defer newly published versions. Use a verified
exact release set and preserve the repository's exclusions; do not resolve an
unversioned shared renderer package as a Host installation. The development
installer builds this workspace and checks the selected dsh version.

## How do I upgrade Mayfly?

`/update` performs a readonly check; `/update <version>` stages and checks the
exact frontend release graph, asks for confirmation, upgrades both installations,
verifies versions, and compensates failures. `/update recover` restores an
interrupted transaction on the original Host. A cross-process lock and recovery
marker prevent concurrent writers. Linked, readonly, or non-npm frontend
installations use their original installer.

Restart both processes after an upgrade and check Host startup. The official
Host API supplies no isolated Host boot check. A frontend import check does not
establish Host startup success. Development worktrees rebuild and reinstall
their dedicated profile after dependency changes.

## Why is `/stats` history unavailable?

History can expose sibling Sessions even in current-workspace mode, so it needs
global Host authorization. Authorization for the selected Session permits its
own statistics only. A denied history request explains the boundary and starts
no scan.

## Pasting an image does nothing?

Ctrl-V paste depends on two things:

1. **Terminal environment**: the platform's own clipboard path is probed — `wl-paste` then `xclip` on Linux (3s timeout), one PowerShell call on Windows (10s), osascript on macOS (5s);
2. **Model capability**: pasted images enter the message as image content blocks. If the current model route has no image input, messages containing image blocks are rejected — that is the upstream harness capability negotiation; switch to a vision-capable model.

The TUI admits local image data and stages it through native Host attachment APIs. Session writes preserve the original order of images and file receipts; no local image-store path is a Host filesystem capability.

You can copy image content from an application or copy one or more local PNG/JPEG/WebP/GIF files in your file manager (Ubuntu Files, Windows Explorer, macOS Finder — all paste as one ordered batch). The file-manager path only accepts local regular files; remote URIs, directories, symlinks, and special files are refused with a reason.

## Why doesn't the injected AGENTS.md context show up in the transcript?

The harness injects workspace instructions (AGENTS.md and friends) and runtime-context snapshots into the session as synthetic user messages. Mayfly sorts by message source: human input renders as usual (`»` message blocks); **synthetic messages render as nothing** — no item, no placeholder — keeping the transcript clean. The content is still sent to the model in full; it is just not rendered.

## Can I customize key bindings?

Not yet. Keys register through `mayflyKeymap` (duplicate bindings are rejected), but user-facing customization is deferred to a later phase (same for alt-screen surfaces). See [Key bindings](/en/reference/keys) for everything available today.

## `/quit` does nothing?

`/quit` is frontend-local and works before a Session exists. It detaches and exits the TUI while Host work continues. The two-step Ctrl-C exit follows the warning shown by the editor.

## When does the status-bar git badge refresh?

The git badge probes lazily through a TTL cache (branch 5s, status 15s), refreshed on whatever redraw comes next (typing and streaming both trigger one) — switching branches in the same directory shows up within seconds. The cache is built per working directory: a session switch (`/new`, `/resume`, or a restart) that lands on a new cwd rebuilds the cache for it.

## What happens when the status bar runs out of room?

The footer is one row (an entry has no row of its own: the only second line is the heavy `━` under the item whose view is entered). When the row is crowded it first gives up detail in a set order (an item's time, the provider, the thinking level, git, the directory's depth, the cache bar, the context bar, and last the model). Entries then admit in `priority`, then id, order across the whole row regardless of band: an entry that fits keeps its full width, an over-wide entry truncates to the remaining budget (entries declaring `overflow: hide` hide entirely rather than truncate), and once the row is full, later entries stop appearing. Admitted entries then lay out in their declared left/center/right band. The session name no longer competes for footer space — it sits at the right end of the editor's top border.

## Does bash-mode output enter the session history?

No. Commands in `!` bash mode run through Mayfly's own executor and echo into the scroll area as shell cards — **deliberately outside the session transcript**, invisible to the model. Paste results back into the prompt, or let the model run a tool, when it needs to know.
