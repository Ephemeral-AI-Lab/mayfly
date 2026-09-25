# `@ephemeral-ai/mayfly`

[English](README.md) | 中文

可安装的 dsh Mayfly 终端 UI bundle。它的 flat `cordis.patch.yml` 在
`dsh-base` 上增加普通 sibling：一组 dsh 支撑行和全部 Mayfly product
行。

插件直接继承 dsh 原生 service，并通过 `mayflyPanes`、`mayflyStatus`、
`mayflyOverlays` 与 `mayflyEditorExtensions` 贡献终端 UI。当前 Agent 由
`mayflyCurrentAgent` 提供。Mayfly 官方功能使用完全相同的 service。

`mayfly-cordis` preset 包含临时原型、普通持久 Cordis 插件开发与 composition
编辑 skill。不需要专用 Mayfly manifest、capability host、adapter 或插件作者
CLI。

Agent Team 由可选市场插件提供，新增基于 `standard` 的独立 `team` preset。
现有 preset 保留普通委派能力。Team 会话导航、提醒、交付文件和 MCP 资源见
[Harness 功能适配](../../docs/native-harness-adaptation.md)。
`mayfly.transcriptView` 替代原有的分类型显示设置。
