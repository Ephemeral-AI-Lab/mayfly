# @ephemeral-ai/mayfly-cli

The `mayfly` launcher carries its tested dsh host as prepacked common and platform runtime archives. npm installs one dependency-free package and never resolves or runs lifecycle scripts from the Harness dependency graph.

Install pnpm 11 for profile management, then install Mayfly in one command:

```sh
npm i -g pnpm@11
npm -g install @ephemeral-ai/mayfly-cli
mayfly
```

The first command that needs dsh expands only the common and current-platform layers into a versioned user cache below `DSH_HOME`; later invocations reuse it. This extraction uses bounded memory and atomic publication, and does not contact npm. The profile is managed by dsh's official pnpm workspace path. Once the profile carries the shell's exact Mayfly version, ordinary starts do not invoke pnpm again. Reinstall the shell to upgrade; use `mayfly plugin` for explicit profile management.

Runtime caches are separated by operating system and CPU architecture. Each start checks the host entry and a small set of packaged native files; missing or truncated files trigger an automatic rebuild from the installed archives. Existing caches from older launchers are left in place.

The shell owns exactly three argument surfaces and forwards everything else to the pinned host untouched. `mayfly -V` (or `--version`) names the shell version, the pinned `@ephemeral-ai/mayfly` bundle version, and the bundled harness line without expanding the runtime. `mayfly plugin ...` maps to the bundled host's plugin subcommand with `--profile mayfly` inserted after the word `plugin`. Any user-supplied `--profile` is swallowed: the profile is always `mayfly`, so future Mayfly arguments cannot collide with host flags.

Creative mode is supplied by the `@ephemeral-ai/mayfly` bundle itself. The launcher only owns host delivery and profile selection.
