# Mayfly package and release workflow

Mayfly publishes three packages as one `0.1.0-alpha.2` lockstep release:
`@ephemeral-ai/mayfly-ui`, `@ephemeral-ai/mayfly`, and
`@ephemeral-ai/mayfly-cli`. The exact release order lives in
`script/package-contract.mjs`. The supported Harness line is `0.1.2-alpha.5`.

Package manifests are the build source of truth. Concrete JavaScript exports
and bins become tsdown entries; TypeScript project references emit declarations.
Published packages contain runtime JavaScript, declarations, and explicitly
listed consumer configuration. Source, maps, workspace protocols, and local
paths must not leak.

Run:

```sh
pnpm run build
pnpm run check:lib
pnpm run check:pack
pnpm run check:examples
```

`check:pack` writes `.artifacts/pack/index.json` and three tarballs, then runs
manifest/export/bin/protocol checks, publint, AreTheTypesWrong, package budgets,
and an external UI-kit install fixture. Release automation publishes those
exact artifacts and does not rebuild.

`@ephemeral-ai/mayfly-cli` carries archived dsh runtimes. Refresh its isolated npm
lock with `pnpm run release:lock-cli`; do not resolve it through workspace
links.

The GitHub repository owns an `npm` environment. Until all three packages have
trusted publishing configured, that environment must provide an `NPM_TOKEN`
secret whose npm identity can publish under `@ephemeral-ai`. The release jobs
use the environment for both the candidate publish and dist-tag promotion;
local npm login is only for readiness checks and is never copied into the
repository automatically. After the first release, configure each package's
trusted publisher for `Ephemeral-AI-Lab/mayfly`, workflow
`.github/workflows/release.yml`, and environment `npm`. Keep the token until
dist-tag promotion also has an OIDC-capable path.

Tags execute the CI release workflow: publish verified artifacts to
`candidate`, install the exact registry versions on Linux/macOS/Windows, then
promote alpha and stable versions to `latest`, and RC versions to both `rc`
and `latest`. Local release commands must not publish.
