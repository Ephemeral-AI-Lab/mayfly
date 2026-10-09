# Panes and overlays

## Pane

`mayflyPanes` supports `header`, `left`, `right`, and `bottom` placement, and `views` for a view of status row 2 (see [Views of status row 2](/en/plugins/ui-reference#views-of-status-row-2)).

```ts
export const inject = ['mayflyPanes']

export function apply(ctx: Context): void {
  const pane = ctx.mayflyPanes.register({
    id: 'acme.inspector',
    title: 'Inspector',
    placement: 'right',
    size: { min: 20, preferred: 30, max: 40 },
    narrow: 'bottom',
  }, { kind: 'text', content: 'healthy' })

  // Call after domain state changes:
  pane.set({ kind: 'text', content: 'updated' })
}
```

`narrow` may be `bottom`, `overlay`, or `hidden`. `set(null)` releases the
lane until the next non-null snapshot.

`size` counts columns for `left`/`right` panes and rows for `bottom` panes.
Bottom panes stack in one dock that takes at most a third of the terminal
height: each pane first receives `size.min` rows (default 1, its head row),
nearest the editor first, and the remaining rows are shared round-robin up to
`size.max`. A pane that gets fewer rows than it rendered keeps its head and
ends in a muted `… +K more rows`, so put the most important row first. When
several passive bottom panes begin with a plain `divider`, the dock paints a
single rule for all of them. Use `overflow: 'truncate'` on dense rows so one
entry never costs two dock rows.

### Views

A `views` pane has no lane of its own: it declares a `summary` that joins status row 2 and updates it with
`setSummary()` (`null` takes the view out of the row). `set(node)` publishes the panel that replaces row 2 while the
view is entered with `Alt+↓`, `F5`, or `F6`. `size` and `narrow` do not apply.

## Overlay

```ts
export const inject = ['commands', 'mayflyOverlays']

export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'health',
    description: 'Open health details',
    handler: () => {
      ctx.mayflyOverlays.close('acme.health')
      ctx.mayflyOverlays.open({
        id: 'acme.health',
        title: 'Health',
        capturing: true,
        anchor: 'center',
        width: '70%',
      }, { kind: 'text', content: 'healthy' })
      return { kind: 'success', text: 'opened health details' }
    },
  })
}
```

A capturing overlay receives focus and is Escape-dismissible by default.
Only explicit `dismissible: false` disables this. A non-capturing overlay may
not contain interactive controls.

Pane and overlay ids are unique within their registry. Core still admits
snapshot and event output. Fiber unload removes panes and closes overlays opened
by that Fiber.
