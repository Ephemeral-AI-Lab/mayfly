# Header pane example

An opt-in Mayfly plugin that places a compact workspace summary in the public
`header` pane lane. It consumes `@mayfly-example/user-kit` and degrades to
hidden when the viewport is narrow.

```sh
dsh plugin --profile mayfly-dev add @mayfly-example/header
```

The package ships its own one-row `cordis.patch.yml`, so adding it activates
the plugin. Uninstalling it removes the pane with its Cordis Fiber.
