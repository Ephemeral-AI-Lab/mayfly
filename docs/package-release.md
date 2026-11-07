# Mayfly package and release workflow

The split runtime publishes four packages in lockstep:
`@ephemeral-ai/mayfly-ui`, `@ephemeral-ai/mayfly-host`,
`@ephemeral-ai/mayfly`, and `@ephemeral-ai/mayfly-cli`. The exact release order lives in
`script/package-contract.mjs`. The supported Harness line is `0.2.2-rc.1`.
The published `@ephemeral-ai/mayfly@0.1.4-rc.2` remains an immutable parity
reference; choose a new, unpublished version before releasing the split packages.

Package manifests are the build source of truth. Concrete JavaScript exports
and bins become tsdown entries; TypeScript project references emit declarations.
Published packages contain runtime JavaScript, declarations, and explicitly
listed consumer configuration. Source, maps, workspace protocols, and local
paths must not leak.

After preparing a new release and writing its changelog entry, set `VERSION`
to that release and run:

```sh
VERSION='<next-unpublished-version>'
pnpm run check -- --tier full --plan
pnpm release:preflight "$VERSION"
pnpm run check -- --tier full
pnpm release:preflight --artifact "$VERSION"
```

Immutable reference mentions and private historical skills are excluded from automatic version replacement. Exact internal dependency pins are validated and advanced with the four release manifests plus the Website manifest.

The 0.1.5-rc.2 release uses an explicit prerelease version while npm latest stays at 0.1.5. The monotonic version helper intentionally rejects stable-to-RC changes, so this requested release updates the coordinated markers directly and validates them with preflight.

The version bump supports `pnpm release:version <version> --dry-run` and checks
all release markers before writing. Write a substantive first entry in the
shipped changelog before preflight. For a release, run `pnpm run shots:sync`
and `pnpm run shots:check`, then `pnpm run website:build` and a persistent LAN preview
(`pnpm --dir website exec vitepress preview . --host 0.0.0.0 --port <port>`),
and give the affected routes for human visual/content acceptance. Do not tag
until that Website acceptance, the dedicated-profile checks, and the rest of
the human acceptance are complete. Any earlier Website change also needs its
own strict build and LAN preview under the repository's acceptance rules.
For a release manifest change, the full plan includes `check:pack`; otherwise
run `pnpm run check:pack` before using the artifact preflight. The full gate
also builds and checks exports, examples, and tests; it does not check screenshots
or the Website.
The split step keeps raw strict comparison results in `split.json` and validates
the explicit, source-bound release decisions separately in `split-review.json`.
Only a successful release review satisfies this step; it never relabels raw
differences as strict parity. Missing checkpoints, unknown text/style changes,
runtime failures and unreviewed reference failures still block publication.
See [split-parity-validation.md](./split-parity-validation.md#release-decisions-in-the-full-gate)
before reviewing or changing a release policy.
`release:preflight` checks release metadata before building; its `--artifact`
form additionally checks the packed package set. These commands do not
publish or replace the registry-install matrix.

`check:pack` writes `.artifacts/pack/index.json` and four tarballs, then runs
manifest/export/bin/protocol checks, publint, AreTheTypesWrong, package budgets,
and an external UI-kit install fixture. Release automation publishes those
exact artifacts and does not rebuild.

`@ephemeral-ai/mayfly-cli` ships one unified bin with exact matching Host, TUI,
and official dsh runtime dependencies. It carries no runtime archives and does
not change a separate global dsh installation. Existing initialized profiles
refuse a recorded release mismatch. The supported managed upgrade uses the external installer followed by explicit server upgrade on the stopped original profile; see the bilingual Website upgrade guide. No silent profile upgrade is performed.

The GitHub repository owns an `npm` environment. Until all four packages have
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
before publishing or promotion. Its candidate job runs the same full architectural gate, including immutable-reference comparisons, as local final acceptance. There is no PTY waiver. Local release commands must not publish.
Promote-only dispatch requires the original release run ID and
must be started from the same release commit; the referenced run must have
passed the candidate and all three Node 24 registry-install jobs.
The repository's `npm` environment needs required reviewers to make human
approval enforceable before candidate publication; naming the environment
alone does not provide an approval gate.
