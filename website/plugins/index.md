# Mayfly 插件开发

Mayfly 插件就是普通 Cordis 插件。它直接使用 dsh 原生 service，并在需要终端
界面时注入 Mayfly 的四个 UI service。

```text
dsh 原生 service
commands · sessionProjections · tools · settings · ...
                         │
                  普通 Cordis 插件
                         │
Mayfly UI service
mayflyPanes · mayflyStatus · mayflyOverlays · mayflyEditorExtensions
```

Mayfly 官方包和外部插件同构：相同的 `name / inject / apply(ctx)`，相同的
service graph，相同的 Fiber unload 行为。没有专用 manifest、能力申请、
adapter facade 或插件作者 CLI。

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@ephemeral-ai/mayfly-ui'
import { ui } from '@ephemeral-ai/mayfly-ui'

export const name = '@acme/build-health'
export const inject = ['commands', 'mayflyPanes']

export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'health',
    description: 'Show build health',
    handler: () => ({ kind: 'success', text: 'healthy' }),
  })
  ctx.mayflyPanes.register({
    id: 'acme.build-health',
    placement: 'right',
    narrow: 'bottom',
  }, ui.text('healthy'))
}
```

从[快速开始](/plugins/quickstart)创建第一个包；原生 dsh API 以
[Harness reference](https://deepseek-harness.github.io/deepseek-harness/reference/)
为准，Mayfly UI 入口见 [Seam 参考](/plugins/seams)。
