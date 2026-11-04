# 功能总览

Mayfly 在 Harness `0.2.2-alpha.3` 上运行原生 dsh Host 与独立 Remote TUI，
各自拥有 Cordis tree。已发布的 `0.1.4-rc.2` 是外观、按键与工作流的不可改写参照。

## 数据与交互

- Harness 原生 `sessionProjections` 驱动 conversation、token/context、
  title 与 session facts。
- Host command 注册在原生 `commands`；Remote 本地分发前端命令，并通过官方 Client 发现 Session 原生命令。
- Remote 管理主会话与旁支会话的 HostKey + SessionRef 选择；Host 持有精确 Agent/Session domain 状态。
- transcript 与 interaction 不维护第二份 Agent/Session truth。

## 终端 UI

- core 是唯一 pi-tui/raw-terminal owner；
- status producer 直接注册到 `mayflyStatus`；
- activity、queue、todo、agents、workflow pane 直接注册到 `mayflyPanes`；
- BTW、subagent 与已存储的 child 都在同一个 transcript 面板中渲染；live 会话驱动完整主布局，cold/one-shot 会话从原生历史读取，标为只读或可恢复；
- Remote jobs footer、`/jobs` 与 `/agents` 消费原生 transport 事实和 focused Host DTO；
- overlay 由 `mayflyOverlays` 渲染；
- editor 扩展由 `mayflyEditorExtensions` 组合在唯一 Mayfly editor 周围。

外部插件与内置功能使用相同 service 和 Fiber lifecycle。

## 继续阅读

- [流式会话与工具卡片](/features/streaming)
- [输入编辑器](/features/editor)
- [审批与问卷](/features/approval)
- [状态栏](/features/status-bar)
- [可选 Agent Team](/features/team)
- [会话模式](/features/modes)
- [底部面板](/features/panes)
