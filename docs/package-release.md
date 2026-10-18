# Mayfly package and release workflow

Mayfly publishes three packages as one `0.1.4-rc.1` lockstep release:
`@ephemeral-ai/mayfly-ui`, `@ephemeral-ai/mayfly`, and
`@ephemeral-ai/mayfly-cli`. The exact release order lives in
`script/package-contract.mjs`. The supported Harness line is `0.2.1-rc.2`.

Package manifests are the build source of truth. Concrete JavaScript exports
and bins become tsdown entries; TypeScript project references emit declarations.
Published packages contain runtime JavaScript, declarations, and explicitly
listed consumer configuration. Source, maps, workspace protocols, and local
paths must not leak.

After preparing a new release and writing its changelog entry, set `VERSION`
to that release and run:

```sh
VERSION=0.1.4-rc.1
pnpm run check -- --tier full --plan
pnpm release:preflight "$VERSION"
pnpm run check -- --tier full
pnpm release:preflight --artifact "$VERSION"
```

The version bump supports `pnpm release:version <version> --dry-run` and checks
all release markers before writing. Write a substantive first entry in the
shipped changelog before preflight. The Website is checked only here, never in
a round or a gate tier: run `pnpm run shots:sync` and `pnpm run shots:check`,
then `pnpm run website:build` and a persistent LAN preview
(`pnpm --dir website exec vitepress preview . --host 0.0.0.0 --port <port>`),
and give the affected routes for human visual/content acceptance. Do not tag
until that Website acceptance, the dedicated-profile checks, and the rest of
the human acceptance are complete.
For a release manifest change, the full plan includes `check:pack`; otherwise
run `pnpm run check:pack` before using the artifact preflight. The full gate
also builds and checks exports, examples, and tests; it does not check screenshots
or the Website.
`release:preflight` checks release metadata before building; its `--artifact`
form additionally checks the packed package set. These commands do not
publish or replace the registry-install matrix.

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

npm may accept a publish into its staged-publish queue instead of releasing it
immediately. The publish step then reports the exact staged packages and stops
with the approval command; an owner with a 2FA challenge approves them before
they become installable:

```sh
npm stage list
npm stage approve <stage-id>
```

Re-run the same workflow after approval: every version whose registry integrity
already matches is skipped, so the re-run continues from where it stopped.
`npm stage` needs CLI 11.15 or newer; the release job also lists pending stages
on failure. Pair staged publishing with trusted publishing (OIDC) when possible,
and keep the `npm` environment's required reviewers enabled so both the
candidate publish and the staged approval keep a human gate.

Tags execute the CI release workflow after acceptance: publish verified artifacts to
`candidate`, install the exact registry versions on Linux/macOS/Windows, then
promote alpha and stable versions to `latest`, and RC versions to `rc` only;
`latest` stays on the previous line until a stable release. The workflow
validates release metadata and artifact versions
before publishing or promotion. Local release commands must not publish.
Promote-only dispatch requires the original release run ID and
must be started from the same release commit; the referenced run must have
passed the candidate and all six registry-install jobs.
The repository's `npm` environment needs required reviewers to make human
approval enforceable before candidate publication; naming the environment
alone does not provide an approval gate.
