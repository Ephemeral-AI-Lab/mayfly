# 会话模式

Mayfly 的计划状态与权限设置相互独立。编辑器焦点下按 **`Shift+Tab`** 只切换：

**normal ↔ plan**

YOLO 通过独立的 `/permission` 命令选择，可以与 plan 同时开启。状态栏第一行同时显示 `plan`（accent 色）与 `yolo`（warning 色）；计划状态切换待生效时显示 `plan...`。这些状态来自 dsh：plan 来自原生 `plan` projection，yolo 表示 `danger-full-access` + `never` 权限预设。

## normal

计划模式未开启。默认权限是 `workspace-write` + `ask`：工作区内操作按原生工具策略执行，需要审批的操作显示四选项审批面板（见[审批与问卷浮层](/features/approval)）。从 plan 返回 normal 保留当前权限，包括已经开启的 YOLO。

## plan —— 先规划，后动手

plan 模式向 agent 提供先规划、后执行的协作指引，不改变工具权限或文件沙箱。它是软性指引，即使与 YOLO 叠加也不构成只读限制。计划定稿时，harness 的 `exit_plan_mode` 请求以**计划评审面板**呈现（编辑器槽位替换，同审批面板的挂载方式）：

- 计划全文以 Markdown 渲染在带边框的 `plan` 盒内；
- 下方是编号决策列表，数字键直选或 ←→ + `Enter`；↑↓ / PageUp / PageDown 只滚动计划正文：

| 选项 | 效果 |
| --- | --- |
| `1. Approve` | 批准计划，退出 plan 模式开始执行，保留当前权限 |
| `2. Reject` | 拒绝——模型收到"用户选择继续规划"，在同一轮内回应 |
| `3. Revise <text>` | 内联修改：带上你的意见继续打磨计划 |

## yolo —— 完全访问

通过 `/permission danger-full-access` 进入 YOLO，通过 `/permission workspace-write` 恢复默认权限；裸 `/permission` 打开权限选择器。Mayfly 不注册额外的 `/yolo` 或 `/yes` 命令。

YOLO 关闭文件沙箱并使用 `never` 审批策略：需要审批的请求直接拒绝，不弹审批面板；不需要审批的操作可以直接执行。**用户提问与计划评审仍然弹出**，因为权限策略不会替你回答问题或批准计划。

`Shift+Tab` 只执行 `/plan` 或 `/plan off`，不会进入或退出 YOLO。`/permission` 也不会关闭计划状态。例如，进入 YOLO 后按 `Shift+Tab`，状态栏显示 `plan yolo`；再次按键只结束规划，保留 `yolo`。若 Agent 预设没有提供计划能力，快捷键会提示不可用。

::: tip 与 /preset 的关系
plan 模式由 harness 的 plan-mode 插件提供，经 Agent 预设组合（`/preset`，见[斜杠命令参考](/reference/commands)）。Agent 预设决定能力集合；`/plan` 控制规划协作状态；`/permission` 控制沙箱与审批策略。
:::
