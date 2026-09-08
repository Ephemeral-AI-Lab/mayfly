# 交互重构实施进度

状态日期：2026-09-08。工作分支：`refactor/ui-interaction`。工作树：
`/home/x/dev/deepseek-harness-plugin/mayfly-ui-interaction`。基线：`b82acd2`。

目标是按照 [详细方案](./pr15-interaction-refactor-plan.zh.md) 完成统一交互模型，
不保留旧协议兼容层。20 步执行清单见
[交互模型完全迁移](./ui-interaction-migration-steps.zh.md)。

## 当前结论

Step 1 至 19 已经完成，用户于 2026-09-08 接受专用 profile 与 Website 候选。
Step 20 的验收后合并和清理正在执行；当前仍未写入共享 `mayfly` profile。

指定的 Codex session `01a07aa1-3760-7791-92dd-dc5f797f2874` 只用于恢复开发过程；
它不是 Harness 持久会话 ID。实际进度以本工作树、类型、测试和构建结果为准。

## 最终模型

- `@ephemeral-ai/mayfly-ui` 提供 readonly node、Form/Choice/Tabs/Document 地址、
  source/scope、结构化 submission/reply，以及四个直接 registry/provider。
- Pane 与 overlay registration 由 frontend 的 `mayflyUiInteraction` 实例持有 draft、
  选择、页面、文档锚点、确认、operation 和 feedback。Core reload 只释放 editor、
  focus、layout 与 scroll handle，不销毁有效语义状态。
- `onEvent.observe` 接收 value、selection toggle 与 tab change 事实；
  `onEvent.action` 处理 activate、selection accept、submit 与 dismiss，并返回
  `accepted`、`invalid`、`conflict`、`failed`、`completed` 或 `cancelled`。
- Provider endpoint 将回包准备和发布分开。Core 先准入回包，一次性 publisher 再
  更新原 registration。data/replace、同名重开、abort 和 Fiber unload 都会撤销旧
  continuation、reporter 与 publisher。
- Form、Choice、Tree、Wizard、Document、field picker、dirty dismissal、默认 No
  decision、field validation、single-flight 和 feedback 都使用共享 reducer/compiler。
  隐藏表单按显式 boundary 准入，大列表保持窗口化。
- Editor replacement 使用 `presentation: 'editor'` 的普通 overlay。旧
  canonical/frontend/form/info/confirmation/select/editor-panel controller 栈已删除。

## 消费者迁移

以下生产消费者均已切换到最终模型，并保留原生 dsh service 作为领域事实与写入
authority：

| 领域 | 已迁移行为 |
| --- | --- |
| Provider / OAuth / 首启 | profile 编辑、新增、凭据 partial ack、持续授权指引、原生 prompt signal |
| Settings / model / effort / preset | descriptor revision、path ops、继承/override/reset、secret、精确 Agent、原生 preset transaction |
| Approval / questions / plan review | FIFO、默认拒绝、Other/空答案、跨页 wizard、原生单次结算 |
| Tools / MCP / skills | 精确 Agent、只读 Document、脱敏、子 overlay 生命周期、共享 catalog |
| Help / trace / session / agents | app 或精确 Agent 生命周期、Tree/Document、刷新与晚结果 fence |
| Jobs / market / update | 原生 list/get/read/stop、分页、长行、preflight/rollback、结构化反馈 |
| Queue / notifications / editor extension | user-only queue、按 owner/scope 反馈、completion/transform/action cancellation |
| 外部 overlay 示例 | 原生 settings namespace、双页表单、revision/path commit、冲突与 unload |

## 已有证据

- `pnpm run test:coverage`：193 个 test file 通过、2 个按原条件跳过；3183 项通过、
  7 项跳过。Statements 18056/18056、Branches 13404/13404、Functions 3698/3698、
  Lines 14453/14453，全部 100%。
- `ui-interaction-surface.ts`：622 statements、572 branches、115 functions、437
  lines 全部 100%。
- `ui-compiler.ts`：1575 statements、1257 branches、293 functions、1265 lines
  全部 100%。
- `pnpm run typecheck` 与 `pnpm run lint` 通过。
- Surface/compiler 测试覆盖 renderer reload、响应式 schema 竞态、旧 ack、字段与选择
  输入、Tree/Wizard/Document、窄高布局、stale callback、dispose 与 feedback 排序。
- Compiler 不再暴露或执行 max-leaf、leaf-path、leaf-offset 与 leaf-scroll 兼容路径；
  passive transcript 使用真实 screen viewport，并在自身折叠策略前获得完整 canonical
  行数。

性能审计使用 Node 24.15.0、Linux x64、显式 GC 和每场景 7 个 headless 样本；它不是
终端 FPS。命令为：

```sh
node --experimental-transform-types --expose-gc script/audit-performance.mjs
```

在真实 frontend `UiSurfaceModel` 上，100,000 项 list 的一次性首次 build/publish/render
为 median 233.75ms、p95 249.14ms；稳定 repeat render 为 0.50/0.81ms，选择更新为
2.12/3.33ms，PageDown 为 0.83/1.18ms。100,000 项 filtered repeat/PageDown 为
0.60/0.83ms 与 1.28/1.63ms；Tree repeat/PageDown 为 0.61/0.75ms 与
1.64/1.84ms。100,000 字符 Document append/prepend reconcile 的 p95 分别为
4.27ms 与 4.53ms。普通 render 还断言 model revision 不变。结果证明 O(n) 工作只在
首次 admission、query/disclosure/definition 变化或完整 native transcript 转换发生，
稳定 render 与移动只读取 viewport 邻域。

全量 coverage 下的 CJK Job output 历史超时也已单独定位。旧 `JobOutputPanel` 在页间
移动时重建 `CanonicalDocumentController`，coverage instrumentation 会放大每次对整页
宽字符重新包装的成本。最终路径对 native output 只读取一次，`documentPages()` 只
切分一次并保证 surrogate pair 完整，页面 action 仅发布当前 shared Document，不
重读 Job。新增 24,002 个 CJK 字符的完整重建/逐页滚底/往返导航用例；定向 coverage
下 Jobs 38 项共 1.40s，`jobs.ts` 与 `document-pages.ts` 四项均 100%。

## 发布候选门禁

- `verify:changed -- --plan` 选择 full gate；`verify:full` 全部通过，包括 workflow、
  typecheck、lint、diagram、build、53 项 lib claim、agent docs、独立 examples、完整
  coverage 与 40 列 happy smoke。
- `check:pack` 通过：三个 alpha.4 tarball 通过 publint，CLI runtime 包含锁定的
  Harness 0.1.2-alpha.5、26 个平台 sentinel 与 7 个归档。
- `shots:sync` / `shots:check` 通过：36 张 component shot 与 6 张 app shot 当前有效。
- 最终 `website:build` 通过；preview 保留在局域网端口 4183。
- `mayfly-ui-interaction` profile 已从工作树安装。`smoke:pty`、鼠标 smoke、输出恢复
  smoke 均通过；专用 profile 的版本、展开组合和 40×24 实际启动已检查。

## 剩余交付

1. 提交并合并已接受的候选，重建主 checkout。
2. 停止 preview，移除专用 profile 和 worktree，并记录最终 merge/cleanup 证据。
