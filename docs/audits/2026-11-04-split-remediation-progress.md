# 分体审计修复实施记录

本记录对应 [T01–T27 原始任务单](2026-11-04-split-remediation-tasks.md)，基线为 `5a834609`。原始问题描述保留；本记录说明实际实施选择、提交和验证状态。

## 已确认的实施边界

- 本轮所有能力补充均在 Mayfly Host 内完成，使用公开原生服务；不修改、升级 dsh 上游，也不把缺失能力转交上游实施。
- 按依赖关系分批并行实施。Host、Remote、独立验证各使用独立 worktree；集成者负责合同、生成声明、包元数据和组合验证。此执行方式取代任务单中逐项串行的要求。
- T05 采用原生 ConfigEditor 相同的 profile `package.json` 文件锁，在锁内读 revision、校验、原子写并读回。用户接受不合作的外部编辑器绕过锁时仍可能发生竞争，因此 T05 必须报告为**部分修复**，不能宣称任意进程之间都有 raw-document compare-and-write 保证。
- `/changes [seq]` 读取原生保留的比较；原生比较随 Session disposal 消失，Host 重启后可能返回无可用比较。空态必须安全、只读且不激活 Agent，不新增独立 workspace 历史 store。
- immutable rc.2 reference 不变，不从 candidate 重写 golden。已有 strict parity 红项与新回归分别记录。
- 集成在 `fix/split-remediation`，不合入 main，直到适用的运行配置和 Website 人工验收完成。

## 各任务提交

下表的“已实现”表示代码与局部回归已交付，不等同于组合门禁或人工验收已完成。

| 任务 | 集成提交 | 实施与局部验证 |
| --- | --- | --- |
| T01 | `65320f8d`、`78adba58` | statsHistory 显式 global 授权，覆盖真实 Gateway 拒绝时零 corpus 读取；Remote 显式提示失败；独立复核通过 |
| T02 | `926b9ba2`、`0dc9a799` | 首次创建按 Host/Client/generation 隔离，真实 editor submission 覆盖附件与启动意图；独立复核通过 |
| T03 | `870fe7ef` | controller/operation 统一写入 admission，readonly 不退化为 Host 默认写；独立复核通过 |
| T04 | `e0d8c751` | 按规范化目标排队、同目录私有 staging、同步原子提交、仅清理本次临时文件；独立复核通过 |
| T05 | `b50a1eda` | **部分修复**：共享 profile 锁与原子写，跨进程协作 writer 回归通过；不合作外部编辑器限制如上 |
| T06 | `fa0ba576`、`a4201183`、`b55afdb3`、`a4245c46` | Host/schema/checkpoint、共享 Transcript、export/copy、Remote 图片读取保留有序 file/image 元数据；真实 HTTP/WebSocket、ordered file/image/file、file-only、reconnect 与精确 Session receipt 通过；flow 图片永久 loader 相邻缺陷另补回归并修复，严格真实复验已通过，最终顺序含 diagram.png，禁止残留 loader |
| T07 | `691ec5fc` | editor key 经官方 `client.remote.session.openWorkspacePath`，精确所有者与迟到反馈回归；独立复核通过 |
| T08 | `25b2369e` | `/changes [seq]` 复用 Files/diff，指定 seq 不跟随 latest；39 项局部回归；真实 Host 两个 seq（42/77）、latest、无效 seq/索引、8 个宽/窄 PTY checkpoint 通过；冷重启无 comparison 的 RPC 不激活、不写 event |
| T09 | `4676f461`、`aa26732c` | Host 被动读取实际权限 knobs，Remote 独立组合 plan/yolo；custom/withdrawn、sessionless/readonly、授权/卸载/乱序覆盖；相关运行时文件局部覆盖率 100% |
| T10 | `cec754a7` | MCP resource 错误固定安全文本与 server 标识，wire/普通日志无连接原文；独立复核通过 |
| T11 | `6a3b4903` | HostKey 与 transport 共用 URL 规范化；root/connect/mount/token/query 隔离回归 |
| T12 | `ad07cbbc` | service-owned pending leases 与 abort-aware ready wait，close/replacement/dispose 不等待永不结束的 acquisition；局部覆盖率 100% |
| T13 | `b2cee041` | 仅确认相同 cold revision 后复用缓存，live 重算，失败不预填旧快照；独立复核通过 |
| T14 | `c2183479` | diff model 与 palette 高亮分离，Dark→Light→Dark 与 fresh render 对照 |
| T15 | `dda54f3a` | lazy source 带 surface owner；共享 paint cache，dispose 后通知与计数不串实例 |
| T16 | `3c55b237` | focus observation 共用 surface slot，跨控件 newest-wins，其他观察独立 |
| T17 | `d02c5c10` | layout microtask 捕获 marker generation 和 boundary，reset 后新 marker 保留 |
| T18 | `a846e596`、`fb3e6acc` | duplicate occurrence 在归属、交互与 copy/disclosure 前统一规范化；歧义目标安全拒绝；独立复核通过 |
| T19 | `6b7dd4e4` | numstat 失败为 unknown，取消与失败不污染 cache；独立复核通过 |
| T20 | `e9fb8fab` | 保护当前五个 release 包，catalog/unlisted/direct 路径一致，指引 `/update`；第三方管理保留 |
| T21 | `21494996`、`fe97f31d`、`a375fccb` | authorization/workflow/balance 出口 detached/frozen；独立 phase 别名回归与修复复核通过 |
| T22 | `81fa7e3a` | public conversation/transcript runtime 闭包不触达 durable fold，transient 与 Host 同输入对照；旧代码回归为红 |
| T23 | `7cc5a784`、`cdbf1134`、`25c07a17` | Host 唯一 Conversation DTO owner，shared 仅 type reuse；Remote 从生成 namespace 推导，保留 stream/uplink；外部 pack fixture 扩展 |
| T24 | `81bbae3c` | headless runtime 闭包、Core 宽度布局、实例高亮 cache 与 disposal；6,514 项 Mayfly 回归，14 个相关运行时文件局部覆盖率 100% |
| T25 | `f040586f`、`0c236c3e`、`6319e131`、`e20ddaad` | 显式 notification scope，移除旧 public lookup/export，key 常量拆出纯模块，commander/yaml 归 dev；Gallery 通过真实 prepare/publish ACK，无 observation upsert |
| T26 | `4d42180f`、`73c1bd8e`、`7bc325a2` | 双语 README、能力 map、Host/Remote、42 个双语 Website 页及参考版本号修正；version 10 项回归与独立严格 Website build 通过 |
| T27 | `831dd0ac` | 有界 Ctrl+C 重试与细分退出诊断，假终端回归及真实 focus/changelog smoke 通过；不宣称 strict parity 已全部通过 |

T06 真实验证另外发现启动目录协调缺陷，已在 `a8ae7686` 修复：等待官方 Connection generation 后再加入原生 Session 目录刷新。修复前受控回归失败，修复后 app 115 项测试及逐文件 100% 覆盖通过；不修改 dsh。

T06 真实图片读取进一步定位到既存 flow 渲染缓存缺陷：HTTP 45ms 返回原始 PNG 的全部 90 字节，但缓存的 list block 永久保留 loader。`a5c64b70` 固定原先失败的回归，`813bc0fe` 在图片 repaint 时同时清空 flow block 缓存；图片、列表和性能预算 138 项通过。`0baa98c8` 加强真实验证，必须看到最终图片 metadata fallback，禁止将 pending loader 算作完成。该 PTY 不支持内联图片协议，因此不宣称图像像素已在终端显示。`fd6a8a46` 进一步修复唯一 image provider 卸载时 pending→missing 不通知的问题，覆盖迟到成功/失败与 surface 先卸载的分支。

## 组合验证与验收

- `0c236c3e` 已完成全量 build，冻结给独立验证运行 T06/T08；其实际 runtime hash 由场景 report 记录。
- 首次组合源码测试：9,137 项通过，两个旧架构断言需跟随 T23 的 DTO owner/包声明调整，已修正，针对测试与源码/测试类型检查通过；最终全量覆盖率仍需组合门禁确认。
- `fd6a8a46` 稳定构建下的完整源码覆盖率：529 个套件通过、2 个既有套件跳过；9,153 项测试通过、2 项既有测试跳过。可执行代码的 statements/branches/functions/lines 全部达到逐文件 100%，未放宽阈值或排除源码。日志 `/tmp/mayfly-remediation-coverage-stable.log`。
- 完整 repository workflow：180 项通过、1 项既有跳过、0 失败。`e20ddaad` 将按键审计的影响图断言跟随到实际纯定义文件。日志 `/tmp/mayfly-remediation-workflow-final.log`。
- 严格 T06 真实证据：`/home/x/dev/mayfly-remediation-verify/.artifacts/remediation-t06/candidate-b3c23959-settled-image/report.json`，runtime before/after hash 均为 `233fa4fcd8ef864cb994615059f2fb56451b579d5a88121d4efeef8d1fa219c4`；两个 TUI 干净退出，4 个宽/窄 checkpoint 通过，图像明确完成到 metadata fallback。
- Root Website 严格 build 通过（19.25 秒），14 个受影响预览路由 HTTP 200；仍需人工视觉/内容验收。
- 首轮 `verify:changed` 的 coverage 曾被集成者并行安装构建短暂删除 `lib/` 干扰，部分入口解析失败；该轮 coverage 无效，不作为产品回归或验收通过证据。随后稳定构建重跑的完整 coverage 如上，最终 `verify:full` 仍将串行运行。
- `verify:changed -- --plan` 已执行。`verify:changed`、`verify:full`、最终 pack/examples/agent-docs 与专用 profile/Website 验收结果将在完成后追加。
- T08 独立真实证据：`/home/x/dev/mayfly-remediation-verify/.artifacts/remediation-t08/candidate-0c236c3e-final/report.json`。重启后原生 comparison 不再保留；普通 TUI resume 会激活 Session，已将被动 RPC 与 resume UI 证据分别记录，未把后者称为 passive。
- Website 预览持续保留于 `http://192.168.8.188:4193/`，中文与英文 guide/config、plugins/seams、quickstart、reference/commands、features、theme 等页面待人工验收。
- 最终报告必须保留基线 `panels/stats/files` 等未审查红项，以及任何未完成的图片内容读取、真实 TUI 或人工验收，不得只凭局部测试宣布完整验收通过。
