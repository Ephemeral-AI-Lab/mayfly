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
    row: 1,
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
