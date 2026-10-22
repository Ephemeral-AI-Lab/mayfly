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
upsert/remove delta 通知 core。Pane、overlay 与 editor-extension 事件可以把
callback 的 `context.revision` 作为 `eventRevision` 回写；renderer 将其视为同一
操作的 internal refresh，而外部替换会 abort 旧 continuation。
Pane/status 的 null snapshot 不占布局；overlay 提供 `focus/hide/show/close`。即使调用方不手动 dispose，
Cordis Fiber unload 也会清理 registration。

## 当前 Agent

`@ephemeral-ai/mayfly/app` 提供：

```ts
const agent = ctx.mayflyCurrentAgent.current()
if (agent !== null) {
  const cut = ctx.sessionProjections.snapshot(agent.session, ['myProjection'])
}
```

`current()` 返回 `Agent | null`，`subscribe()` replay 当前 selection 并
观察后续 revision。只有 registry 中仍存活的精确 Agent 能被选中；Agent dispose
会清空 selection。

需要 Agent identity 的插件 inject `mayflyCurrentAgent`。只贡献静态 UI 的插件
不应增加这一依赖，因为 app 或 core reload 时 Cordis 会按依赖关系卸载 consumer。

## 生命周期

所有 service 位于同一 Cordis graph。注册重复 id 或无效 definition 会直接抛出；
dsh command handler 保持 dsh 自己的返回类型。没有 grant、manifest admission、
gesture token、owner generation、buffer replay 或跨 realm proxy。

Renderer 暂时缺位时 registry snapshot 仍可存在；renderer 恢复后通过
`subscribe()` replay 当前 upsert。外部插件卸载时 provider 发布 remove delta。
