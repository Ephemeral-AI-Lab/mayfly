# `@ephemeral-ai/mayfly-cli`

The global `mayfly` launcher is not a Cordis plugin or a dsh Host launcher. Its published runtime dependency is the exact-version `@ephemeral-ai/mayfly-remote`; the package ships one small `lib/bin.js` and no runtime archives.

## Launch boundary

- `src/bin.ts` preserves the Node shebang and hands off to `run()` from `@ephemeral-ai/mayfly-remote/remote-bin`. Do not add calibration, extraction, spawning, profile management, or an in-process Host fallback.
- `packages/remote/src/remote-bin.ts` owns help/version, Remote option parsing, ordinary-terminal diagnostics, and hand-off to `runRemoteFrontend`. The Remote runtime owns TTY restoration, signal handling, Client detachment, and exit completion.
- `MAYFLY_DSH_STARTUP_URL` is the only authenticated startup-URL input. `MAYFLY_SESSION_ID`, `MAYFLY_CWD`, and `MAYFLY_TASK` are optional defaults; corresponding argv options take precedence.
- Tokens and cookies never enter argv, logs, or committed files. Reject credential-shaped arguments without echoing them and redact startup credentials from errors. `--host` accepts only a non-secret HTTP(S) URL and still obtains its token from the canonical environment variable.
- Host launch and termination belong to the separate REAL Loader `mayfly-host` profile. TUI exit detaches Clients only; do not add Host lifecycle RPCs or silently route arguments to the legacy dsh CLI.

## Distribution

`files` contains `lib/bin.js` and the bilingual README files. Keep Remote as a normal runtime dependency; do not bundle it, `@deepseek-ai/dsh`, the legacy Mayfly Host composition, or platform archives into the launcher. The root development override links the not-yet-published Remote package locally without changing the published version dependency.

`script/check-pack.mjs` checks the single-file bin, exact Remote dependency, shebang/executable bits, absence of runtime archives, and forbidden Host/dsh references. `script/package-contract.mjs` derives the bin build entry from the manifest. Structural package or build changes require `pnpm run build`; ordinary source emission can use `pnpm run build:changed`.

## Verification

Development uses only the incremental or structural build before unified acceptance. Finalization owns focused launcher/Remote-bin behavior coverage, `pnpm run check:pack`, and published-package two-process PTY smoke with a real Host. Preserve Linux/macOS/Windows launcher coverage; desktop clipboard and IME still need [platform acceptance](../../docs/platform-acceptance.md).
