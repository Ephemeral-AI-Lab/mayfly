---
title: 提交你的插件
---

# 提交你的插件

## 前提

1. 按开发手册的[发布指南](/plugins/publishing)把插件发布为普通 Cordis 包：
   - `package.json` 声明 `dsh.bundle.patch`（自激活 bundle），或可经 profile patch 行组装；
   - 安装产物内含 `cordis.patch.yml` 与构建输出（npm 包随 `files` 分发；GitHub 源需提交 `lib/`——git 安装装的是源码树）。
2. 准备双语一句话描述、能力披露（shell/网络/凭据等）、以及工具与命令清单。

## 流程

1. 复制[市场仓库](https://github.com/Ephemeral-AI-Lab/dsh-plugins)的 `registry/submission-template.json` 为 `registry/community/<slug>.json` 并填写；
2. 提 PR 到市场仓库；CI 会做机器门禁（schema 校验、npm 存在性、tarball 体检、GitHub 源 scratch 安装）；
3. 在**你自己的仓库**开 issue 或评论链接该 PR，作为收录授权证据（防冒名）；
4. 维护者按[审查清单](/market/review)人工过审，合并即收录；`index-publish` 工作流自动重建索引，本站详情页在重建后出现。

## 规则摘要

- 一个插件一个 manifest；`id` 永久占用，撤回请置 `status: removed` 并写明原因，不要删文件。
- npm 源优先；未发布 npm 的包可用 GitHub 源，`ref` 建议 pin 到 commit。
- `surfaces` 如实声明；`capabilities` 是给审查者和用户看的披露，不是运行时授权。

Manifest 字段说明见 [Manifest 规范](/market/manifest)。
