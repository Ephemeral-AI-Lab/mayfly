---
title: 安装与更新
---

# 安装与更新

## 在 Mayfly 中（推荐）

```
/plugin                 # 浏览、搜索、查看详情
/plugin install <id>    # 例如 /plugin install loop
/plugin install <id> --source github   # 从 GitHub 源安装
/plugin list            # 打开“已安装”页
/plugin updates         # 打开“更新”页（可更新、需修复、已弃用或已下架的插件）
/plugin uninstall <id>
/plugin refresh         # 强制刷新索引
```

面板分为 **已安装**、**更新**、**浏览** 三页（`Alt+←/→` 或 `F2`/`F3` 切换），按分类分组；宽度 100 列以上时，列表旁边会显示当前插件的详情。`i` 安装、`u` 更新、`x` 移除（需确认）、`s` 切换安装来源、`a` 全部更新（在“更新”页）、`r` 刷新、`g` 切换分组（分类、来源、不分组），`/` 筛选：可搜索名称、描述、作者、工具与命令，并支持 `source:official`、`cat:tools`、`surface:web`、`needs:network` 等条件。宽度不足时列表独占，按 **Enter** 打开详情。已完成的更改会保留在面板横幅和状态栏里，直到重启生效。

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

“更新”页会列出有新版本的插件（版本列显示为 `1.2.1→1.3.0`）。索引缓存于 `$DSH_HOME/storages/mayfly-plugin-market/`，默认每小时刷新；获取失败时展示缓存目录，可在设置 `mayfly.marketIndexUrl` 换用镜像或私有市场。
