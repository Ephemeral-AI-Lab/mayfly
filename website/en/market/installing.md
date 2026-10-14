---
title: Installing & updating
---

# Installing & updating

## Inside Mayfly (recommended)

```
/plugin                 # browse, search, open details
/plugin install <id>    # e.g. /plugin install loop
/plugin install <id> --source github   # install from a GitHub source
/plugin list            # open on the Installed tab
/plugin updates         # open on the Updates tab (updates, repairs, deprecated or removed plugins)
/plugin uninstall <id>
/plugin refresh         # force an index refresh
```

The panel has **Installed**, **Updates**, and **Browse** tabs (`Alt+←/→` or `F2`/`F3`), rows grouped by category, and the focused plugin's detail beside the list from 100 columns. `i` installs, `u` updates, `x` removes (with confirmation), `s` switches the install source, `a` updates everything on the Updates tab, `r` refreshes, `g` cycles the grouping (category, source, none), and `/` filters: it searches names, descriptions, authors, tools, and commands, and takes facet tokens such as `source:official`, `cat:tools`, `surface:web`, and `needs:network`. **Enter** opens the detail panel where the list is alone. A completed change stays pending in a banner and in the status footer until you restart.

## With the dsh CLI (any profile)

```sh
# npm source
dsh plugin --profile mayfly add @deepseek-ai/dsh-terminal-bash @deepseek-ai/dsh-tool-terminal

# GitHub source (monorepo subdirectories work; pin a commit when possible)
dsh plugin --profile mayfly add 'github:Ephemeral-AI-Lab/dsh-plugins#main&path:plugins/loop'
```

## After installing

**Bundle membership is a startup boundary**: after install or removal, restart Mayfly (or `dsh --profile <name>`) and **start a new session** for the new tools and commands to appear.

- Plugins with native dependencies (node-pty for codex-terminal) write their `allowBuilds` allowance into the profile's `pnpm-workspace.yaml` at install time — the pnpm ≥10 permit for build scripts.
- Entries with `profile-patch` activation (most dsh optional plugins) append assembly rows to the profile's `cordis.patch.yml`; `/plugin` does this automatically, manual installs follow each plugin's README.
- **ACP Server is different**: it is an automation frontend that owns stdin/stdout. Mayfly shows it for discovery and removal but refuses to install it into the current TUI profile; create a dedicated non-Mayfly profile for ACP.

## Updates & offline

The Updates tab lists entries with newer versions (shown as `1.2.1→1.3.0`). The index caches under `$DSH_HOME/storages/mayfly-plugin-market/` and refreshes hourly by default; on failure the cached catalog still renders. Point the `mayfly.marketIndexUrl` setting at a mirror or a private marketplace if you need to.
