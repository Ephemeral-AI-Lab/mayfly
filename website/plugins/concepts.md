# 核心概念

## 两个 Cordis tree

原生 Host 持有 Agent、Session 和 domain service。独立 Remote TUI 持有 Client
连接、HostKey + SessionRef 选择、交互状态与终端渲染。每一侧的插件都使用普通
Cordis 注入，`inject` 决定启动依赖与 reload 边界。

## Fiber 是生命周期

Command、pane、status、overlay 与 editor extension registration 绑定调用方
Fiber。其他 subscription、timer、外部 listener 与异步工作也必须释放，并防止
abort、切换、同名重新打开和 unload 后的迟到结果影响下一代状态。

## 原生 domain，Mayfly 展示

Host 插件直接消费公开 dsh service。原生命令的 handler 从
`invocation.agent` 取得本次调用的精确 Agent；Agent 作用域操作使用该 Agent，
不借用父 Agent 或全局工具视图。

TUI 使用官方 Client 的完整投影和原生 Remote 写入。Remote 保存选择身份，不保留
跨进程的 Agent/Session。共享 renderer 不提供当前 Agent facade，插件也不创建第二份
持久 domain store。补充方法放在 Mayfly Host，传递可序列化 DTO。

## 渲染无关的节点

UI contribution 返回 readonly `MayflyUiNode`。插件不 import pi-tui、不拼 ANSI、
不读取终端宽度。Core 统一校验、布局、theme、focus 与 terminal safety。

## 失败语义

原生 service 保留自己的结果与异常。Mayfly registry 对无效 id、缺失 callback
与 duplicate id 直接抛错。Observations 只报告事实；actions 返回 structured reply，
先接纳 acknowledgement 再结算原生请求。registration handle 提供 `set()/dispose()`，
overlay 另有 `close()`。
