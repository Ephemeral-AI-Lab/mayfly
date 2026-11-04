# Mayfly 插件开发

Mayfly 使用两个独立的 Cordis tree：原生 dsh Host 和 Remote TUI。插件仍是普通的
`name / inject / apply(ctx)` entry，但依赖必须来自它所在的进程。

| 位置 | 可用服务 | 安装与运行 |
| --- | --- | --- |
| Host | 原生 commands、sessionProjections、tools、settings 等 | 原生 Host bundle 与 plugin manager |
| Remote TUI | 官方 Client、前端状态与四个 Mayfly UI service | 当前需要源码集成到 Remote composition，构建并重启 TUI |

需要 Host 数据的 TUI 功能使用官方 Client/Remote 及可序列化 DTO。Agent、Session、
Tool Definition、回调与 renderer 对象不跨进程。补充 transport 能力由 Mayfly Host
完成，使用公开原生 API，不修改 dsh 上游。

下面是集成到 Remote composition 的静态 UI 插件：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { ui } from '@ephemeral-ai/mayfly-ui'

export const name = '@acme/build-health'
export const inject = ['mayflyPanes']

export function apply(ctx: Context): void {
  ctx.mayflyPanes.register({
    id: 'acme.build-health',
    placement: 'right',
    narrow: 'bottom',
  }, ui.text('healthy'))
}
```

Host plugin 安装不会自动挂载 TUI 界面。共享 `@ephemeral-ai/mayfly` 提供 renderer
与只读展示 subpath，不发布根插件、Host patch 或 preset。

从[快速开始](/plugins/quickstart)选择 Host 或 TUI 集成路径；原生 API 以
[Harness reference](https://deepseek-harness.github.io/deepseek-harness/reference/)
为准，Mayfly UI 入口见 [Seam 参考](/plugins/seams)。
