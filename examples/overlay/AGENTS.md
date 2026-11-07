# `@mayfly-example/overlay`

Injects `mayflyEditorExtensions` and `mayflyOverlays` only. The editor action
(a modifier key, as editor actions require) opens a two-page settings form;
repeated activation focuses the existing overlay. Frontend owns drafts, pages,
selection, submission locks, and dirty dismissal.

Publish body content only. Values and their revision live in the plugin Fiber;
the revision stamps every snapshot, and a submission from an older revision is
answered with a conflict. Never echo edits with `set()` or keep a plugin-owned
form/tab machine. Fiber unload removes the editor action and overlay.
