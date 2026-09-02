# Right inspector example

An opt-in Mayfly plugin that contributes a context inspector to the public
`right` pane lane. The host moves it to `bottom` on narrow viewports.

```sh
dsh plugin --profile mayfly-dev add @mayfly-example/right-inspector
```

The pane uses only public API/UI packages plus the shared example user kit.
Its contribution disappears when the package Fiber unloads.
