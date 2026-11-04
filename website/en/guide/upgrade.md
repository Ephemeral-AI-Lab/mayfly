# Upgrades and existing data

Mayfly 0.1.5 uses one CLI to manage a background Host and an independent TUI. It pins official Harness `0.2.2-alpha.3` and requires Node `>=24.9.0`. The installer installs all five matching packages without changing a separately installed global `dsh`.

## Upgrade an existing split development installation

Exit every TUI, let Host work finish, and stop the old instance using its original launcher. Keep the same `MAYFLY_HOME`, back it up, and record the old version and profile name.

```sh
# Use the old installation to stop its instance; retain MAYFLY_HOME if configured
mayfly server disable --profile <old-profile>
mayfly server stop --profile <old-profile>
npm install -g @ephemeral-ai/mayfly-cli@0.1.5
mayfly server start --profile mayfly-015
mayfly server status --profile mayfly-015
mayfly --profile mayfly-015
```

The new profile starts from the current Harness Web template. Its Host data root remains the same `MAYFLY_HOME/harness`; check profile-specific bundles, settings, and plugins again. Do not copy the old profile package manifest, `node_modules`, or installation marker to bypass validation. Check `/sessions`, `/provider`, `/settings`, and an ordinary prompt before optionally enabling login startup with `mayfly server enable --profile mayfly-015`. Keep using that profile name for subsequent launches.

The default CLI registers its exact Host dependency through `link:`. `/update` therefore requests the original installer and cannot replace this managed installation. Starting an old profile with a different recorded release is refused explicitly. A fresh versioned profile is the supported upgrade path in this release.

To roll back, stop the new instance, reinstall the recorded old CLI version, and start its original profile. If the new Harness has rewritten persisted data, restore the complete pre-upgrade data-root backup before running the old version. Do not let different versions write the same data concurrently.

## Migrate from the old single-process Mayfly

Older installations normally used `~/.dsh`. The 0.1.5 default is `~/.mayfly`, with native Host data in `harness/`. Setting `DSH_HOME` does not override the CLI-managed data root; use `MAYFLY_HOME` to change that root.

This release has no automatic importer for old profiles or Session data. Keep the old installation and a backup of `~/.dsh`, export conversations you need with its `/export` command, and configure providers, permissions, and plugins in the new installation. Do not install the old shared renderer as a new Host bundle or copy the entire old profile into the managed directory. Native Harness owns persisted format conversion; changing a Mayfly version marker cannot replace that conversion.

## Independently maintained remote Hosts

When `MAYFLY_DSH_STARTUP_URL` selects a remote Host, the CLI starts no local instance. Host and Remote must use the same Mayfly release set and matching Harness line. Stop writes and back up data, upgrade both ends with their original installers, restart the Host, obtain its new authenticated URL, and launch the TUI. Pass that URL through the environment.

If an upgrade fails, retain logs and inspect `mayfly server status` and `mayfly server logs`. `server restart` rotates credentials; existing TUIs must exit and reconnect.
