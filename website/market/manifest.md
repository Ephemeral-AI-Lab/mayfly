---
title: Manifest 规范
---

# Manifest 规范

清单（manifest）是**发现与安装期的元数据**，一份 JSON 一个条目，权威 schema 在市场仓库 [`registry/schema/plugin-manifest.v1.json`](https://github.com/Ephemeral-AI-Lab/dsh-plugins/blob/main/registry/schema/plugin-manifest.v1.json)。它不参与运行时加载——运行时契约始终是包本身加它的 `cordis.patch.yml`。

## 字段速览

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `schemaVersion` | ✅ | 目前为 `1` |
| `id` | ✅ | 市场内唯一 slug，`/plugin install <id>` 使用 |
| `source` | ✅ | `official` / `dsh` / `community`，须与目录一致 |
| `displayName` | ✅ | 列表显示名 |
| `description` / `descriptionZh` | ✅ | 双语一句话描述 |
| `author` | ✅ | `{ name, url? }` |
| `links` |  | `repo` / `docs` / `npm` |
| `category` | ✅ | tools / ui / provider / workflow / testing / integration |
| `status` | ✅ | stable / beta / unstable / deprecated / removed（后两者须写 `statusNote`） |
| `surfaces` | ✅ | 插件**贡献**什么，见下 |
| `provides` |  | `{ tools: [...], commands: ["/..."] }`，用于展示与搜索 |
| `install.rows[]` | ✅ | 有序安装单元，见下 |
| `engines` |  | `{ dsh, mayfly, node }` 版本范围；声明 `surfaces.tui` 时须有 `mayfly` |
| `capabilities` |  | 能力披露（如 `shell`、`network`、`credentials`） |
| `verified` | ✅ | `{ at, packages: [{ name, version }] }` 审查时记录 |

## surfaces

```jsonc
"surfaces": {
  "server": {},                                  // dsh 工具/服务，任何前端
  "web":  { "clientModule": true },             // dsh Web 的 React client module
  "tui":  { "contributions": ["panes", "status"] } // Mayfly UI 贡献
}
```

manifest 声明的是**贡献**；某前端下的可用性由此推导：**有 `server` 或有该前端自己的贡献**。`server + web` 的插件在 Mayfly 里显示"工具可用，面板仅 dsh Web"。

## install.rows

```jsonc
"install": {
  "allowBuilds": ["node-pty"],        // 允许跑安装脚本的包（写入 profile 工作区）
  "rows": [
    {
      "id": "loop",                    // cordis patch 行 id（profile-patch 必填）
      "name": "dsh-loop",              // 运行时包名（reconcile 键）
      "activation": "bundle",          // bundle（默认）| profile-patch
      "config": {},                    // profile-patch 行的默认配置
      "npm":    { "spec": "dsh-loop" },
      "github": { "repo": "Ephemeral-AI-Lab/dsh-plugins", "ref": "main", "subdir": "plugins/loop" }
    }
  ]
}
```

- 每行至少声明 `npm` 或 `github` 之一；已发布 npm 的优先 `npm`。
- GitHub spec 语法：`github:<owner>/<repo>#<ref>`，monorepo 加 `&path:<子目录>`。
- `activation: profile-patch` 的行在安装后追加进 profile 的 `cordis.patch.yml`（`/plugin` 自动做）。
- 一个条目的所有行**同装同卸**——同传才能让兄弟包满足彼此的 peer 依赖。
