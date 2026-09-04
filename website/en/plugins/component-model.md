# Component model

A plugin submits a renderer-neutral definition to a Mayfly service. Its
`render()` returns a canonical `MayflyUiNode`.

```text
domain state / dsh projection
            │
     synchronous render()
            │
        MayflyUiNode
            │
   core admission + compile
            │
       pi-tui component
```

The plugin owns domain state and its definition; the Mayfly registry owns the
current registration; core owns compiled components, focus, layout, and width.

Rules:

- render reads prepared state and performs no I/O;
- nodes contain no Agent, Session, terminal width, or renderer object;
- interaction uses `onEvent(event, context)`; context carries AbortSignal and
  revision;
- call the registration's `set(node)` after state changes;
- Fiber unload removes definitions and invalidates late async output;
- every visible component stays bounded at 20/40/80/120 columns.

See the [UI node reference](/en/plugins/ui-reference) for fields.
