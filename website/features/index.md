# 功能总览

Mayfly `0.1.0-alpha.1` 是 `dsh-base` 上的 flat Cordis plugin tree。Bundle
插入 6 个 dsh 支撑 row 与 28 个 Mayfly row。

## 数据与交互

- Harness 原生 `sessionProjections` 驱动 conversation、token/context、
  title 与 session facts。
- 内置 command 直接注册在原生 `commands` service。
- app 只选择当前 Agent，并通过 `mayflyCurrentAgent` 共享精确 identity。
- transcript 与 interaction 不维护第二份 Agent/Session truth。

## 终端 UI

- core 是唯一 pi-tui/raw-terminal owner；
- status producer 直接注册到 `mayflyStatus`；
- activity、queue、todo、BTW、agents、workflow pane 直接注册到 `mayflyPanes`；
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
