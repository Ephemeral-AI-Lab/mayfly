# 组件模型

插件向 Mayfly service 注册 renderer-neutral definition 和 readonly
`MayflyUiNode` snapshot。

```text
领域状态 / dsh projection
          │ set(data/replace)
   registry snapshot
          │
 frontend interaction owner
   draft / action / feedback
          │
 core admission + compile
          │
      pi-tui component
```

插件拥有领域状态与 definition；registry 拥有当前 registration snapshot；
frontend owner 持有 registration instance 的语义交互状态；core 只持有编译后的
component、editor binding、focus、layout 与 width。

规则：

- node 是数据，不携带 Agent、Session、terminal width 或 renderer object；
- `onEvent.observe` 接收编辑事实，`onEvent.action` 执行原生读写并返回结构化结算；
- context 提供 source、operation ID、revision、AbortSignal 与 progress reporter；
- 外部领域变化调用 `set(node, { reason: 'data', source })`，instance replacement
  使用 `reason: 'replace'`；handler 不回声发布草稿；
- Fiber unload 移除 registration，迟到 handler、report 和 publisher 不再生效；
- 每个可见组件必须在 20/40/80/120 列下保持宽度边界。

节点字段见 [UI 节点参考](/plugins/ui-reference)。
