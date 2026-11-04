# Upgrades and existing data

Mayfly 0.1.5 uses one CLI to manage a background Host and an independent TUI. It pins official Harness `0.2.2-rc.1` and requires Node `>=24.9.0`. The installer installs all five matching packages without changing a separately installed global `dsh`.

## Upgrade an existing split development installation

Exit every TUI, let Host work finish, and stop the old instance using its original launcher. Keep the same `MAYFLY_HOME`, back it up, and record the old version and profile name.

```sh
# Stop with the old installation; retain the original MAYFLY_HOME and profile
mayfly server disable --profile <original-profile>
mayfly server stop --profile <original-profile>
# Back up MAYFLY_HOME before upgrading the external installation
npm install -g @ephemeral-ai/mayfly-cli@0.1.5
mayfly server upgrade --profile <original-profile>
mayfly server start --profile <original-profile>
mayfly server status --profile <original-profile>
mayfly --profile <original-profile>
```

`server upgrade` refreshes the linked Host through the official dsh installer carried by the current CLI and updates the version marker after composition validation. It retains the original profile Session and settings files; a live supervisor or unmanaged profile is refused. Check `/sessions`, `/provider`, `/settings`, and an ordinary prompt before optionally re-enabling login startup. If dependency installation fails, keep logs and the backup, fix the installation environment, and retry the same explicit upgrade command.

Ordinary startup still refuses a release mismatch and never upgrades an old profile implicitly. Do not copy `node_modules` or edit version markers to bypass validation. Keep the original data root and profile; creating another profile does not transfer the original profile configuration. Verify the upgrade by reopening an existing conversation that contains messages.

The default CLI registers its exact Host dependency through `link:`. `/update` therefore requests the original installer and cannot replace this managed installation. The explicit external-installation workflow uses `server upgrade` for that profile refresh.

To roll back, stop the new instance, reinstall the recorded old CLI version, restore the original profile from the pre-upgrade backup, and start it. If the new Harness has rewritten persisted data, restore the complete pre-upgrade data-root backup before running the old version. Do not let different versions write the same data concurrently.

## Migrate from the old single-process Mayfly

Older installations normally used `~/.dsh`. The 0.1.5 default is `~/.mayfly`, with native Host data in `harness/`. Setting `DSH_HOME` does not override the CLI-managed data root; use `MAYFLY_HOME` to change that root.

This release has no automatic importer for old profiles or Session data. Keep the old installation and a backup of `~/.dsh`, export conversations you need with its `/export` command, and configure providers, permissions, and plugins in the new installation. Do not install the old shared renderer as a new Host bundle or copy the entire old profile into the managed directory. Native Harness owns persisted format conversion; changing a Mayfly version marker cannot replace that conversion.

## Independently maintained remote Hosts

When `MAYFLY_DSH_STARTUP_URL` selects a remote Host, the CLI starts no local instance. Host and Remote must use the same Mayfly release set and matching Harness line. Stop writes and back up data, upgrade both ends with their original installers, restart the Host, obtain its new authenticated URL, and launch the TUI. Pass that URL through the environment.

If an upgrade fails, retain logs and inspect `mayfly server status` and `mayfly server logs`. `server restart` rotates credentials; existing TUIs must exit and reconnect.
