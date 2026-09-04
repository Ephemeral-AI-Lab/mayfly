---
title: 审查清单
---

# 审查清单

收录审查在市场仓库的 PR 上进行，清单原文：[`registry/review-checklist.md`](https://github.com/Ephemeral-AI-Lab/dsh-plugins/blob/main/registry/review-checklist.md)。摘要：

## 机器门禁（CI 自动）

- schema 校验通过；`id` 唯一；`source` 与目录一致；`surfaces.tui` 声明时必有 `engines.mayfly`；
- 每个 npm 行在 registry 存在，最新 tarball 体检（`cordis.patch.yml`、`dsh.bundle.patch`，或行声明为 `activation: profile-patch`）；
- 每个 GitHub 行 scratch 安装通过，装出的包带 `dsh.bundle.patch` 与构建产物；
- 安装期脚本（postinstall 等）与原生二进制被标记给人工审查。

## 人工审查（合并前）

- PR 作者控制该包（其仓库的授权链接），或作者明确同意收录；
- 描述与 `surfaces`、`provides`、`capabilities` 如实（对照源码 grep 工具与命令名）；
- 卸载干净：Cordis Fiber 卸载后命令/UI/监听全部消失（源码用 `ctx.effect`/disposer，无全局态）；
- `verified.at` 为审查当日，`verified.packages` 记录精确版本；GitHub-only 条目 pin 了 commit。

## 合并后

- `index-publish` 工作流自动重建 `dist/`（经自动合并 PR）并触发本站重建；
- 每周巡检标记新版本 `updateAvailable`，复审 diff 后清除标记。

## 下架

- 置 `status: deprecated/removed` 并写 `statusNote`，**不删文件**；
- 因安全原因下架的，在说明中直说。
