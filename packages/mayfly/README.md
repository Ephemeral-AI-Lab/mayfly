# `@ephemeral-ai/mayfly`

English | [中文](README.zh.md)

The independent Mayfly TUI. It attaches to a native DeepSeek Harness Host
carrying `@ephemeral-ai/mayfly-host` through the official HTTP/WebSocket Client
and detaches on exit; Host Sessions and running work stay owned by Harness. The
global `@ephemeral-ai/mayfly-cli` launcher starts it. The package has no
installable dsh bundle, Host plugin entry, composition patch, or preset payload.

Its public surface is the root (the application and `runRemoteFrontend`),
`./client` (the official Client layer), and `./bin` (the `mayfly` entry).

For this development branch, use the checkout's verified build:

```sh
DSH_BIN=/path/to/dsh PROFILE=mayfly-split-accept script/install-dev.sh
/path/to/dsh --profile mayfly-split-accept
# In another terminal, copy the authenticated URL printed by the Host:
MAYFLY_DSH_STARTUP_URL='<Host URL>' script/mayfly-tui.sh
```

The Host needs official Harness `0.2.2-rc.1`. Install model credentials on
the Host. Rebuild the checkout after source changes.

TUI plugins contribute renderer-neutral nodes through `mayflyPanes`,
`mayflyStatus`, `mayflyOverlays`, and `mayflyEditorExtensions` in the TUI's own
Cordis tree. A source composition adds them to the ordinary startup:

```ts
import { run } from '@ephemeral-ai/mayfly/bin'
import * as myPlugin from './my-plugin.ts'

await run(process.argv.slice(2), { plugins: [myPlugin] })
```

Host plugins use native dsh services in the Host process. TUI plugins accept
readonly facts and structured actions; they never retain a native Agent or
Session.

The published `0.1.4-rc.2` package is the immutable UI reference for this
implementation. Passing a smoke test does not establish visual parity; see
[split validation](../../docs/split-parity-validation.md).
