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

交互架构的历史设计依据见 [UI/UX 统一模型设计](./design/ui-ux-unification.zh.md)：涵盖通知、表单、列表、标签页、输入路由与提示的一致性审视、目标状态模型和迁移验收。当前候选实现以架构文档、公开类型和测试为准。

对应的 [交互重构实施计划](./design/ui-ux-implementation.zh.md) 列出协议固化、成对可编辑试点、通知/授权指引、分批迁移和发布验收的代码范围与门槛。

[PR #15 详细实现方案](./design/pr15-interaction-refactor-plan.zh.md) 记录基线问题、模型类型、消费者接入、并发回写、交互逻辑与 OAuth 生命周期，作为本次候选实现的设计记录。

候选工作树的最新状态见 [交互重构续做方案与当前核查](./design/ui-interaction-resume-plan.zh.md)，包含完成证据、剩余发布门禁与人工验收顺序；不代表已发布运行时行为。

具体执行顺序见 [交互模型完全迁移：20 步执行方案](./design/ui-interaction-migration-steps.zh.md)，包含各步修改范围、验证与完成条件，以及全部消费者和最终 profile 的验收边界。

[20 步完成审计](./design/ui-interaction-completion-audit.zh.md) 逐项列出当前权威证据与判定；Step 1 至 19 已完成，Step 20 正在执行验收后合并和清理。

插件作者应从 Website
[开发手册](../website/plugins/index.md) 开始，并以
[DeepSeek Harness reference](https://deepseek-harness.github.io/deepseek-harness/reference/)
为 dsh 原生服务依据。仓库维护规则见根 [AGENTS.md](../AGENTS.md) 与各包
`AGENTS.md`。
