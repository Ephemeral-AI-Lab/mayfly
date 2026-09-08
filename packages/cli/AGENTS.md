# `@ephemeral-ai/mayfly-cli`

The global `mayfly` launcher is not a Cordis plugin. Its published manifest has
no runtime dependencies; the pinned Harness graph ships as common and native
archives. Product arguments and creative-mode preset behavior belong to Mayfly.

## Launch and calibration

- `translate.ts` handles version flags, fixes the profile to `mayfly`, and places
  the profile flag after `plugin` for that subcommand. Forward other arguments;
  respect the `--` boundary. Do not add an upgrade command or public runtime API.
- Calibration skips `link:`/`file:` profiles and never downgrades a profile
  advanced by `/update`. Keep launcher and in-app updater independently owned.
- Preserve platform-aware pnpm discovery: POSIX ENOENT and Windows ComSpec exit
  9009 differ. Inconclusive probes defer to install; workspace-root refusal gets
  one `-w` retry. Keep timeout/error classification and bounded diagnostic tails.
- Child env `MAYFLY_LAUNCHER` supplies branding; `MAYFLY_DSH_BIN` identifies the
  exact extracted host for in-app commands. Do not write host preset payloads.
- Side effects go through `src/internals.ts`; tests restore `cliInternals`.
  `src/bin.ts` remains a shebang and hand-off.

## Runtime distribution

`runtime/` is a private, independently locked seed. `script/pack-cli-runtime.mjs`
installs it with scripts disabled and a hoisted layout, then emits common plus
six OS/architecture archives. `check:pack` owns payload budgets, native sentinels,
executable/shebang checks, and the exact Harness line.

Extraction uses bounded synchronous tar reads into a prepared directory under
`$DSH_HOME/cache/mayfly-cli-runtime/`. Validate the host and native file sizes
against the generated sentinel manifest, including cache hits. Version and
locally handled market commands must not extract runtime payloads.

Every publisher acquires the `proper-lockfile` lease and revalidates under it.
Quarantine a damaged target only after a complete replacement exists; reuse
concurrent winners. Keep only bounded validation/renames in the critical
section and delete quarantine after release. Preserve compromise handling and
bounded retries; the lease cannot fence a process stalled beyond its stale
interval. Leave other versioned cache directories alone.

## Verification

Cover argument translation, calibration failures, extraction/cache repair,
concurrent publishers, and process termination using the existing CLI specs.
Use the shared tracked-temp cleanup for temporary homes/installs. Distribution
changes require full verification, `pnpm run check:pack`, and launcher/platform
smoke. Preserve Linux/macOS/Windows CI coverage; desktop clipboard and IME still
need [platform acceptance](../../docs/platform-acceptance.md).
