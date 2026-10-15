# 状态栏

`ctx.mayflyStatus.register(definition, initialNode)` 发布不可变状态 snapshot。

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@ephemeral-ai/mayfly-ui'
import { ui } from '@ephemeral-ai/mayfly-ui'

export const inject = ['mayflyStatus']

export function apply(ctx: Context): void {
  let healthy = true
  const status = ctx.mayflyStatus.register({
    id: 'acme.health',
    priority: 30,
    band: 'right',
    overflow: 'hide',
  }, ui.text('healthy', { tone: 'success' }))

  ctx.on('acme/health-changed', value => {
    healthy = value
    status.set(ui.text(healthy ? 'healthy' : 'failed', {
      tone: healthy ? 'success' : 'danger',
    }))
  })
}
```

Status node 只能使用非交互内容，并按 priority、id 排序。`set(null)`
释放 slot；`set(node)` 会复制并冻结 snapshot、递增 revision，且只使 FooterHost
失效。`dispose()` 提前移除 entry，Fiber unload 也会自动清理。

status 条目是不可交互的小标。行拥挤时它可以退回更窄的形态：发布
`ui.shed(full, [{ rank, node }])`，行会按 rank 从低到高（跨所有 shed 条目）依次放弃这些形态，`null` 形态表示隐藏条目，然后才按 priority 容纳。
若希望它拥有自己的面板，请改为注册视图：
[`views` pane](/plugins/ui-reference#状态栏的视图) 把 `summary` 放进状态栏，并在 `Alt+↓` 时打开其面板。
