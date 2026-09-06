# Mayfly 文档索引

当前运行时只有两份架构文档：

- [mayfly-architecture.md](./mayfly-architecture.md)：包边界、状态所有权和 flat
  Cordis composition。
- [mayfly-seams.md](./mayfly-seams.md)：dsh 原生服务、Mayfly UI 服务与
  `mayflyCurrentAgent` 的使用边界。

发布维护见 [package-release.md](./package-release.md)。既有版本说明位于
`release-notes/`，历史调研与验收记录位于 `history/`；这些文件只描述其
当时时点，不定义当前 API。

跨平台自动化与桌面验收清单见 [platform-acceptance.md](./platform-acceptance.md)。

交互架构提案见 [UI/UX 统一模型设计](./design/ui-ux-unification.zh.md)：涵盖通知、表单、列表、标签页、输入路由与提示的一致性审视、目标状态模型和迁移验收。该提案尚未实施，不定义当前运行时行为。

插件作者应从 Website
[开发手册](../website/plugins/index.md) 开始，并以
[DeepSeek Harness reference](https://deepseek-harness.github.io/deepseek-harness/reference/)
为 dsh 原生服务依据。仓库维护规则见根 [AGENTS.md](../AGENTS.md) 与各包
`AGENTS.md`。
