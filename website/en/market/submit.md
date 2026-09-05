---
title: Submit your plugin
---

# Submit your plugin

## Prerequisites

1. Publish the plugin as an ordinary Cordis package per the developer manual's [publishing guide](/en/plugins/publishing):
   - `package.json` declares `dsh.bundle.patch` (self-activating bundle), or the plugin assembles through profile patch rows;
   - the installed artifact ships `cordis.patch.yml` and build output (npm packages via `files`; GitHub sources must commit `lib/` — git installs fetch the source tree).
2. Prepare bilingual one-line descriptions, a capabilities disclosure (shell/network/credentials), and the tool & command list.

## The flow

1. Copy `registry/submission-template.json` from the [marketplace repository](https://github.com/Ephemeral-AI-Lab/dsh-plugins) to `registry/community/<slug>.json` and fill it in;
2. Open a PR there; CI runs the machine gates (schema validation, npm existence, tarball inspection, GitHub scratch installs);
3. Open an issue or comment in **your own** repository linking the PR, as the authorization evidence (prevents impersonation);
4. A maintainer reviews against the [review checklist](/en/market/review); merging lists the plugin — the `index-publish` workflow rebuilds the index and this site's page appears after the rebuild.

## Rules in brief

- One manifest per plugin; the `id` is permanent — to withdraw, set `status: removed` with a reason instead of deleting the file.
- npm sources preferred; unpublished packages may use a GitHub source with a commit-pinned `ref`.
- Declare `surfaces` honestly; `capabilities` is disclosure for reviewers and users, not a runtime permission.

Field-by-field details are in the [Manifest spec](/en/market/manifest).
