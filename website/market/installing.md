---
title: 安装与更新
---

# 安装与更新

## 在 Mayfly 中（推荐）

```
/plugin                 # 浏览、搜索、查看详情
/plugin install <id>    # 例如 /plugin install loop
/plugin install <id> --source github   # 从 GitHub 源安装
/plugin list            # 已安装 / 可更新 / 已从市场移除
/plugin uninstall <id>
/plugin refresh         # 强制刷新索引
```

列表里按 **Enter** 打开详情，`i` 安装、`u` 移除、`r` 刷新；直接输入即搜索。

## 用 dsh CLI（任何 profile）

```sh
# npm 源
dsh plugin --profile mayfly add @deepseek-ai/dsh-terminal-bash @deepseek-ai/dsh-tool-terminal

# GitHub 源（monorepo 子目录也支持；建议 pin commit）
dsh plugin --profile mayfly add 'github:Ephemeral-AI-Lab/dsh-plugins#main&path:plugins/loop'
```

## 安装后

**Bundle 成员是启动边界**：安装/移除后需重启 Mayfly（或 `dsh --profile <name>`）并**新建会话**，新插件的工具与命令才生效。

- 带原生依赖的插件（如 codex-terminal 的 node-pty）会在安装时把 `allowBuilds` 写进 profile 的 `pnpm-workspace.yaml`——这是 pnpm ≥10 运行构建脚本的许可。
- `profile-patch` 激活的条目（dsh 官方可选插件多为此类）会把组装行写进 profile 的 `cordis.patch.yml`；`/plugin` 自动完成，手动安装时按各插件文档补行。
- **ACP Server 是例外**：它是会独占 stdin/stdout 的自动化前端。Mayfly 只展示并允许移除，不允许把它安装进当前 TUI profile；ACP 必须使用独立的非 Mayfly profile。

## 更新与离线

`/plugin list` 会标出有新版本的插件（`↑`）。索引缓存于 `$DSH_HOME/storages/mayfly-plugin-market/`，默认每小时刷新；获取失败时展示缓存目录，可在设置 `mayfly.marketIndexUrl` 换用镜像或私有市场。
