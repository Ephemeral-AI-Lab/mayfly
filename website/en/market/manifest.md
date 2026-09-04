---
title: Manifest spec
---

# Manifest spec

A manifest is **discovery- and install-time metadata** — one JSON file per listing; the authoritative schema lives at [`registry/schema/plugin-manifest.v1.json`](https://github.com/Ephemeral-AI-Lab/dsh-plugins/blob/main/registry/schema/plugin-manifest.v1.json) in the marketplace repository. It never participates in runtime loading — the runtime contract of every plugin remains its package plus its `cordis.patch.yml`.

## Field overview

| Field | Required | Meaning |
| --- | --- | --- |
| `schemaVersion` | ✅ | currently `1` |
| `id` | ✅ | unique marketplace slug, used by `/plugin install <id>` |
| `source` | ✅ | `official` / `dsh` / `community`, must match the directory |
| `displayName` | ✅ | list name |
| `description` / `descriptionZh` | ✅ | one-liners, English and Chinese |
| `author` | ✅ | `{ name, url? }` |
| `links` |  | `repo` / `docs` / `npm` |
| `category` | ✅ | tools / ui / provider / workflow / testing / integration |
| `status` | ✅ | stable / beta / unstable / deprecated / removed (the last two need `statusNote`) |
| `surfaces` | ✅ | what the plugin **contributes**, see below |
| `provides` |  | `{ tools: [...], commands: ["/..."] }`, for display and search |
| `install.rows[]` | ✅ | ordered install units, see below |
| `engines` |  | `{ dsh, mayfly, node }` ranges; `surfaces.tui` requires `mayfly` |
| `capabilities` |  | disclosure (e.g. `shell`, `network`, `credentials`) |
| `verified` | ✅ | `{ at, packages: [{ name, version }] }` recorded at review |

## surfaces

```jsonc
"surfaces": {
  "server": {},                                     // dsh tools/services, any frontend
  "web":  { "clientModule": true },                // dsh Web React client module
  "tui":  { "contributions": ["panes", "status"] } // Mayfly UI contributions
}
```

The manifest declares **contributions**; usefulness per frontend is derived: **has `server` OR has that frontend's own contribution**. A `server + web` plugin shows "tools work, panel is dsh-Web-only" inside Mayfly.

## install.rows

```jsonc
"install": {
  "allowBuilds": ["node-pty"],       // packages allowed to run install scripts
  "rows": [
    {
      "id": "loop",                   // cordis patch row id (required for profile-patch)
      "name": "dsh-loop",             // runtime package name (the reconcile key)
      "activation": "bundle",         // bundle (default) | profile-patch
      "config": {},                   // default config for profile-patch rows
      "npm":    { "spec": "dsh-loop" },
      "github": { "repo": "Ephemeral-AI-Lab/dsh-plugins", "ref": "main", "subdir": "plugins/loop" }
    }
  ]
}
```

- Each row declares at least one of `npm` / `github`; prefer `npm` when published.
- GitHub spec grammar: `github:<owner>/<repo>#<ref>`, plus `&path:<subdir>` for monorepos.
- `activation: profile-patch` rows append to the profile's `cordis.patch.yml` after install (`/plugin` does it automatically).
- All rows of an entry **install and remove together** — passing them in one command is what lets sibling packages satisfy each other's peers.
