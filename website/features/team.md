---
title: Agent Team
---

# Agent Team

Agent Team 是插件市场中的可选插件，提供独立的团队协作预设和 Mayfly 终端界面。
默认预设及现有预设保留普通委派能力，不会因为安装插件而自动开启 Team。

## 安装与使用

```text
/plugin install agent-team
```

安装后重启 Mayfly，新建会话，选择预设：

```text
/preset team
```

`team` 基于常规编码预设 `standard`；normal / plan 执行模式仍然独立。
随后明确要求 Lead 创建队友，例如：“请使用 Agent Team，创建 reviewer 审查权限、tester 检查测试，把工作记录在共享任务板，完成后汇总。”

## 终端界面

`/team` 查看成员和共享任务。宽终端并列显示两者，窄终端通过页签切换，保留筛选与选中项。
列表展示运行状态、任务负责人和依赖；写入范围重叠会出现在总览中。任务详情支持打开负责人的会话。
创建队友、成员通信和任务修改由原生 Agent 工具完成，面板保持只读。

选择队友进入其会话；F7 切换保留的主/辅助视图，F8 关闭辅助视图，关闭不会停止队友。
回复可选择“排队”（本轮结束后处理）或“引导”（下一步骤边界处理）。
未加载成员先展示历史，按 `i` 回复；发送才恢复该成员。草稿在渲染器重载后保留。

## 边界

队友共享工作目录；write scopes 是协作提示，不是文件锁。Team 不提供独立 worktree 或自动合并。
安装、移除和升级插件遵循现有 `/plugin` 的重启边界。移除插件不会删除保存的 Team 会话；恢复这类会话前需要重新安装插件。

插件源代码：[Ephemeral-AI-Lab/dsh-plugins](https://github.com/Ephemeral-AI-Lab/dsh-plugins/tree/main/plugins/mayfly-agent-team)。
