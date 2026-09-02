# Overlay example

An opt-in Mayfly plugin adding `/example-overlay` through native
`ctx.commands`. The command opens a capturing modal directly through
`ctx.mayflyOverlays`. The plugin contributes renderer-neutral body content
while Mayfly owns the modal's single closed frame.

```sh
dsh plugin --profile mayfly-dev add @mayfly-example/overlay
```

Unloading the package unregisters the command and closes its overlay with the
plugin Fiber.
