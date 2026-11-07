# Overlay 示例

这是一个 opt-in Mayfly 插件：它通过 `ctx.mayflyEditorExtensions` 注册编辑器
动作（`Alt+O`），动作直接通过 `ctx.mayflyOverlays` 打开 capturing modal。
modal 编辑一个两页设置表单，表单的值保存在插件 Fiber 中。

Connection 与 Workspace 页面分别保留草稿。Save 携带表单打开时的 snapshot
revision 提交修改的字段；从过期表单保存会得到冲突。Cancel 使用 Mayfly 共享的
未保存修改确认。插件只提供 readonly snapshot 和结构化 action 回执，草稿、焦点、
导航、提交锁和 modal 边框都由 Mayfly 持有。

```ts
import { run } from '@ephemeral-ai/mayfly/bin'
import * as overlay from '@mayfly-example/overlay'

await run(process.argv.slice(2), { plugins: [overlay] })
```

插件卸载时，编辑器动作和 overlay 随 Fiber 清理；下次加载重新从默认值开始。
