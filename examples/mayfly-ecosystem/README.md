# Mayfly ecosystem example composition

An opt-in TUI source composition: the ordinary `mayfly` startup with five
runnable examples added to the TUI's Cordis tree.

```sh
MAYFLY_DSH_STARTUP_URL='http://127.0.0.1:3080/?token=…' mayfly-ecosystem
```

`mayfly-ecosystem` takes the same options and environment as `mayfly`; start
the Host separately, as for `mayfly`. A composition of your own exports its
plugins and calls `run(argv, { plugins })` from `@ephemeral-ai/mayfly/bin`, as
`src/index.ts` does. This validation package is excluded from Mayfly's default
product and release set.
