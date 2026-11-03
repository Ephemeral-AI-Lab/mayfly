# `@ephemeral-ai/mayfly`

English | [中文](README.zh.md)

Shared terminal rendering and presentation for the independent Mayfly TUI.
The package exposes explicit renderer, theme, transcript, editor, configuration,
and status subpaths. It supplies the candidate UI used by
`@ephemeral-ai/mayfly-remote`.

Run the product as two processes: a native DeepSeek Harness Host carrying
`@ephemeral-ai/mayfly-host`, and an independent TUI carrying
`@ephemeral-ai/mayfly-remote`. The global `@ephemeral-ai/mayfly-cli` launcher
starts the TUI. This shared package has no installable dsh bundle, root plugin
entry, composition patch, or preset payload.

For this development branch, use the checkout's verified build:

```sh
DSH_BIN=/path/to/dsh PROFILE=mayfly-split-accept script/install-dev.sh
/path/to/dsh --profile mayfly-split-accept
# In another terminal, copy the authenticated URL printed by the Host:
MAYFLY_DSH_STARTUP_URL='<Host URL>' script/mayfly-remote.sh
```

The Host needs official Harness `0.2.2-alpha.2`. Install model credentials on
the Host. The TUI detaches on exit; Host sessions and running work remain
owned by Harness. Rebuild the checkout after source changes.

Frontend UI plugins contribute renderer-neutral nodes through `mayflyPanes`,
`mayflyStatus`, `mayflyOverlays`, and `mayflyEditorExtensions`. Host plugins use
native dsh services in the Host process. Shared presentation accepts readonly
facts and structured actions; it never retains a native Agent or Session.

The published `0.1.4-rc.2` package is the immutable UI reference for this
implementation. Passing a smoke test does not establish visual parity; see
[split validation](../../docs/split-parity-validation.md).
