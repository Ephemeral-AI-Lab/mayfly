# 创造模式实战

`mayfly-cordis` 是 Host 注册的原生 Agent preset。它使用 Harness
`0.2.2-rc.1` 的 Cordis 工具与服务，并说明 Host/TUI 的进程边界。

1. 用 `cordis_inspect_list` 查找当前 service、event 与 tool provider。
2. 用 `cordis_inspect_query` 检查精确公开 method schema。
3. 将 Host 扩展编写为普通 ESM Cordis package，使用公开原生 service。
4. 通过原生 plugin manager 在专用 Host profile 安装，按结果要求重启。
5. TUI 展示单独通过 TUI 源码组合（`run(argv, { plugins })`）集成，构建并重启后验收。

alpha.2 不提供 `cordis_define`、`cordis_run`、`cordis_stop`、
`cordis_undefine` 等模型工具。Host runner 的程序化生命周期仍存在：`code.host`
属于 Host，`code.client` 属于原生浏览器 runner，两者都不是 TUI 的热挂载入口。
Host 插件不能 inject 前端本地 UI registry。

Host preset 随包提供三份技能，分别说明 Host 扩展、TUI 源码组合与用户自己的组合。
需要补充 transport 时在 Mayfly Host 内使用公开 API 实现，携带可序列化 DTO。
不得复制私有实现，也不向 dsh 上游添加能力。持久化和发布遵循用户授权及[发布流程](/plugins/publishing)。
