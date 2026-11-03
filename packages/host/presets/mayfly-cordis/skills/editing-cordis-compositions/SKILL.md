---
name: editing-cordis-compositions
description: Author or change a user-owned native Cordis Host bundle or Agent preset for split Mayfly. Use for plugin rows, preset tools/persona/skills, realm ownership, package installation, and native registry validation; terminal frontend composition belongs to its separate process.
---

# Edit a user-owned Cordis composition

Read the actual installed package references and inspect native APIs before
changing rows. Current Harness presets are `@deepseek-ai/dsh-agent-preset`
declarations in bundle patch files. They are not writable preset directories,
and the registry has no directory-copy API. Never use old `agent.cordis.yml`,
`preset.yml`, `copy()`, `standingKeyFor()`, `cordis_mount`, or `cordis_unmount`
instructions as the current contract.

## Pick the plane

Host registries, persistence, credentials, sandbox/approval policy, provider
backends, and shared services stay in the Host composition. An Agent preset
contributes tools, persona, prompt sections, and skills to its native scope.
A service owned by one preset must have an isolate realm shared by its provider
and consumers; a preset must not publish a process-global service. Consumers
of Host services must remain able to resolve those Host services.

Mayfly's terminal frontend runs in another process. Its four UI services are
absent from both the Host and Agent-preset tree. `/preset` changes an Agent's
native composition; it cannot replace frontend rendering. Host `code.host`
and browser `code.client` do not provide a terminal injection path. This release
has no public external frontend plugin installer or dynamic UI hot-load entry.

## Author a native preset

Create a user-owned ordinary ESM bundle; expose its patch from `package.json`
and declare `dsh.bundle.patch`. A declaration looks like:

```yaml
- insert:
    - id: preset-my-mode
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: my-mode
        name: My mode
        description: What this Agent may do
        order: 10
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: You are a coding agent powered by the {{model}} model.
```

The Loader row id addresses patch edits; `config.id` is the native preset
identity. Use a new unique identity rather than mutating the installed
`standard`, `cordis`, or `mayfly-cordis` declaration. Copy desired rows from
the current installed upstream Cordis preset, preserving its native isolate
groups and supported config fields. All named packages must resolve in the
installed deployment; include their dependencies in the bundle manifest.

Mount skill files through `@deepseek-ai/dsh-skill-filesystem` and its documented
`customSkillDirs`, resolved from the owning installed package. Include every
payload file in the package's `files` whitelist. Do not depend on checkout-only
paths, old renderer-private payloads, or files written into the user's global
skill roots.

Keep a proposed patch concrete and reviewable. Proceed within the user's
authorized scope, and use the official Plugin Manager or
`dsh plugin --profile mayfly-<tag> add file:...` for a dedicated profile.
Do not edit installed bundle contents, production profiles, or publish without
authorization. A bundle upgrade would overwrite installed-file edits.

## Validate the actual registry

Use the current `agentPresets` API declarations. Its public `list`, `resolve`,
`readDocument`, `compositionInventory`, and `acquireScope` operations expose
native definitions, their document, and mounting diagnostics. A registration
can remain listed with a `broken` activation diagnostic; listing a row alone
does not prove its tools and services activated. Check the exact definition's
diagnostics and acquire/release its native scope. Do not manufacture a green
status or bypass a failed native mount.

Verify package exports and payload closure, then run a real dedicated Host and
read its official `agentPresets.list()` Remote catalog. Select the preset only
where the native turn-boundary guard permits it; recheck the real tools,
persona, and skills from a Session on that preset. Exercise a second Session
to catch leaked global services. Unload must release this declaration's own
effects while native users retain their proper generation.

Mayfly repository changes follow the checkout's `AGENTS.md`, package checks,
and dedicated-profile acceptance workflow. No authoring skill overrides the
user's request or existing authorization.
