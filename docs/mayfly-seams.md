# Mayfly service seams

Mayfly 2.0 不再定义 capability facade。插件依据 Harness reference 直接声明并
消费需要的 dsh service。

## dsh 原生服务

常见依赖包括：

| Service | 用途 |
| --- | --- |
| `commands` | 注册和执行 dsh command |
| `sessionProjections` | 注册 projection，或对一个 Agent 的 Session 读取 snapshot |
| `tools` | 使用 dsh tool registry |
| `agents`、`sessionController` | Agent/session 生命周期 |
| `settings`、`skills` | 对应 dsh feature 的原生能力 |
| `plan` projection、`/plan` command | 跨 Agent realm 读取和修改 plan 状态 |

Mayfly 不包装这些接口，也不把它们改写为另外一种 result/error taxonomy。
与 `planMode` 同 realm 组装的插件仍可直接 inject 该原生 service；根级 Mayfly
插件不穿透 Agent 私有 realm，而是直接使用 Harness 为此提供的 projection 与
command。

## Mayfly UI 服务

| Service | 注册形态 | Renderer |
| --- | --- | --- |
| `mayflyPanes` | `register(definition, node)` / `set(node \| null)` | core 的 header/left/right/bottom lanes |
| `mayflyStatus` | `register(definition, node)` / `set(node \| null)` | transcript footer |
| `mayflyOverlays` | `open(definition, node)` / `set(node)` | core overlay stack |
| `mayflyEditorExtensions` | `register(definition, decoration)` / `set(decoration)` | interaction editor |

这些服务由 `@ephemeral-ai/mayfly-ui` 提供。贡献使用 renderer-neutral
`MayflyUiNode`，可由 `@ephemeral-ai/mayfly-ui` 构造。core 在渲染前执行 schema、
quota、控制字符与宽度校验。

插件不需要选择 eager 或 lazy 模式：大型 `list.items` 仍是普通 readonly
数组，core 只校验、编译和绘制当前 viewport 邻域；带 `when` 的隐藏子树在首次
可见时才进入完整 admission。列表条目的局部错误由对应禁用行承载，响应式分支
的错误限制在该分支内。其他非虚拟化集合继续使用类型化 quota。Mayfly 不公开
range、overscan、cache、measurement 或 scroll controller API，插件仍负责自身
的网络与数据库取数。

Provider 在 snapshot 成功冻结后为每次 `set()` 生成单调 revision，并通过
upsert/remove delta 通知 frontend owner 与 core。`set(node, { reason: 'data',
source })` 发布权威数据刷新；`reason: 'replace'` 建立新的 instance 边界，也是唯一
允许改变 `scope` 的更新。旧 `eventRevision` 参数已经删除，插件不能自行制造 ack。

Pane、overlay 与 editor extension 的 `onEvent` 分为 `observe` 和 `action`。
`observe` 只接收 value、selection toggle 与 tab change 事实，不能发布 snapshot、
导航或关闭 surface；`action` 处理 activate、selection accept、submit 与 dismiss，
每个已处理动作必须返回 `accepted`、`invalid`、`conflict`、`failed`、`completed`
或 `cancelled` 的结构化回执。`MayflyUiEventContext` 提供当前 `source`、operation ID、
revision、AbortSignal 与 progress reporter。

`accepted` 及带 `acceptedFields` 的 partial failure 由 registration-bound endpoint
生成一次性 publisher。Core 先准入回包，再由 publisher 以 ack 更新原 registration；
data/replace、卸载、abort 或同名重开会撤销不再有效的 handler、reporter 和 publisher。
表单草稿、single-flight、冲突、确认、页面与反馈属于 frontend interaction owner，
不要求插件在 handler 内回声调用 `set()`。

Pane/status 的 null snapshot 不占布局；overlay 提供
`focus/hide/show/close`，`presentation: 'editor'` 使用现有 editor host。
即使调用方不手动 dispose，Cordis Fiber unload 也会清理 registration。

## 当前 Agent

`@ephemeral-ai/mayfly/app` 提供：

```ts
const agent = ctx.mayflyCurrentAgent.current()
if (agent !== null) {
  const cut = ctx.sessionProjections.snapshot(agent.session, ['myProjection'])
}
```

`current()` 返回当前展示的 `Agent | null`，`primary()` 保留主会话；
`subscribe()` replay 精确 Agent selection。`view()` / `subscribeView()` 暴露一个
主会话加一个辅助槽的 readonly metadata，以及当前展示侧和
`interactive | readonly` access。只有 registry 中仍存活的精确 Agent 能进入
`current()`：live BTW/continuable child 直接驱动整套既有 UI，one-shot 或 cold
child 保留主 Agent 并交给通用只读 transcript panel。`F7` 切换显示侧，`F8`
关闭辅助槽；关闭 BTW 会额外释放其临时 Agent，关闭普通 subagent 只 detach。
BTW 的 seed 只用于模型上下文；其 `transcriptAfterSeq` cutoff 让用户看到的流从
BTW 自己的第一条提问开始，不重复主会话历史。

用户中断当前 Agent 时，Mayfly 同步遍历 live `agents` 的 `parentSession` lineage，并通过
`subagents.interrupt(..., { kind: 'ancestor', agent })` 向所有 running continuable
后代发出中断。该操作只取消当前 turn，保留 Activation 与未领取 inbox；它不使用
会递归销毁子树的 drain API。

需要 Agent identity 的插件 inject `mayflyCurrentAgent`。只贡献静态 UI 的插件
不应增加这一依赖，因为 app 或 core reload 时 Cordis 会按依赖关系卸载 consumer。

## 生命周期

所有 service 位于同一 Cordis graph。注册重复 id 或无效 definition 会直接抛出；
dsh command handler 保持 dsh 自己的返回类型。没有 grant、manifest admission、
gesture token、owner generation 或跨 realm proxy。Editor replacement 使用
`presentation: 'editor'` 的普通 overlay；registry 保留 registration，core 在
theme/input host 重建后重新投影同一 frontend instance 与语义焦点。

Renderer 暂时缺位时 registry snapshot 仍可存在；renderer 恢复后通过
`subscribe()` replay 当前 upsert。外部插件卸载时 provider 发布 remove delta。
Overlay registration 的 title 提供宿主外框；根节点若已是 `chrome: 'overlay'` 的
surface，core 将两者合并为一个外框。普通 overlay 与 `presentation: 'editor'` 都遵守
`maxHeight`，未声明时最多使用终端高度的三分之一；短内容保持自然高度。
