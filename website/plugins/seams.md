# Service seam 参考

## Host 原生服务与 Remote

Host 插件直接 inject `commands`、`sessionProjections`、`tools`、`settings`、
`skills`、`sessionController` 等公开 dsh service。Agent 作用域操作必须使用本次调用
对应的精确 Agent；例如命令 handler 的 `invocation.agent`。

Remote TUI 使用官方 Client/Remote 的 Session face、完整投影和原生文件路由。
原生 transport 缺少的展示查询与受保护写入由 Mayfly Host 的 `mayflyHost` 方法补充；
DTO 只包含可序列化事实。它不是任意 service、文件系统或工具调用入口。

`statsHistory` 在当前工作区与全部工作区模式下都要求 Host 全局授权；单个 Session
的授权只允许读取它自己的统计。原始 settings 文档保存与原生配置写入共享 profile
锁，在锁内比较 revision 并原子替换。此保护不覆盖无视该锁、在最终检查后写入的
外部编辑器。

## TUI 的四个 UI service

| Service | 写入 | 消费方 |
| --- | --- | --- |
| `mayflyPanes` | `register(MayflyPaneDefinition, MayflyUiNode)` | Core surface renderer |
| `mayflyStatus` | `register(MayflyStatusDefinition, MayflyStatusNode)` | transcript footer |
| `mayflyOverlays` | `open(MayflyOverlayDefinition, MayflyUiNode)` | Core overlay renderer |
| `mayflyEditorExtensions` | `register(MayflyEditorExtensionDefinition, MayflyEditorDecoration)` | editor shell |

`@ephemeral-ai/mayfly-ui` 提供 Context declaration merge、契约与纯 builder。Host
插件和原生浏览器 client half 不能注入这些前端本地 registry。当前 TUI 扩展需要源码
集成并重启，不支持通过 `/plugin` 安装或动态热挂载。

## 选择与通知

Remote 管理 HostKey + SessionRef 及可写、可恢复、只读会话状态。切换与断开连接
使旧 generation 的读取、订阅与写入回复失效。Agent/Session 不跨进程；共享包没有
公共当前 Agent 或会话导航 facade。

需要共享通知 owner 的 TUI source consumer 显式提供 scope callback：

```ts
import { createInteractionNotificationOwner } from '@ephemeral-ai/mayfly/frontend'

const notifications = createInteractionNotificationOwner(ctx, 'acme.health',
  () => ({ kind: 'app', targetId: 'acme.health' }))
```

Session 通知由 consumer 的 callback 返回当前 `MayflyUiScope`；consumer 自己管理
Host/Session 选择及其生命周期，helper 不查找原生 Agent。

## 生命周期

所有 registration 绑定 consumer Fiber。Registry 与前端交互状态在 Core/theme
reload 时保留；重挂的 renderer 重新读取当前 snapshot。卸载 contribution 则移除
registration 并撤销未完成回复。草稿、确认、分页和语义焦点属于 frontend；ANSI、
可见宽度、终端 handle、布局与渲染缓存属于 Core。
