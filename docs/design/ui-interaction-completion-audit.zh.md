# 交互模型 20 步完成审计

状态日期：2026-09-08。候选分支：`refactor/ui-interaction`。基线：`b82acd2`。
候选版本：`0.1.0-alpha.4`。

本表逐项对照 [20 步执行方案](./ui-interaction-migration-steps.zh.md)。代码、测试、
构建产物、pack、运行进程和人工反馈是权威证据；进度文字本身不证明完成。

| Step | 要求 | 当前权威证据 | 判定 |
| --- | --- | --- | --- |
| 1 | 固定基线、消费者与失败分类 | 执行方案末尾包含 18 类消费者矩阵；工作树、分支和 Codex session 用途已固定 | 完成 |
| 2 | 修正依赖与夹具 | `command-registration.spec.ts`、pane/overlay bridge、`e2e.spec.ts` 和 app-shot boot 使用真实 provider/frontend 依赖 | 完成 |
| 3 | 最终事件/回执协议 | `packages/ui/src/interaction.ts` 与 `snapshot-events.ts`；provider 类型/runtime 测试及外部 overlay consumer；旧字段结构搜索零命中 | 完成 |
| 4 | operation、关闭、父子生命周期 | `ui-interaction-state.spec.ts`、`request-overlay.spec.ts`、`update-command.spec.ts` 覆盖 single-flight、abort、晚结果、同名重开和关闭策略 | 完成 |
| 5 | Form/Choice/Tabs/Wizard/Decision | 对应 core reducer specs、renderer 轨迹、Provider 与外部双页 settings overlay；默认 No、跨页提交、partial ack 与 conflict 均有断言 | 完成 |
| 6 | 动作查询、输入、提示同源 | `ui-compiler.spec.ts`、`ui-interaction-renderer.spec.ts`、keys/input tests 覆盖 live keymap、capture、IME 文本、paste、disabled/busy 和提示 | 完成 |
| 7 | Document 语义锚点 | `ui-interaction-document.spec.ts` 与 renderer tests 覆盖 prepend/append、宽度变化、follow=end、重建、空文档和 main/alternate | 完成 |
| 8 | Tree/Search 与大列表 | Choice/Tree/Search tests 覆盖 disclosure、祖先匹配、清空、删除/重排；100k flat/filtered/Tree 基准证明稳定 render/move 只读 viewport 邻域 | 完成 |
| 9 | 通知与反馈 | notification store/state/input tests 覆盖 owner/scope/operation、5 秒可见时钟、隐藏暂停、progress 结算、warning/error 处理与敏感隔离 | 完成 |
| 10 | editor extension 三类请求 | `editor-extension-runtime.spec.ts` 覆盖 action、completion、transform、timeout、replacement、attachment rollback、shell reload 与结构化失败 | 完成 |
| 11 | 配置与请求型消费者 | Provider/add/edit/onboarding、Settings、model/preset/permission/plan、authorization、approval/questions/plan-review tests 覆盖 native revision 与生命周期 | 完成 |
| 12 | 目录型消费者与市场 | Help、Tools、MCP、Skills、plugin market tests 覆盖只读浏览、脱敏、offline/refresh/install rollback、详情父子生命周期与 locale | 完成 |
| 13 | Session/Agents/Jobs/Trace/只读历史 | commands、agents、jobs、trace、session transcript tests 覆盖 new/resume/fork/rewind 请求、同 ID replacement、cold history、图片/工具、精确 Agent 与一次 consuming read | 完成 |
| 14 | Update 与旧通知生产者 | update/check/swap、input、queue、paste/session-export tests 覆盖 preflight、swap/rollback、重入、附件-only 摘要和结构化 notification owner | 完成 |
| 15 | 删除旧 controller/兼容路径 | 10 个旧 panel/controller source/test 文件删除；生产和测试树中 `eventRevision`、`selection-change`、`refreshMode`、max-leaf 与 leaf path/offset/scroll 搜索零命中 | 完成 |
| 16 | 生命周期、覆盖率、性能、宽度 | 193 个 test file、3183 项通过；四项逐文件 100%；width/app shots、三组 PTY；性能与 CJK Jobs 结果见进度文档 | 完成 |
| 17 | 文档、示例、版本、截图 | 架构/seams/AGENTS/README/Website 中英同步；alpha.4 三包锁步；外部 settings overlay；36 component + 6 app shots 当前有效 | 完成 |
| 18 | 完整发布候选门禁 | 最终 `verify:full`、`check:pack`、`shots:check`、`website:build` 通过；3 个 tarball 通过 publint 和包闭包 | 完成 |
| 19 | 专用 profile 与人工验收 | `mayfly-ui-interaction` 已 link 安装；实际启动、配置展开、happy/PTY/mouse/output smoke 通过；用户于 2026-09-08 接受 A-E/W 全部场景 | 完成 |
| 20 | 验收后合并与清理 | 候选四笔提交经 `5fbbdc8` 合并到 main；main build/check:lib 通过；preview、profile、worktree 已清理，alpha.4 pack artifacts 已迁入 main | 完成 |

## 最终自动证据

```text
verify:full
  Test Files  193 passed | 2 skipped (195)
  Tests       3183 passed | 7 skipped (3190)
  Statements  18056/18056 (100%)
  Branches    13404/13404 (100%)
  Functions   3698/3698 (100%)
  Lines       14453/14453 (100%)
  HAPPY_SMOKE_PASS exit=0

check:pack
  3 alpha.4 tarballs; publint passed
  external UI kit packed runtime and types passed

shots:check
  36 component shots current
  6 app shots passed

smoke:pty / smoke:pty:mouse / smoke:pty:output
  all passed on the final runtime source
```

性能命令、环境、100k list/Tree/Document 数字与 CJK Jobs 原因记录在
[实施进度](./ui-interaction-progress.zh.md)。Website 严格构建通过；人工验收使用了
`http://192.168.8.188:4183/plugins/ui-reference` 等三条路由与
`dsh --profile mayfly-ui-interaction`，验收后均已清理。

## 完成边界

Step 1 至 20 全部完成。main merge commit 为 `5fbbdc8`；主 checkout 已重建并通过
53 项 lib closure 检查。Website preview、`mayfly-ui-interaction` profile 和 worktree
已移除；alpha.4 pack 证据保存在 main `.artifacts/ui-interaction-alpha4/`。
