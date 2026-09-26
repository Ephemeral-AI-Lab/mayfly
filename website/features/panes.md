# 底部面板

状态栏与输入编辑器之间是**底部 dock**：五个被动面板按优先级依次叠放（activity → queue → todo → agents → workflow，编辑器最后）。无内容时各面板渲染零行——dock 不会跳变。BTW 和 `/agents` 打开的会话不属于 pane：它们切换当前 Agent 或使用统一的只读会话 panel。

## 活动面板（activity）

挂在会话事件流上的模式机，告诉你 agent 现在在干什么：

| 模式 | 呈现 |
| --- | --- |
| waiting | 月亮 spinner + 轮换教学提示（loading 种类变化时换提示） |
| tool | 月亮 spinner + 正在运行的工具名（MCP 工具显示为 `server › tool`）；派生 subagent 时不显示工具名，由 agents 面板展示 |
| thinking | braille `thinking...` 行，附本阶段的 token 计数与速率——会话流中的思考块只显示已用时间，这行是唯一的 spinner 与吞吐读数，回合中途 dock 不会收缩 |
| composing | braille `working...` 行（primary 色帧 + 随行提示）——没有输出光标，这行就是"正在写"的信号 |
| idle | 一行占位（dock 边缘稳定） |
| 对话框打开 | 整行隐藏（面板占据编辑器槽位时） |

## 排队消息面板（queue）

你在 agent 运行中提交的 follow-up 进入 harness inbox 排队——面板以 divider 起头、每条一行列出队列：等待下一 turn 的消息带 `Queued:` 前缀，转向当前 step 的消息带 `Steer:` 前缀（均只列用户消息）。队列空时零行。

↑/↓ 始终归编辑器历史浏览——queue 面板只展示排队消息，不接管按键（见[输入编辑器](/features/editor)）。

## todo 面板（todo）

会话的 todo 列表（整表快照，last-write-wins）在 kimi 风格的平线框下呈现：`Todo` 标题 + 三态点——`✓` 已完成（muted 加删除线）、`●` 进行中（primary 粗体）、`○` 待办。

- **五行折叠** —— 长列表先收全部进行中，再以最早的待办与最近的完成补足；footer 一行 `… +N more (2 done · 1 pending) · ctrl+t to expand` 统计隐藏项。
- **Ctrl-T** 在折叠/整表之间切换（`all N items · ctrl+t to collapse`）；展开态跨写入保留，会话切换或列表完结时复位。
- **全部完成自动收起**——下一次写入重新以折叠态打开。

- **中断的运行** —— 最近一次运行失败或被停止且列表未完成时，标题追加灰色的 `· interrupted`。

`todo_write` 调用在会话流里只作为单行过程成员出现（`✓ 更新了计划 · 已完成 3/5`）；这个面板是 todo 的实时呈现面。

## 辅助会话（/btw 与 /agents）

Mayfly 只保留一个辅助会话槽。`/btw <question>` 创建临时旁路 Agent——以当前会话的全量事件流为种子，并继承 provider、model、reasoning effort 和 agent preset。`/agents` 则打开当前主会话的完整 descendant 树：

- live BTW 或 continuable subagent 成为 `mayflyCurrentAgent.current()`，原有 transcript、status、底部 pane、命令和完整编辑器整体切到该 Session；BTW 仍继承完整主会话上下文，但 transcript 从 BTW 自己的第一条提问开始，隐藏 seed 历史；图片、follow-up、steer、撤回和中断都走同一输入链；
- one-shot 或当前不驻留的 continuable child 不激活 Agent，而是在 editor 槽位打开 core-owned 的全保真只读 transcript panel；它复用正式 transcript model、工具呈现、图片加载、宽度约束与滚动逻辑；
- 状态栏中央显式显示当前侧以及 `F7 switch · F8 close`；`F7` 在主/辅助会话间切换，`F8` 完全关闭辅助视图并返回主会话；关闭普通 subagent 只 detach，关闭 BTW 会 dispose 临时 Agent；
- 再次打开 BTW 或 child 会替换旧辅助槽。无参 `/btw` 关闭当前 BTW；`/new`、`/resume`、`/fork`、`/rewind` 和 `/agents` 浏览会先回到主会话；
- `/agents` 中 `Enter` 查看 child，`Space` 或 `←` / `→` 展开分支，`Tab` 到 **Stop selected**，停止 live continuable child 前会弹出 Yes / No 确认（默认聚焦 No）。对 one-shot、cold/inactive 或仍有 live 后代的 child，Stop 会直接说明为何不可用而不弹确认。`/agents stop <id>` 提供直接停止路径。Harness 销毁 Agent 时会递归销毁它拥有的 live 后代，因此 Mayfly 对仍有 live 后代的目标直接拒绝，要求先从叶子节点开始停止。

## 子代理分组面板（agents）

agent 派生的**子代理组**（subagent group）运行时，组卡片钉在编辑器正上方——dock 的最后一行（kimi swarm-pane 语义）。spawn 类调用（`subagent` 与任意 `subagent_*` provider）以单行成员出现在会话流里，在结束后的回合标题中计为 subagent，运行中的过程标题只显示 `正在协调子智能体`。只有本面板实时展示每个子代理：任务、阶段、模型、effort、估算输出（`↓`，字符数 / 4）、工具数、已用时间、token 与当前活动。汇总行只在阶段不一致时附阶段分布，只在多个子代理时附整组用时。已结束的组保留到下一个回合开始；回合结束时仍未得到结果的调用显示 `cancelled`，不会永远显示运行中。

## Workflow 面板

原生 `workflow/*` lifecycle 归因到当前 Agent 后，面板显示 workflow 名称、当前 phase、运行/完成/失败的子 Agent 树与逐秒 elapsed。运行结束的摘要会保留到下一次相关状态替换；切换主/辅助 Agent 时，面板与其他 session-scoped UI 一起切换。
