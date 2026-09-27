# 编辑器扩展

`mayflyEditorExtensions` 在 Mayfly 持有的唯一 editor 周围增加被动 UI、诊断、
action、completion 与 submit transform；它不替换 editor engine。

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@ephemeral-ai/mayfly-ui'
import { ui } from '@ephemeral-ai/mayfly-ui'

export const inject = ['mayflyEditorExtensions']

export function apply(ctx: Context): void {
  ctx.mayflyEditorExtensions.register({
    id: 'acme.issue-links',
    priority: 20,
    complete: request => request.trigger === '#'
      ? [{ id: 'issue-123', label: '#123', insertText: '#123' }]
      : [],
    transformSubmit: request => ({ text: request.text.trim() }),
  }, {
    hint: '#123 links an issue',
    before: ui.text('Issue helper', { tone: 'muted' }),
  })
}
```

Callback context 带 `AbortSignal`、surface id 与 revision。异步 completion
最长 5 秒，submit transform 最长 30 秒；unload、selection/renderer generation
变化或 abort 后的迟到结果会丢弃。

Extension node 是受限的非 editor-control tree。Render/event/diagnostic/action
内容会再次校验。Registration 提供 `set(decoration)/dispose()` 并随 Fiber 清理。

## 按键与动作

编辑器独占其槽位内的所有按键：Escape（中断、撤回、清空）、Tab（补全）、
Shift+Tab（切换计划状态）、方向键以及所有输入字符——即使周围显示着装饰或通知也是如此。
因此装饰上的 `actions` 只能通过其 `key` 触发，且必须是 `alt+r`、`ctrl+shift+k`
这类组合键。没有 key、使用纯字符键，或 key 已被其他 Mayfly 绑定或更早的装饰占用的
action 会被省略，并给出提示：

```ts
ctx.mayflyEditorExtensions.register({ id: 'acme.issue-links' }, {
  hint: 'Alt+I 插入当前 issue',
  actions: [{ id: 'insert-issue', label: 'Insert issue', key: 'alt+i' }],
})
```
