# Mayfly 生态示例组合

这是一个 opt-in TUI 源码组合：在普通的 `mayfly` 启动流程上，把五个可运行示例
加入 TUI 的 Cordis 树。

```sh
MAYFLY_DSH_STARTUP_URL='http://127.0.0.1:3080/?token=…' mayfly-ecosystem
```

`mayfly-ecosystem` 接受与 `mayfly` 相同的选项和环境变量；与 `mayfly` 一样，需要
另外启动 Host。自己的组合导出插件列表，并调用 `@ephemeral-ai/mayfly/bin` 的
`run(argv, { plugins })`，做法同 `src/index.ts`。本验证包不进入 Mayfly 默认产品
组合或发布集。
