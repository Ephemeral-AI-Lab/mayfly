---
title: Review checklist
---

# Review checklist

Listings are reviewed on marketplace-repository PRs; the source of truth is [`registry/review-checklist.md`](https://github.com/Ephemeral-AI-Lab/dsh-plugins/blob/main/registry/review-checklist.md). In brief:

## Machine gates (CI, automatic)

- Schema validation passes; `id` unique; `source` matches the directory; `engines.mayfly` present whenever `surfaces.tui` is declared;
- every npm row exists on the registry with a healthy latest tarball (`cordis.patch.yml`, `dsh.bundle.patch`, or the row declares `activation: profile-patch`);
- every GitHub row scratch-installs into a throwaway profile whose installed package carries `dsh.bundle.patch` and build output;
- install lifecycle scripts and native binaries are flagged for the human pass.

## Human review (before merge)

- The PR author controls the package (authorization link in their repository) or the author approved the listing;
- descriptions and `surfaces` / `provides` / `capabilities` are honest (grep the source for the tool and command names);
- unload is clean: commands, UI, and listeners disappear with the Cordis fiber (source uses `ctx.effect`/disposers, no global state);
- `verified.at` is the review date, `verified.packages` records exact versions; GitHub-only entries pin a commit.

## After merge

- The `index-publish` workflow rebuilds `dist/` (via an auto-merged PR) and triggers this site's rebuild;
- the weekly re-verification marks `updateAvailable` on new upstream versions until the diff is re-reviewed.

## Removal

- Set `status: deprecated/removed` with a `statusNote`; **never delete the file**;
- security removals say so plainly in the note.
