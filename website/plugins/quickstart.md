# 快速开始

先确定插件运行在哪个进程。当前使用 Node `>=24.9.0`、仓库锁定的 pnpm 和
Harness `0.2.2-alpha.2`；Cordis 版本与所选 Host/Remote release 的 peer 保持一致。

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

在专用 worktree 的 Remote composition 中通过普通 `ctx.plugin(entry)` 挂载，
构建后启动对应 Host/TUI：

```sh
PROFILE=mayfly-build-health script/install-dev.sh
dsh --profile mayfly-build-health
MAYFLY_DSH_STARTUP_URL='<Host URL>' script/mayfly-remote.sh
```

当前没有公共的外部 TUI 插件安装或热加载入口。依赖 Host 状态时，Remote consumer
通过官方 Client 或 focused Mayfly Host DTO 获取事实，再把 readonly 节点交给 UI。
修改源码后 rebuild；依赖变化后重新安装专用 profile。不要使用生产 `mayfly` 验收。
