# 底部面板

会话记录与输入编辑器之间是**底部 dock**：五个被动面板按优先级自上而下叠放——workflow → agents → todo → queue → activity，activity 行紧贴编辑器上方（状态栏仍在编辑器下方）。无内容时各面板渲染零行——dock 不会跳变。BTW 和 `/agents` 打开的会话不属于 pane：它们切换当前 Agent 或使用统一的只读会话 panel。

## Dock 行数预算

dock 最多占终端高度的三分之一。多个面板同时出现时共用一条分隔线，不再各画一条；行数按固定规则分配：先从最靠近编辑器的面板开始，保证每个面板至少有标题或汇总这一行，剩余行再按同样顺序轮流分配。内容超出配额的面板保留开头，末行显示灰色的 `… +K more rows`；面板之间不会从中间丢行，也不会互相穿插。面板的每一行都是单行——过长的内容以 `…` 截断而不换行。

## 活动面板（activity）

当前 Agent 唯一的实时状态行：会话记录只记录已经发生的事，这一行说明现在正在发生什么——spinner、现在时标签、回合耗时、token 计数（`↑` 上下文，`↓` 估算输出，字符数 / 4）、文本流式输出时的速率，以及轮换提示：

```
🌔 深度求索中 · 3s · 提示：…
⠋ 思考中 · 8s · ↓2 · ≈42 tok/s · 提示：…
⠋ 输出中 · 14s · ↓120 · ≈40 tok/s · 提示：…
🌔 正在运行命令 · 21s · ↑30k ↓4k · pnpm test
```

| 模式 | 呈现 |
| --- | --- |
| waiting | 月亮 spinner + `深度求索中`；工具调用参数仍在流式生成时显示准备标签（`准备写入文件`） |
| tool | 月亮 spinner + 正在运行的类别（`正在运行命令`、`正在读取文件`、`正在调用工具`）；派生 subagent 时保持 `深度求索中`，由 agents 面板展示 |
| thinking | braille spinner + `思考中` |
| composing | braille spinner + `输出中`——没有输出光标，这行就是"正在写"的信号 |
| stopping | 中断排空期间显示静态 `■ 正在中断...` |
| idle | 一行占位（dock 边缘稳定） |
| 对话框打开 | 整行隐藏（面板占据编辑器槽位时） |

Standard 模式下，提示的位置改为显示当前动作：命令、路径或查询（通用工具与 MCP 工具显示名称，如 `server › tool`），思考时显示最新一段思考内容。Compact 保持精简，Detailed 与 Verbose 已在会话记录中显示运行中的卡片，因此不附详情；文件写入与编辑的 diff 卡片已在屏幕上，同样不附详情。终端变窄时，这一行先舍弃尾部（过长的详情先截断再舍弃），再依次舍弃速率、计数、耗时，最后是标签；始终不换行。

## 排队消息面板（queue）

你在 agent 运行中提交的 follow-up 进入 harness inbox 排队——面板以 divider 起头、每条一行列出队列：等待下一 turn 的消息带 `Queued:` 前缀，转向当前 step 的消息带 `Steer:` 前缀（均只列用户消息）。队列空时零行。

↑/↓ 始终归编辑器历史浏览——queue 面板只展示排队消息，不接管按键（见[输入编辑器](/features/editor)）。

## todo 面板（todo）

会话的 todo 列表（整表快照，last-write-wins）在 kimi 风格的平线框下呈现：`Todo` 标题 + 三态点——`✓` 已完成（muted 加删除线）、`●` 进行中（primary 粗体）、`○` 待办。

- **五行折叠** —— 长列表先收全部进行中，再以最早的待办与最近的完成补足；footer 一行 `… +N more (2 done · 1 pending) · ctrl+t to expand` 统计隐藏项。
- **Ctrl-T** 在折叠/整表之间切换（`all N items · ctrl+t to collapse`）；展开态跨写入保留，会话切换或列表完结时复位。
- **全部完成自动收起**——下一次写入重新以折叠态打开。

- **中断的运行** —— 最近一次运行失败或被停止且列表未完成时，标题追加灰色的 `· interrupted`。
- **目标（goal）** —— 当前目标并入标题行：`Todo · ● active · 2/5 · <目标>`（截断为一行）；只有被阻塞的目标才额外占一行 `blocked:` 原因。

`todo_write` 调用在会话流里只作为单行过程成员出现（`✓ 更新了计划 · 已完成 3/5`）；这个面板是 todo 的实时呈现面。

## 辅助会话（/btw 与 /agents）

Mayfly 只保留一个辅助会话槽。`/btw <question>` 创建临时旁路 Agent——以当前会话的全量事件流为种子，并继承 provider、model、reasoning effort 和 agent preset。`/agents` 则打开当前主会话的完整 descendant 树：

- live BTW 或 continuable subagent 成为 `mayflyCurrentAgent.current()`，原有 transcript、status、底部 pane、命令和完整编辑器整体切到该 Session；BTW 仍继承完整主会话上下文，但 transcript 从 BTW 自己的第一条提问开始，隐藏 seed 历史；图片、follow-up、steer、撤回和中断都走同一输入链；
- one-shot 或当前不驻留的 continuable child 不激活 Agent，而是在 editor 槽位打开 core-owned 的全保真只读 transcript panel；它复用正式 transcript model、工具呈现、图片加载、宽度约束与滚动逻辑；
- 状态栏中央显式显示当前侧以及 `F7 switch · F8 close`；`F7` 在主/辅助会话间切换，`F8` 完全关闭辅助视图并返回主会话；关闭普通 subagent 只 detach，关闭 BTW 会 dispose 临时 Agent；
- 再次打开 BTW 或 child 会替换旧辅助槽。无参 `/btw` 关闭当前 BTW；`/new`、`/resume`、`/fork`、`/rewind` 和 `/agents` 浏览会先回到主会话；
- `/agents` 中 `Enter` 查看 child，`Space` 或 `←` / `→` 展开分支，`Tab` 到 **Stop selected**，停止 live continuable child 前会弹出 Yes / No 确认（默认聚焦 No）。对 one-shot、cold/inactive 或仍有 live 后代的 child，Stop 会直接说明为何不可用而不弹确认。`/agents stop <id>` 提供直接停止路径。Harness 销毁 Agent 时会递归销毁它拥有的 live 后代，因此 Mayfly 对仍有 live 后代的目标直接拒绝，要求先从叶子节点开始停止。

## 子代理分组面板（agents）

agent 派生的**子代理组**（subagent group）运行时，组卡片留在 dock 中、位于 todo 面板上方（kimi swarm-pane 语义）。spawn 类调用（`subagent` 与任意 `subagent_*` provider）以单行成员出现在会话流里，在结束后的回合标题中计为 subagent，结束后并入分组标题（`已协调子智能体`）；activity 行把它们交给本面板展示。只有本面板实时展示每个子代理：任务、阶段、模型、effort、估算输出（`↓`，字符数 / 4）、工具数、已用时间、token 与当前活动。汇总行只在阶段不一致时附阶段分布，只在多个子代理时附整组用时。已结束的组保留到下一个回合开始；回合结束时仍未得到结果的调用显示 `cancelled`，不会永远显示运行中。

子代理增多时卡片保持紧凑：每个成员只占一行并截断；超过三个成员时，运行中的成员排在前面，当前活动并入该成员行的末尾而不再单独占一行（失败的成员仍保留 `Error:` 行）；超过六个成员时，卡片保留全部运行中的成员，再补上最近结束的成员，最后以 `└─ … +K more (3 done, 1 failed)` 收尾。汇总行的计数始终覆盖整组。

## Workflow 面板

原生 `workflow/*` lifecycle 归因到当前 Agent 后，面板显示 workflow 名称、当前 phase、运行/完成/失败的子 Agent 树与逐秒 elapsed。与 agents 卡片一样，超过六个子 Agent 的运行先列出运行中的子 Agent，其余在末行 `… +K more` 中计数。运行结束的摘要会保留到下一次相关状态替换；切换主/辅助 Agent 时，面板与其他 session-scoped UI 一起切换。
