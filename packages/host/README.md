# `@ephemeral-ai/mayfly-host`

English | [中文](README.zh.md)

Mayfly Host adds the `mayflyConversation` session projection and the `mayflyHost` Remote namespace to a complete `dsh-web-app` composition. Its bundle patch disables the browser handoff and the ordinary Web URL line, then prints one authenticated `mayfly host: <url>` readiness line after Loader settlement.

The independent frontend is `@ephemeral-ai/mayfly-remote`; the Host does not embed it.

## Development profile

Use Node `>=24.9.0` and the repository's pinned pnpm. From the repository root, install and build:

```sh
pnpm install
pnpm run build:changed
```

Initialize a fresh, ignored development profile from the shipped Web template. This replacement command is only for first-time setup; running it again resets the named profile:

```sh
export DSH_HOME="$PWD/.artifacts/dsh-host"
pnpm --dir packages/host exec dsh --profile mayfly-host-dev --from-default-profile web --dump-default-config >/dev/null
pnpm --dir packages/host exec dsh plugin --profile mayfly-host-dev add "link:$PWD/packages/host"
```

The resulting bundle order is `dsh-base`, `dsh-web-app`, then `@ephemeral-ai/mayfly-host`. The Host package's development dependency supplies the same `0.2.2-alpha.2` CLI for installation and launch, independently of the legacy in-process Mayfly package's dsh version.

Launch the external Host:

```sh
pnpm --dir packages/host exec dsh --profile mayfly-host-dev --no-open
```

Copy the authenticated URL from the single readiness line into the environment of a second terminal; never put it in argv or commit it:

```sh
MAYFLY_DSH_STARTUP_URL='<authenticated-url>' pnpm run scenario hostConversation
```

After source edits, run `pnpm run build:changed` and restart the Host. After manifest dependency edits, run `pnpm install`; the existing profile link remains in place.

## Installed profile

With `@deepseek-ai/dsh` `0.2.2-alpha.2` and a published `@ephemeral-ai/mayfly-host` available, the production route uses the same bundle mechanics without `link:` or the workspace-local CLI/home:

```sh
dsh --profile mayfly-host --from-default-profile web --dump-default-config >/dev/null
dsh plugin --profile mayfly-host add @ephemeral-ai/mayfly-host
dsh --profile mayfly-host --no-open
```

The initialization command replaces an existing custom profile, so use it only when creating or intentionally resetting that profile.
