# Panes and overlays

## Pane

`mayflyPanes` supports `header`, `left`, `right`, and `bottom` placement.

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

`narrow` may be `bottom`, `overlay`, or `hidden`. The handle also exposes
`set(null)` releases the lane until the next non-null snapshot.

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
