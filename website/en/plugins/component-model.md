# Component model

A plugin registers a renderer-neutral definition and a readonly
`MayflyUiNode` snapshot with a Mayfly service.

```text
domain state / dsh projection
            │ set(data/replace)
     registry snapshot
            │
 frontend interaction owner
    draft / action / feedback
            │
   core admission + compile
            │
       pi-tui component
```

The plugin owns domain state and its definition. The registry owns the current
registration snapshot, the frontend owner keeps semantic interaction state for
that registration instance, and core owns only compiled components, editor
bindings, focus, layout, and width.

Rules:

- nodes contain no Agent, Session, terminal width, or renderer object;
- `onEvent.observe` receives editing facts; `onEvent.action` performs native
  reads or writes and returns a structured settlement;
- context carries source stamps, operation ID, revision, AbortSignal, and a
  progress reporter;
- external domain changes use `set(node, { reason: 'data', source })`; instance
  replacement uses `reason: 'replace'`; handlers do not echo drafts through set;
- Fiber unload removes the registration and invalidates late handlers, reports,
  and publishers;
- every visible component stays bounded at 20/40/80/120 columns.

See the [UI node reference](/en/plugins/ui-reference) for fields.
