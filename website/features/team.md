---
title: Agent Team
---

# Agent Team

Agent Team 已内置于 Mayfly 默认分发。正常启动即可，无需单独的 Team profile 或可选 bundle。

```sh
mayfly
```

在对话中明确要求 Lead 使用 Agent Team，例如：“请使用 Agent Team 对仓库做只读审查，创建两个队友分别检查架构和测试，并把任务放进共享任务板。”普通请求不会自动创建队友。

面板对齐官方 Web 行为：`/team` 查看成员与共享任务，选择成员进入其会话。创建队友、消息协调和任务更新由原生 Agent 工具负责。各个内置 preset 使用原生 Team 工具，并保留其余能力差异。

F7 切换保留的会话，F8 关闭辅助视图。cold continuable 历史支持 `i` 回复；只有 Send 才恢复子 Agent。回复草稿可跨渲染器重载保留。任务 write scopes 仅为协作提示，队友共享工作目录。

插件管理继续使用原来的 `/plugin` 插件市场，安装或移除后仍需重启。
