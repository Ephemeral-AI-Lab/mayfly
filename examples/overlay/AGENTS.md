# `@mayfly-example/overlay`

Injects native `commands`/`settings` and `mayflyOverlays`. The command opens a
persistent two-page settings form; repeated entry focuses the existing overlay.
Frontend owns drafts, pages, selection, submission locks, and dirty dismissal.

Publish body content only. The Loader row id is the settings namespace and
the volatile Config is its form schema; `settings.describe()` supplies values
and native descriptor revisions, which accompany path writes and structured
replies; `settings/document-updated` refreshes snapshots. Never echo edits
with `set()` or keep a plugin-owned form/tab machine. Fiber unload removes
the namespace, command, observers, and overlay.
