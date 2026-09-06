# 功能总览

Mayfly `0.1.0-alpha.2` 是 `dsh-base` 上的 flat Cordis plugin tree。Bundle
插入 6 个 dsh 支撑 row 与 28 个 Mayfly row。

## 数据与交互

- Harness 原生 `sessionProjections` 驱动 conversation、token/context、
  title 与 session facts。
- 内置 command 直接注册在原生 `commands` service。
- app 持有主 Agent 与单辅助槽，并通过 `mayflyCurrentAgent` 共享当前展示的精确 identity。
- transcript 与 interaction 不维护第二份 Agent/Session truth。

## 终端 UI

- core 是唯一 pi-tui/raw-terminal owner；
- status producer 直接注册到 `mayflyStatus`；
- activity、queue、todo、agents、workflow pane 直接注册到 `mayflyPanes`；
- BTW 与 live continuable subagent 复用完整主布局；cold/one-shot child 使用 core-owned 只读 transcript panel；
- jobs footer、`/jobs` 与 `/agents` 直接消费 Harness 原生 service；
- overlay 由 `mayflyOverlays` 渲染；
- editor 扩展由 `mayflyEditorExtensions` 组合在唯一 Mayfly editor 周围。

外部插件与内置功能使用相同 service 和 Fiber lifecycle。

## 继续阅读

- [流式会话与工具卡片](/features/streaming)
- [输入编辑器](/features/editor)
- [审批与问卷](/features/approval)
- [状态栏](/features/status-bar)
- [会话模式](/features/modes)
- [底部面板](/features/panes)
