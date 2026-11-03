# Mayfly 分体架构待修复任务（交给 Codex）

审计基线：`5a8346092b42216d669abe8a40570465d16bb7a6`（2026-11-04）。
目标：修复当前分体式 Host + Remote TUI 中已确认的安全、正确性、前后端配合、渲染和架构问题。

本文是修复任务单，不定义新的产品行为。行号对应上述基线；代码变化后以实际调用链为准。审计证据保存在 `.artifacts/audit-5a834609/`。若其他机器没有该目录，按本文的最小复现步骤重建证据，不要猜测结果。

## 给 Codex 的执行约束

1. 先阅读根 `AGENTS.md` 和涉及包的 `AGENTS.md`。在独立 worktree/branch 工作，不使用生产 `mayfly` profile，不修改普通 `default` profile。
2. 按 T01 → T27 的顺序实施。每个任务独立修改、独立测试、独立复核，避免把所有问题揉成一次重写。可在每项末尾追加“状态、提交、验证”，不要删除原始问题描述。
3. 保持架构边界：
   - Harness 拥有 Agent、Session、模型、工具、命令和持久状态。
   - Host 拥有持久展示投影；Remote 不得新增第二份持久历史 fold。
   - 标准能力优先走官方 Client；`mayflyHost` 只补充缺失且可序列化的聚焦能力。
   - 不增加 Agent facade、`mayflyCurrentAgent` split seam、兼容 alias/shim/deprecation 路径或 mutable product singleton。
   - 只有 `packages/mayfly/src/core/` 可以拥有 pi-tui、ANSI、宽度、focus 和终端状态。
4. 不通过降低覆盖率、排除运行时代码、删除失败断言、屏蔽场景、重写 reference 或接受候选 golden 来消除失败。可执行源码继续保持逐文件 100% coverage。
5. Runtime imports 指向 built `lib/`。修改源码后先 rebuild，再验证 installed profile 或真实 Host/Remote。
6. 公共合同变化必须同步所有调用方、生成 artifact、exports/types/files、examples、必要的双语 README 和 Website reference；不得只改一处类型让编译暂时通过。
7. 每项至少包含一个原先会失败的回归测试。安全/竞态任务必须控制异步顺序；仅测试同步 happy path 不算完成。
8. 不把“文档中没有描述”当成可以破坏现有语义的理由。遇到产品选择不确定时，在任务中记录选择及理由，优先保持当前公开合同和最小变化。

## 当前验证基线

- build、typecheck、lint、diagrams、lib exports、agent docs、examples、pack、CLI smoke 均通过。
- 8999 个测试通过，2 个跳过；逐文件 coverage 为 100%。
- `verify:full` 退出 1：15 个 split 场景 strict parity 通过，`network` 行为通过，`panels`、`changelog`、`stats`、`files`、`focus-resize` 失败。
- `panels/stats` 主要是已记录的原生数据差异；`files` 是已记录的 reference 缺陷；`focus-resize` 候选和 `changelog` 候选在定向复测中均连续两轮通过，首次退出失败更符合 driver 时序。
- 不要把这些基线失败混同为新修复引入的回归，也不要在没有明确审查的情况下把它们标成已通过。

# 第一阶段：P0/P1 安全与数据正确性

## T01 [P0] 修复 `statsHistory` 跨 Session 授权缺口

- 位置：`packages/host/src/remote/service.ts:204-207`、`packages/host/src/remote/stats.ts:49-85`。
- 证据：`.artifacts/audit-repro/host-gateway-access.json`。
- 问题：RPC 只声明请求中的 Session A，但实现通过 `listSessions()` 读取同工作区或全部工作区的其他 Session。真实 Typert Gateway 复现中，principal 只允许 A、拒绝 B，两种 `allWorkspaces` 模式仍观察并返回 B。
- 修复要求：
  - 不得继续用单 Session resource 授权整个 corpus，也不得只在返回前过滤 id；冷读取本身就需要授权。
  - 最稳妥的当前方案是将跨 Session history 作为显式 global/workspace 高权限能力，并在进入 `listSessions()` 前由 Gateway 校验。若要保留逐 Session 细粒度访问，必须先找到或增加原生逐条授权 seam，不能自行绕过。
  - `statsSession` 的单 Session 语义保持不变。明确 Remote UI 所需的权限和失败反馈，不能把失败静默变成空统计。
- 回归测试：
  - 使用真实 Typert/Gateway 授权链，覆盖 A 允许/B 拒绝、同 cwd 和跨 workspace。
  - global/workspace 权限被拒绝时，`listSessions` 和其他 Session 的 `observeSession` 均未调用。
  - 合法调用仍返回完整统计，stream cancel/unload 语义不变。

## T02 [P0] 按 Host 隔离 sessionless 首次创建和 prompt

- 位置：`packages/remote/src/remote/app.ts:151-176,198-261,314-331`。
- 证据：`.artifacts/audit-repro/ensure-session-cross-host.json`。
- 问题：Host A 创建未返回时 attach B，第二条 prompt 复用 A 的 `creating`，最终两条 prompt 都写入 A。
- 修复要求：
  - `creating` 记录 HostKey 和相关 generation，只允许同一 active Host 的并发首提示共享。
  - active Host 改变后，新输入不得复用旧创建。旧 Host 已接受的 create 可保留其 Host-owned 生命周期，但迟到结果不得提交 selection、plan/preset intent、附件或 prompt。
  - 不只修 UI 展示；必须阻止实际原生写。
- 回归测试：双 Host 延迟 create、第二 prompt、附件、preset/plan intent、detach/reconnect，以及同 Host 并发首提示仍只创建一个 Session。

## T03 [P1] 在所有 controller 层阻断 readonly Session 写操作

- 位置：`packages/remote/src/remote/editor-composition.ts:91-95`、`features/models.ts:244-288`、`features/plan.ts:117-142`、`features/permissions.ts:195-203`、`features/presets.ts:90-103`、`operations/presets.ts:71-102`。
- 证据：`.artifacts/audit-repro/readonly-{model,plan,permissions,preset}.json`。
- 问题：`scope: 'sessionless'` 绕过命令解析的 readonly 检查，controller 继续对 displayed readonly Session 发原生写。
- 修复要求：
  - 在每个可能写 Session 的 controller/操作入口统一检查 `access`，不能只依赖命令是否可解析。
  - Host 默认配置只能在真正没有 displayed Session 时修改；不得把 readonly Session 静默当成 Host-default 场景。
  - 保留 readonly 草稿和只读浏览，不改变显式 continuable-child reply 的原生例外。
- 回归测试：`/model`、picker、Alt+M、`/effort`、`/plan`、`/mode`、Shift+Tab、`/permissions`、`/preset` 及 picker 均断言零写 RPC；同时覆盖 resumable/readonly/interactive 和 Host 切换。

## T04 [P1] 修复导出并发与回滚导致的数据丢失

- 位置：`packages/remote/src/remote/operations/export.ts:86-104`。
- 证据：`.artifacts/audit-repro/export-same-path-race.json`、`export-external-modification.json`。
- 问题：B 成功写出后，A 的 stale cleanup 可 unlink B；外部修改也会被旧 bytes 覆盖。
- 修复要求：
  - 按规范化目标路径串行化导出，避免同进程内交错写同一路径。
  - 使用临时文件，并仅在 selection/caller/owner 仍有效时原子替换目标。
  - cleanup 只能撤销本次操作自己造成的变化；当前 bytes 已不等于本次输出时必须保留，不得盲目 unlink/restore。
  - 保持 TUI 本地路径解析、覆盖已有文件的公开语义及失败清理。
- 回归测试：两个导出交错、写后外部修改、原文件存在/不存在、临时文件清理、取消和 unload。

## T05 [P1] 将 raw settings revision 校验与写入放入同一事务

- 位置：`packages/host/src/remote/settings-document.ts:48-66`。
- 证据：`.artifacts/audit-repro/settings-toctou.json`、`settings-toctou-target.json`。
- 问题：最终 revision 检查后、`writeFile` 前的外部修改会被 stale writer 覆盖。原生 `configEditor.edit` 已有锁和原子写，但当前路径未使用。
- 修复要求：
  - 使用原生 config editor 的同一文件锁/事务和原子写；revision 比较与写入必须位于同一临界区。
  - 若官方 API 无法提供 raw-document CAS，不得声称当前实现具备 compare-and-write 保证；应先补原生能力或明确限制，而不是再增加一次读取。
  - 保持全局授权、只读拒绝、调用方取消与已 admitted Host 写入的现有语义。
- 回归测试：在最终读取后写入外部内容必须得到 `mayflyHost/settings-conflict` 且外部内容保留；覆盖另一进程、外部编辑器、同服务 writer 和写后读取。

# 第二阶段：前后端能力与边界

## T06 [P2] 端到端保留并展示 FileBlock

- 位置：`packages/host/src/conversation/types.ts:30-35`、`projection.ts:175-209,618-631`、`packages/mayfly/src/transcript/conversation-model.ts:549-565`、`stream-facts.ts:701-716`、export/copy。
- 证据：`.artifacts/audit-repro/file-blocks-{file-only,text-file}.json`。
- 问题：原生 `file` 内容块被 DTO 和 fold 丢弃；file-only 消息完全消失，text+file 只剩文本。
- 修复要求：
  - 在 Host wire/projection 中保留文件附件的安全元数据（至少 attachmentId、name、bytes），不跨进程传文件系统 target 或任意路径。
  - 更新 runtime schema、checkpoint stateVersion、shared Transcript、最终 UI、readable export/copy 和 reconnect 行为。
  - 文件内容仍由原生 attachment/read 路径授权读取；展示 metadata 不等于授予任意文件访问。
- 回归测试：file-only、text+file、多个 file/image 的顺序、重连恢复、export/copy，以及现有 `split-command-files` 增加 projection/TUI 断言。

## T07 [P2] 修正 `@` 文件/mention 打开的官方调用面

- 位置：`packages/remote/src/remote/editor-composition.ts:76-86,211-219`；正确参照 `operations/files.ts`。
- 证据：`.artifacts/audit-repro/editor-open-session-face.json`。
- 问题：当前强制类型断言后调用不存在的 `SessionFace.openWorkspacePath`，真实键盘路径报 `official.openWorkspacePath is not a function`。
- 修复要求：捕获当前 HostClient，通过 `client.remote.session.openWorkspacePath({ path }, signal)` 调用，并保留精确 Host/Session、binding、connection generation 和 caller 的 fence。
- 回归测试：使用不含便捷方法的官方 SessionFace，驱动实际 editor key → `ui.external` → open；验证成功、失败、readonly、切换选择和迟到的 native feedback。

## T08 [P2] 实现或明确移除 `/changes [seq]` 的产品声明

- 位置：`packages/host/src/remote/service.ts:240-250`、`packages/remote/src/frontend/host-contract.ts:31-32`、`operations-composition.ts:66-79`、根 README `:68`。
- 问题：Host 已有 `workspaceChangesSummary/Diff`，README 声明 `/changes [seq]`，Remote 没有命令、消费者或测试。
- 修复要求：
  - 首选按声明实现：复用 Host RPC 和现有 Files/diff 展示模型，支持指定 seq 的 summary/diff，不新增第二份 workspace 历史 store。
  - 覆盖 null、无效 seq、越界 index、空 diff、精确 Host/Session、取消、重连和窄宽度。
  - 若产品决定不实现，必须同步删除中英文 README 和相关能力声明，不能保留假入口。
- 回归测试：真实 Host 上对不同 turn/seq 的读取、只读 cold history、切换 Session 后迟到结果，以及 `/files` 最新一轮行为不回归。

## T09 [P2] 恢复 plan + yolo 状态组合

- 位置：`packages/host/src/remote/catalog-details.ts:94-112`、`packages/remote/src/remote/features/configuration-host.ts:114-131`、`features/plan.ts:75-93`、`features/permissions.ts`。
- 问题：`yolo` 已到 Remote adapter，但状态栏只发布 plan，且 details 主要在权限面板打开时求值。
- 修复要求：
  - 让一个明确的 mode-status owner 组合 plan 与当前权限 spec，不依赖 `/permissions` 面板曾经打开。
  - 订阅原生 projection/catalog 更新，处理 custom/withdrawn preset、sessionless、只读视图、Host/Session/connection 切换。
  - 保持原生权限写路径，不从 preset 名称猜危险等级。
- 回归测试：full-access+never、plan+yolo 同显、单独 yolo、custom/withdrawn、projection 更新和 Host 切换。

## T10 [P2] MCP resource 错误跨线前脱敏

- 位置：`packages/host/src/remote/mcp-resources.ts:12-20`。
- 问题：原生 tool error 的完整文本进入 `RemoteError.message` 和 details，可能包含 userinfo、query token、Authorization、代理或内网地址。
- 修复要求：保留稳定 `mayflyHost/mcp-resource-failed` 和安全 server 标识，公共 message 使用固定文本；原始连接错误不得进入 DTO。Host 内部诊断如需保留，使用独立脱敏路径。
- 回归测试：构造带 userinfo、token、Authorization 和内部 endpoint 的错误，断言 wire message/details/普通日志均无敏感原文；正常 resource body 不受影响。

## T11 [P2] 统一 HostKey 与 transport 的 URL 规范化

- 位置：`packages/remote/src/remote/app.ts:151-160`、`packages/remote/src/client/auth.ts:62-70`。
- 问题：根 URL 和 `/connect` URL 会形成两个 HostKey、两套 Client 和视图状态，尽管 transport 将它们识别为同一 Host。
- 修复要求：以 `resolveHostEndpoint(startupUrl).baseUrl` 等同一规范来源生成默认 HostKey，保留 mount path、scheme 和非 secret 身份，去除 token/query 对身份的影响。
- 回归测试：根路径、`/connect`、反代 mount、尾斜杠、token 更新组合；验证 registry、cookie generation、view lease 和 update recovery 使用同一 Host 身份。

## T12 [P2] 让 BTW pending acquisition 可取消、可释放

- 位置：`packages/remote/src/frontend/btw.ts:101-118,161-195,235-240`、`frontend/host-registry.ts:239-288`。
- 问题：parent/child lease 是局部变量，close 无法接触；`ready` 永不 settle 时操作不结束，后续 BTW 排在旧 `tail` 后。
- 修复要求：
  - 将 pending acquisition 纳入 service-owned record，close/replacement/dispose 立即可 retire。
  - 使用 abort-aware wait 并正确释放共享 lease refcount；不得取消已 admitted Host Agent 工作，也不得误关其他 view 的共享 lease。
- 回归测试：parent-ready 和 child-ready 永不 settle 后 close、第二次 ask、dispose、共享 lease、迟到成功/失败。

## T13 [P2] 统计缓存只在 cold revision 确认后发布

- 位置：`packages/host/src/remote/stats.ts:55-88`。
- 问题：旧 digest 在 revision 验证前预填；后续 observation 失败时旧值可留到最终帧，且没有 stale 标记。
- 修复要求：仅在 cold revision 确认相同后复用 memo；live 总是重算。失败数据不得冒充当前快照，除非 DTO 明确提供独立 stale 状态。
- 回归测试：先成功后失败、revision 改变、live 继续写入、部分 worker 失败、取消和 source replacement；初始/中间/最终帧均检查。

# 第三阶段：UI、渲染和交互正确性

## T14 [P2] 分离 diff 布局缓存与调色板相关高亮缓存

- 位置：`packages/mayfly/src/core/content-rows.ts:246-283,774-795`。
- 问题：`PreparedDiff` 仅按节点身份缓存，其中的 `lit` 已包含旧主题 ANSI；Dark→Light 模块探针复现混合调色板。
- 修复要求：宽度/调色板无关的 DiffModel 可继续共享；`lit` 至少按 `paintKey(env)` 区分或在新 paint 下重算，不能简单禁用全部缓存。
- 回归测试：同节点 Dark→Light→Dark 与 fresh render 完全一致，覆盖两个不同 palette 的并行 surface 和 memo 校验。

## T15 [P2] 修正共享 lazy content source 的重排通知所有者

- 位置：`packages/mayfly/src/core/content-rows.ts:153-176,1127-1149`、`ui-compiler.ts:570-582`、`surface-renderer.ts:314-317`。
- 问题：renderer 共享 content cache，两个 surface 可复用同一 source，但 source 只保留首个 env 的 `changed/report/counters`；第二个 surface 的重排通知发给首个实例。
- 修复要求：为 source 增加 surface owner 维度或订阅者集合，逐一通知仍存活的 runtime；painted segment cache 仍可共享，首个 runtime dispose 后不得收到回调。
- 回归测试：两个真实 surface runtime 共用节点/cache、首个先 dispose、scroll height 收敛、尾部可达、failure/work counters 归属正确。

## T16 [P2] 让跨控件 focus observation 遵守 newest-wins

- 位置：`packages/mayfly/src/core/ui-interaction-surface.ts:811-826,835-856,903-906`。
- 问题：focus key 包含 controlId，不同控件的 observation 不会互相取消，旧回复仍能发布反馈。
- 修复要求：所有 `focus-change` 共用一个 surface 级 observation slot；其他 observation 继续按控件隔离，不改变 action/read 的独立生命周期。
- 回归测试：A/B 控件的 deferred focus observation，断言旧 signal abort，新结果先到后旧结果不得产生反馈、导航或发布。

## T17 [P3] 给 new-messages layout 回调增加 generation

- 位置：`packages/mayfly/src/transcript/new-messages.ts:151-163,184-206`。
- 问题：旧 layout microtask 只检查“存在某个 boundary”，会 dismiss reset 后新建的新标记并补偿滚动。
- 修复要求：在 clear/reset 时失效旧 callback，排队时捕获 generation 和具体 boundary，只允许同一生命周期的回调生效。
- 回归测试：reset 后在同一 microtask 前重建 marker，确认新 marker 保留、无旧 `scrollUp`、无多余 republish。

## T18 [P3] 修正 Transcript 重复 ID 的块归属和交互映射

- 位置：`packages/mayfly/src/components/transcript-view.ts:347-365`、`transcript/stream-facts.ts:414-424`。
- 问题：重复项被改名为 `~2`，但子行 `under`、cursor/disclosure 和 copy/open/locate 仍指向原 ID。
- 修复要求：按父行 occurrence 同步重写归属和交互映射；若无法保持语义，应采用明确的安全降级，而不是只改 ID 假装正常。
- 回归测试：重复父 ID 的块归属、展开、复制、定位、admission 和 memo repaint。

# 第四阶段：小型 Host/产品合同修复

## T19 [P3] Git numstat 失败和取消不得缓存为成功零值

- 位置：`packages/host/src/remote/git.ts:75-99`。
- 修复要求：区分 numstat 失败与真实空输出，失败返回 `unknown`；每个 await 后检查 signal，只在完整成功后写 cache。
- 回归测试：numstat 失败、numstat 期间 abort、下一次新 signal 读取、branch/status TTL 和不 dirty 工作区。

## T20 [P3] 更新 marketplace 的当前产品保护身份

- 位置：`packages/mayfly/src/interaction/plugin-market/model.ts:72-95,195-200`、Remote `operations/plugin-marketplace.ts`。
- 问题：保护名单停留在旧包名，`@ephemeral-ai/mayfly-host` 会作为普通 unlisted 插件出现；是否能删除取决于 native manager，不能预设。
- 修复要求：保护当前产品 bundle，Host 升级继续走协调的 `/update`；不扩大为屏蔽所有第三方 unlisted 插件。
- 回归测试：真实 `listBundles` 形状下的展示、removable true/false、native 最终删除拒绝/允许行为，以及 `/plugin` 普通插件管理不回归。

## T21 [P3] 统一遗漏的 DTO/frame 冻结与脱离原生别名

- 位置：`packages/host/src/remote/authorization.ts:79-100,123-129`、`workflow.ts:377-407`、`balance.ts:50,58-65`。
- 修复要求：所有出口采用一致的 frozen/detached 策略；原生 notice 先 JSON detach/验证，不能只 freeze 原生别名。
- 回归测试：递归检查 frozen，排队后修改原生对象不得改变已发布 frame；确保 JSON 序列化和 stream 生命周期不回归。

# 第五阶段：架构减重与公共合同

这些任务应在行为修复及其回归测试完成后实施，避免大面积冲突。不要为了“看起来简洁”引入新的 facade 或兼容层。

## T22 [P3] 移除 Remote runtime 中可达的整份 durable fold

- 位置：`packages/mayfly/src/conversation/transient.ts:4-15`、`transcript/process-activity.ts`、Host `conversation/projection.ts`。
- 问题：transient helper 和一个小工具函数让 Remote 打包约 800 行 durable 状态机；虽未用于持久事件 fold，但存在真实漂移和 bundle 冗余。
- 修复要求：transient helper 直接基于轻量 stream accumulator 构造当前 attempt；`isSpawnToolName` 移到轻量展示模块。legacy fold 可留作私有 fixture，但不得由公开入口可达。
- 回归测试：相同 replay fixtures 验证 Host durable 与 Remote transient 边界，确认公开 bundle 不包含 durable fold，且没有新增第二历史存储。

## T23 [P3] 统一 Conversation DTO 与生成 RPC 类型来源

- 位置：Host/shared `conversation/types.ts`、`packages/remote/src/frontend/host-contract.ts:12-44`、生成 `typert.remote-client.d.ts`。
- 修复要求：
  - 选择 Host 或中立 wire 包作为唯一 DTO 所有者，另一侧只做类型复用；不得为消重引入 Host runtime 依赖或循环依赖。
  - Remote 尽量通过生成 artifact 的 type-only augmentation 推导 `mayflyHost` namespace，删除手写方法表和交叉断言，保留 stream/uplink 完整类型。
- 回归测试：双向类型可赋值、参数/返回值/stream/uplink 契约、生成声明的外部消费者 typecheck、pack 和真实 RPC。

## T24 [P3] 清理 frontend 传递渲染依赖和模块级高亮缓存

- 位置：`packages/mayfly/src/frontend/index.ts:7-10` → `core/ui-interaction-surface.ts:21` → `core/width.ts:13-15`；`core/highlight.ts:46-50,91-109`。
- 修复要求：
  - 先定义真正的 headless frontend 合同，再迁移 interaction state 或重新组织入口；不得复制宽度算法，也不得破坏现有 frontend/core reload 生命周期。
  - 将 highlight cache 归 renderer/surface 实例所有，并随 Core disposal 释放；保留正确主题 key 和有界缓存。
  - 架构测试应遍历相对 import 或检查打包后的 external 图，而不只扫描直接文本 import。
- 回归测试：headless 消费不加载 pi-tui、两个 Context/Host 隔离、Core reload 清理、主题切换和现有 interaction 状态保留。

## T25 [P3] 清理生产依赖、旧公开 seam 与示例合同

- 位置：`packages/mayfly/package.json:147,153`、`plugin-marketplace.ts:11`、`interaction/notifications.ts:14-24`、`examples/ui-gallery/src/groups/prompt.ts:79-107` 及测试。
- 修复要求：
  - `commander`、`yaml` 在确认公开 runtime 闭包后移至 devDependencies，并跑 build/pack。
  - 从公开 `plugin-marketplace` 删除旧 `mayflyCurrentAgent` helper；如仍需共享通知 owner，改成显式 scope 的 renderer-neutral API，不保留 alias。
  - Gallery 不得在 observation 内直接 `set()`；action 使用 structured reply，测试必须驱动真实 `events.prepare()`，覆盖 replacement 和迟到回复。
- 回归测试：公开入口扫描、pack 安装、split 外部消费者、observation 不产生 registry upsert、action acknowledgement 顺序和 Fiber 清理。

## T26 [P3] 修正文档与实际行为偏差

- 位置：根 `README.md:65,67`、`README.zh.md` 对应段落、`docs/native-capability-map.md:56`。
- 修复要求：
  - `/fork` 按当前实现忽略参数，不应写成 `/fork [atSeq]`；不要把文档错误改成新的产品行为。
  - 澄清 sessionless `/plan <message>` 的实际限制，不声称它可创建首个 Session。
  - 按 Harness alpha.2 修正 `modelSelection` 的原生所有者。
  - 中英文 README 同步；若 T08 决定不实现 `/changes`，同时移除其声明。
- 验证：文档检查、command inventory 和实际命令路由一致。

# 第六阶段：验证基础设施

## T27 [P3] 提高 split PTY 退出等待的可诊断性与确定性

- 证据：`.artifacts/audit-repro/exit-driver-probe.{mjs,json}`、`focus-resize-split{,-2}.json`、`changelog-split{,-2}.json`。
- 问题：首次 `focus-resize` 候选和 `changelog` reference 都没有出现退出 warning；driver 只发送一次 Ctrl+C 后持续等待。候选两个场景定向复测均连续两轮通过，因此不得把它修成产品退出行为变化。
- 修复要求：
  - 在 driver 中区分“第一次 Ctrl+C 未出现 warning”“第二次未退出”“终端模式未恢复”，加入有界重试或明确的失败诊断和现场信息。
  - 不得通过放宽 terminal restore 断言、无限重试或跳过场景让门禁变绿。
- 回归测试：受控假终端覆盖无 warning/无新 frame、第一次输入丢失、正常两次退出、始终不退出和 mode 未恢复；随后重跑真实 focus/changelog。

# 暂不直接修复：先补证据

以下只有代码风险或时序假设，不能在未复现前直接改语义：

1. `RemoteConversationModelSource` 的 settlement 与 projection 通知顺序可能造成 assistant 内容空窗或错误 streaming。先验证官方 binding 允许的两种顺序。
2. BTW `historyFloorSeq` 只过滤 durable projection。先确认 fork/reconnect 的 Client event window 是否实际携带 floor 前 transient，再决定是否过滤 live overlay 和图片查找。
3. `traceDetail` 的 raw events 与 relationship 来自两次读取。先构造日志截断/替换证明可见的不一致，再选择同 snapshot 计算或全身份复核。
4. 普通 cold Session 的文件/presenter 读取会 `resolveAgent`。Host README 允许 ordinary cold resume，但更宽泛的 passive 文档存在冲突；先由产品明确例外，不要贸然改变激活行为。
5. `changelog` reference 的首次退出失败未完全归因；保留原始 ANSI，不能将其写成 candidate 缺陷。
6. marketplace 中 `mayfly-host` 的最终 native 删除行为未验证。T20 先修展示与保护，不得声称当前已能自我卸载。

# 明确不属于本轮修复的内容

- MCP configured-server/transport-health 完整目录：当前官方 alpha.2 没有公开能力，保持 unknown 和可选 sanitized face，不读取私有 Loader 状态。
- Remote TUI 扩展热挂载：仍需源码集成和重启，不新增私有热加载通道。
- 冷 child 的 live-only 自定义 presenter/control：保持通用 durable card 和显式 unavailable，不激活 child 或借用 parent Agent。
- `/update` 的隔离 Host boot check：继续明确需要重启验证，不伪造启动成功。
- immutable rc.2 自身 `/files` 和 Trace 缺陷：不得修改 reference；candidate 只有独立复现失败时才另立任务。
- `panels/stats` 的原生数据差异：只能按 `docs/split-parity-validation.md` 做逐字段审查，禁止用宽泛 normalization 或重写 golden 消除。

# 每个任务的最低验证

```sh
pnpm run verify:changed -- --plan
pnpm run verify:changed
```

按任务补跑对应 focused specs。涉及公共 seam、包导出、依赖或 composition 时，还必须确认：

```sh
pnpm run check:lib
pnpm run check:pack
pnpm run check:examples
pnpm run check:agent-docs
```

阶段完成和最终验收：

```sh
pnpm run verify:full
```

Runtime 行为还需在专用 profile 做真实 Host/Remote smoke：

```sh
DSH_BIN=/path/to/dsh PROFILE=mayfly-split-fix script/install-dev.sh
dsh --profile mayfly-split-fix
MAYFLY_DSH_STARTUP_URL='<Host readiness URL>' script/mayfly-remote.sh
```

至少验证：主 prompt/工具流程、双 Host 或 reconnect 的隔离案例、readonly 拒绝、窄宽度、关闭面板/detach 后 Host 继续工作。架构或公共合同改动还需真实 HTTP/WebSocket + PTY 证据。所有测试结束后检查 `git status`，删除不需要的临时输出，停止本次启动的进程；保留有价值的复现证据。

完成定义不是“某个单测过了”，而是：原复现失败、修复后同一场景通过、邻近路径不回归、适用门禁执行并记录结果。若基线已有的 strict parity/native-difference 问题尚未审查，必须明确报告剩余红项，不得宣称完整验收通过。
