# 快速开始

先确定插件运行在哪个进程。当前使用 Node `>=24.9.0`、仓库锁定的 pnpm 和
Harness `0.2.2-rc.1`；Cordis 版本与所选 Host/Remote release 的 peer 保持一致。

## Host 插件

Host 扩展是普通 ESM Cordis package，导出编译后的 `name`、可选 `inject` 和
`apply(ctx)`。原生服务用法见[命令](/plugins/commands)。可安装的 Host bundle
还需在 `package.json` 导出并发布其原生 `cordis.patch.yml`。

构建后，在已有的专用 Mayfly Host profile 上安装：

```sh
dsh plugin --profile mayfly-build-health add file:/absolute/path/to/host-plugin
dsh --profile mayfly-build-health
```

这条路径用于 Host 能力；它不会挂载 TUI 节点。

## TUI 源码集成

终端展示 entry 直接依赖四个 UI service，例如：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { ui } from '@ephemeral-ai/mayfly-ui'

export const name = '@acme/build-health-ui'
export const inject = ['mayflyStatus']

export function apply(ctx: Context): void {
  ctx.mayflyStatus.register({
    id: 'acme.build-health', priority: 30, band: 'right',
  }, ui.text('healthy', { tone: 'success' }))
}
```

把它组合进自己的 TUI 入口。`@ephemeral-ai/mayfly/bin` 的 `run` 就是 `mayfly`
命令本身，接受相同的选项和环境变量；插件在内置功能之后加载进 TUI 的 Cordis
树，并随 TUI 一同卸载：

```ts
import { run } from '@ephemeral-ai/mayfly/bin'
import * as buildHealth from '@acme/build-health-ui'

await run(process.argv.slice(2), { plugins: [buildHealth] })
```

与 `mayfly` 一样另外启动 Host，再用 Host 的 startup URL 运行这个入口：

```sh
dsh --profile mayfly-build-health
MAYFLY_DSH_STARTUP_URL='<Host URL>' node ./build-health-tui.js
```

`examples/mayfly-ecosystem` 是一个完整的组合。TUI 插件没有安装器或热加载：组合就是
一个普通程序。TUI 的树提供四个 UI service，但没有原生 dsh service；需要 Host 状态的
TUI 插件通过官方 Client 或 focused Mayfly Host DTO 获取事实，再发布 readonly 节点。
不要使用生产 `mayfly` 验收。
