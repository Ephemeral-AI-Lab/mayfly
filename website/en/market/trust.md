---
title: Trust & safety
---

# Trust & safety

## Three tiers

| Source | Meaning |
| --- | --- |
| **official** | Ephemeral AI Lab plugins, sources in the [marketplace repository](https://github.com/Ephemeral-AI-Lab/dsh-plugins) |
| **dsh** | DeepSeek's own optional dsh plugins |
| **community** | third-party listings that passed the machine gates and human review |

## What verified means

Every entry records the package versions and date **at review time** (the Verification block on each page). Listing runs the lightweight tier: entries track the latest version after review, and a weekly scheduled re-verification flags new upstream releases. `verified` means "this version was reviewed", not an ongoing guarantee.

## The honest disclaimer

**Listing is disclosure and review, not a sandbox.** Plugins run with your user privileges: installing a third-party plugin equals installing an arbitrary npm package. Before installing, read the page's:

- **Capabilities**: shell execution, network, credential access, and so on;
- **Frontend support**: `server` (any frontend), `web` (dsh Web panel), `tui` (Mayfly-native UI);
- **allowBuilds**: which packages the entry permits to run install scripts (native builds).

## Removal & reporting

Removed plugins keep their page, marked `removed` with the reason — installed users see "removed from the market" in `/plugin list`. Report malicious behavior to the [marketplace repository issues](https://github.com/Ephemeral-AI-Lab/dsh-plugins/issues).
