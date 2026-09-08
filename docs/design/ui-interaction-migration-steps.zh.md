# 交互模型完全迁移：逐步执行方案

日期：2026-09-07；状态更新：2026-09-08。执行位置：
`/home/x/dev/deepseek-harness-plugin/mayfly-ui-interaction`；分支：
`refactor/ui-interaction`。Step 1 至 19 已完成；用户于 2026-09-08 接受最终
Website/profile 候选，Step 20 正在执行验收后合并清理。

当前事实见 [续做核查](./ui-interaction-resume-plan.zh.md)，协议与行为目标见
[详细设计](./pr15-interaction-refactor-plan.zh.md)。最新候选已通过全仓 typecheck、
lint、逐文件 100% coverage 与完整发布门禁；Step 19 的 Website/profile 人工验收
也已完成。

## 执行约定

按下面 20 步顺序推进，每步包含代码与对应测试。前一步的局部完成条件通过后才进入下一步；发现共享协议缺陷时返回其所属步骤修复。前期不要求尚未迁移的全部旧测试通过，但必须记录剩余失败，不能用恢复旧协议、放宽断言或降低覆盖率阈值消除失败。

每个检查点记录变更文件、实际执行的命令和结果、剩余问题、下一步。提交按已完成的职责组织，显式选择文件；`.artifacts/` 和无关 checkout 的改动不进入提交。技术步骤完成后统一提供最终 profile，用户逐项体验并讨论交互；所有适用人工验收通过后才合并。

以下 `core/`、`interaction/`、`frontend/` 指 `packages/mayfly/src/` 下对应目录。新文件仅在实际职责需要拆分时创建；不新增公开 UI service、通用 Panel DSL、兼容 facade 或产品状态单例。

## Step 1：固定执行基线和消费者清单

依赖：无。

操作：核对 HEAD、工作树差异、现有 build 和最新门禁日志。建立消费者清单，逐项记录 native API、app/session/request scope、共享控件、操作、取消、尺寸和旧入口。将失败分成夹具缺失、旧协议断言、真实回归、性能/超时四类。Codex 会话 ID 只用于工作接续，不用于 Harness resume。

产物：本文件末尾的清单作为工作台账；继续引用最新核查结果。若源码没有新变化，不为重复取得同一失败数字再跑一轮完整门禁。

完成条件：每个生产入口和公开消费者都有归属；已有实现、尚未实现和待验证有明确区分；下一步可以直接定位到文件。

## Step 2：修正服务依赖和测试夹具

依赖：Step 1。

修改范围：`frontend/index.ts`、`interaction/index.ts`、`commands-plugin.ts`、`trace-command.ts`，以及 pane/overlay bridge、command、theme-switch、e2e 的 fixtures。

操作：修正实际读取 overlays 等服务却未声明的依赖；把 app 级注册与精确 Agent 级动作按实际 Fiber 生命周期拆开。测试显式加载 UI provider 和稳定 frontend owner；不在 interaction 缺服务时再创建 skills/questions。Jobs 保持现有独立 composition sibling。把市场页关联、缺失动作、update 取消不结算等已定位问题转为可重复的新协议轨迹，交给后续所属步骤修复。

验证：有依赖时命令正常注册；缺失时等待或给出明确可选服务结果；registry 卸载后移除旧贡献，恢复后只注册一次。重跑受影响的 fixture/命令注册测试。

完成条件：夹具能驱动当前生产注册图，服务缺失与生命周期失败不再混同为旧断言错误。

## Step 3：收敛公共事件与回执契约

依赖：Step 2。

修改范围：`packages/ui/src/interaction.ts`、`contracts.ts`、`services.ts`、`snapshot-events.ts`、`builders.ts` 及公开类型 fixtures。

操作：在现有 registration 上区分 observation 与 action 的类型约束。可写提交必须返回结构化 settlement；只读 change 不隐式写领域。固化 pagePath、form/selection 地址、source stamps、提交边界和部分成功。data 保留有效草稿，replace 创建新实例语义，ack 仅由当前 operation 的 prepared publisher 发布。completion 和 submit transform 使用符合其请求性质的 context，避免伪造 action 身份。

验证：编译期拒绝无回执的保存、非法事件载荷和 renderer 对象；运行时保留冻结、循环/accessor 拒绝、重复/晚到 ack、同名重开、隐藏分支局部准入的覆盖。Provider 和外部 overlay 都实际消费最终签名。

完成条件：公开调用方使用同一契约；没有旧字段别名/转换桥；新增字段有真实消费者。status/editor decoration 仍保持较窄 node union。

## Step 4：补齐 operation、关闭和父子生命周期

依赖：Step 3。

修改范围：`core/ui-interaction-state.ts`、`ui-interaction-surface.ts`、`interaction/ui-overlay.ts`、`agent-overlay.ts`、`request-overlay.ts`、`update-command.ts`。

操作：统一单次操作防重、read latest、提交锁、取消、回执准入和部分成功。区分 registration、replacement、draft、native source 与 renderer generation。子 UI 使用所属 UI/request 的 lifetime，不能挂在已经结算的 operation signal 上。为等待确认、可取消工作、不可中断写入明确共享关闭策略；外部写入已开始时不把 UI 关闭解释为回滚。

立即修复 update 两条回归：确认页 Esc/registry close/unload 必须结算取消并释放 in-flight guard；执行中的 swap 按声明策略控制关闭，不能因为 dismiss handler 返回 completed 意外撤下进度页。

验证：重复保存一次写入；同 ID 重开不接纳旧结果；同 session ID 替换 live Agent 后旧 action 失效；renderer 重建不取消仍有效的业务动作；原生写入成功但 UI 准入失败时不自动重发写入。确认和进行中关闭轨迹经过真实 registry。

完成条件：所有挂起请求均有明确终止路径；关闭、隐藏、卸载和业务取消的含义不会互相替代。

## Step 5：完成共享 Form、Choice、Tabs、Wizard 和确认

依赖：Step 4。

修改范围：`core/ui-interaction-form.ts`、`ui-interaction-choice.ts`、`ui-interaction-field-actions.ts`、`ui-interaction-surface.ts`、`ui-validator.ts`、`ui-compiler.ts`。

操作：确认每个 surface 只有一份草稿、选择、页面和步骤状态。落实聚焦导航、Enter 或直接输入进入编辑、Tab 零保存、显式 Save、跨页一次提交、返回保留、隐藏与删除区别、默认 No 的共享确认。数值保留 raw 中间态，多选保留合法空集合；支持 inherited/explicit/reset 和秘密字段的必要内存清理。

验证：用同组轨迹驱动官方 Provider、外部双页 overlay，并扩到 pane：刷新三方协调、字段错误、提交失败、部分成功、并发 data/ack、tab 重排/删除、同名地址隔离、dirty dismiss、候选删除和 wizard completion 失效。

完成条件：消费者不需要保存 values/cursor/tab 或通过每次 set 回声维持编辑；文本原文、secret、Other/空答案等语义不被通用规范化破坏。

## Step 6：统一动作查询、输入路由、按钮和提示

依赖：Step 5。

修改范围：`core/ui-compiler.ts`、`keymap.ts`、`index.ts`、`screen.ts`、`interaction/keys.ts`、`input-plugin.ts` 和 hints/help 数据源。

操作：从当前模型派生 AvailableActions，包含稳定 action/address、enabled、disabledReason、pending 和目标版本。core 合并实际 keymap 和终端能力，使按钮、键盘、鼠标、hint 使用同一动作查询。输入先经过活动 capture scope，再按当前 editor/search/picker/页面决定语义；没有消费的输入才进入后续路由。

验证：真实改 keymap 后提示与行为一起变化；文本搜索输入 `install` 不触发 i/u/r；表单 Delete/Ctrl-D 不变成实体删除；捕获面板期间 F7/F8/Tab/Esc 不穿透 prompt；中文输入、粘贴和原生 caret 行为保持。

完成条件：已迁移消费者没有 raw key 分派和另一份快捷键文案；disabled/busy 动作经任一输入方式都不能绕过。

## Step 7：真正接入 Document 语义锚点

依赖：Step 5、6。

修改范围：已有 `core/ui-interaction-document.ts`、surface state、compiler 和 ScrollView/scrollable panel 绑定；实际消费者使用 Jobs output 和 trace/detail。

操作：把 block ID、源文本 offset、follow 意图存入稳定实例；实际行号和布局映射留在 renderer。输入更新语义锚点，resize/reload 按锚点恢复；内容变化协调位置。完成有限配额分页、超长行和 surrogate pair 边界；页码与页内位置分别处理。

验证：阅读中 prepend/append/删除段落、改变宽度/主题、卸载 renderer 再挂载，仍回到对应内容；follow=end 与手工滚开行为区分。反复 render 不改模型、不重新读 native Job 输出；极短窗口仍能访问全文和操作。

完成条件：现有 Document helper 有生产调用和集成测试；恢复依赖语义位置，不依赖旧行号或保活组件。

## Step 8：完成 Tree 与 Search 的共享行为

依赖：Step 5、6。

修改范围：`core/ui-interaction-choice.ts`、列表准入/索引和 compiler；`interaction/session-tree.ts`、sessions/agents 消费者。

操作：基于声明的 parentId/tree 构建关系与可见节点索引，校验重复 ID、自引用和环；固定孤立节点规则。共享正常展开集合、搜索临时展开集合、父子导航和焦点协调。搜索显示匹配节点及祖先，清空后恢复原展开与有效锚点。不要把当前声明遍历文件 `ui-interaction-tree.ts` 当作已经完成的 Tree reducer。

验证：折叠节点下的深层匹配可达；搜索清空恢复；排序/删除/禁用/插入后的焦点稳定；输入字符优先搜索；大树滚动不每帧扫描全量业务资料。

完成条件：sessions/agents 不再通过闭包 expanded/selectedId 模拟共享树交互。

## Step 9：完成统一通知与反馈基础

依赖：Step 4、6、7。

修改范围：frontend 稳定 owner、core feedback 出口，必要时新增职责明确的 notification 模块；现有 `UiSurfaceModel.feedback` 接入相同生命周期。

操作：内部记录带 Fiber/registration、scope、operation、severity、purpose、摘要/详情、可见累计时间和处理状态。success/info 累计可见 5 秒；隐藏暂停；progress 随操作结算；warning/error 保留至处理/替换/scope 结束。授权指引留在授权 surface，当前状态留在状态投影。记录数量/正文/长任务有界，普通 success 不能挤掉未处理关键失败。

验证：面板期间错误可见；长文可打开详情；两个 operation 的进度、失败、清理交错而互不覆盖；晚反馈、Agent 切换、注册卸载、敏感字段脱敏和可见时钟正确。计时不在 render 中推进。

完成条件：官方后台任务有内部受归属约束的入口；外部使用 action reply/report 和四个既有 UI service，不增加公开 notifications service。

## Step 10：迁完 editor extension 的三类请求

依赖：Step 3、4、6、9。

修改范围：`interaction/editor-extension-runtime.ts`、`editor-instance.ts`、`prompt-submit-pipeline.ts`、`core` editor-shell binding、UI registry 和外部示例。

操作：decoration action 使用共享 operation、确认、反馈和 prepared reply，删除独立 action FIFO/timeout/notice 路径。completion 保持原生 editor 的 query/caret latest 语义；transformSubmit 绑定一次 prompt attempt、有序执行，全部成功后提交一次。renderer 卸载只撤销适用的 editor binding/read，不取消仍有效的独立领域 action。

验证：重复 action、结构化失败/进度、注册替换、completion 晚结果、transform 失败后的原文/附件恢复、Agent 切换和 shell reload。外部插件通过正式包导入使用最终 API。

完成条件：三类请求各有正确生命周期，均没有独立业务草稿或丢弃结构化回执；撤销旧变量名不被当作迁移证据。

## Step 11：复核配置与请求型消费者

依赖：Step 5、6、9、10。

修改范围：Provider 编辑/添加/首启/OAuth，settings，model/effort/preset，permission/plan，questionnaire/questions/approval/request-overlay。

操作：逐项对齐最终协议，删除残余业务编辑状态；让原生写入只从明确 action 发起。配置值和 revision 同次读取，Save 只写变化路径；凭据与设置部分成功只重试未完成部分。OAuth notify 和子 prompt 独立处理，用户拒绝、prompt.signal 撤回和整个授权取消保持原生区别。请求 FIFO/allowance 留在原生请求消费者，结算不得早于有效 UI 回执。

验证：Provider 和外部表单成对测试；只读配置、schema/默认值更新、document-updated、secret 不回填；权限 no-op、plan/YOLO 独立；空问卷/Other/多选/反馈原文；OAuth 超过 5 秒与 30 秒、renderer reload、撤回和晚到结果。

完成条件：这些已改写消费者在最终协议下全部通过，且没有为其他迁移重新引入私有状态和按键。

## Step 12：完成目录型消费者与市场

依赖：Step 5 至 9、11。

修改范围：`plugin-commands.ts`、`frontend-panel.ts`、`help.ts`、`info-panel.ts`、tools/MCP/skills 命令及 version/changelog 信息页面。

操作：市场直接声明关联 tab 的列表子树，明确选择输入产生可用动作；删除业务 selectedId/panelStatus 和 FrontendPanelDocument 运行时转换依赖。详情由浏览器子 Fiber 管理；Install/Uninstall/Refresh 进入 operation 并重读真实安装状态。Tools/MCP/Skills 复核精确 Agent、保密与不执行领域动作的浏览边界；Help 从实际动作与 keymap 产生内容。app 级静态页面不依赖 current-Agent/skills 的存活。

验证：首次打开就能完成选择和安装/卸载；tab 只显示对应组；搜索不误触发；离线/刷新失败/安装失败与回滚；详情返回、重复打开、locale 切换、父视图关闭。浏览工具/skill 时 native 执行次数为零。

完成条件：市场页面与动作两条已知回归消失；Help/Info 不再构造旧 renderer controller；现有 installer 校验和 profile/source 规则保持。

## Step 13：完成会话、Agents、Jobs、Trace 与只读历史

依赖：Step 7 至 9、12。

修改范围：session 浏览/rewind、`agents-command.ts`、`session-tree.ts`、`session-transcript-panel.ts`、Jobs、Trace、app 辅助目标与 core 固定 host。

操作：sessions/agents 接共享 Tree/Choice，动作执行前重读 native live/continuable/权限并传精确 Agent；Stop 结果经过结构化反馈。Jobs 保留显式消费式 Read 和有界页，列表/详情/翻页不额外消费。Trace 保留原生顺序、完整详情、复制当前项/全部与子页面清理。readonly transcript 继续使用既有完整 renderer/source，移动 shell、焦点和挂载到 core；app 只保留辅助目标选择。

验证：真实 Harness session 新建/恢复/fork/rewind；同 ID Agent 替换；cold/one-shot 完整历史、工具、图片和 observation dispose；F7 隐藏恢复、F8 关闭；Job read 次数与停止终态；长 trace/超长行的全部内容可达。

完成条件：最后一个生产 `mountEditorReplacement` 调用得到完整替代；不把只读历史降级为截断纯文本，不复制 Harness 会话事实。

## Step 14：完成更新流程和全部旧通知生产者

依赖：Step 4、9、12、13。

修改范围：`update-command.ts`、`update-notice.ts`、`updater/check.ts`、`input-plugin.ts`、paste-image/editor-plus、命令结果及其余 notice 调用方。

操作：更新全程按同一 app/profile operation 呈现 preflight、确认、swap、校验、回滚和最终详情；保留既有宿主选择及版本检查。把 prompt 错误、复制/粘贴、后台更新、市场结果等逐个迁入结构化通知，删除预染色文本和空串跨操作清理。queue 只投影 user 来源；内部 inbox 原样由 native 使用，过滤空时没有空分隔 pane。

验证：update Esc 后可再次启动、进行中关闭策略、重入防重、执行抛错/失败回滚、consumer unload 和晚结果；全部通知生产者在面板可见、隐藏、切 Agent、重载时归属正确；附件-only queue 有摘要。

完成条件：没有生产 notice 字符串协议或各消费者私有 TTL；原有领域状态/输出没有被错误搬入通知历史。

## Step 15：删除旧通用控制器与组件栈

依赖：Step 10 至 14。

修改范围：`canonical-panel.ts`、`frontend-panel.ts`、`select-list.ts`、`info-panel.ts`、`help.ts`、`confirmation-panel.ts` 中已无必要的通用控制器；`editor-panel-controller.ts`、`editor-dock-host.ts`；已删除 form/select 的剩余引用、旧 component APIs 和 tests。

操作：按实际引用删除，保留仍需要的纯领域投影并放入对应业务模块。prompt 的物理 host/输入绑定归 core，语义草稿和导航归稳定实例。删除旧 raw key、leaf/window、无限 viewport、renderer 对象保活和 compatibility export。更新相关边界检查中的精确 baseline，不能删除边界检查本身。

验证：搜索加导入/AST 约束证明生产调用退出；typecheck/build 无缺失导出；compiler 和角色测试接管原通用交互断言。原领域行为测试仍有效，只有被完整替代的旧 controller 测试随类删除。

完成条件：业务新增 Form/Choice/Tabs/Decision 只需要 readonly 声明和 native action；没有遗留第二套通用状态/事件路径。

## Step 16：补齐整树生命周期、覆盖率与性能证据

依赖：Step 15；相关测试此前随各步同步编写。

修改范围：`packages/ui/tests`、core/compiler/bridge/width specs、interaction specs、whole-tree e2e、examples tests 和已有业务边界扫描。

操作：补齐每个实例的 core/theme/app/skills/provider/consumer/frontend reload 矩阵；证明按真实依赖保留或清理，不让 stub-only e2e 代替生产消费者。整理仍有效的旧断言，补每个执行文件的分支覆盖。检查重复 render 的语义纯度、按控件局部通知、大列表窗口化和长 Document 更新成本。单独定位全量 coverage 下 CJK Job output 超时的原因。

验证：宽度至少 20/40/80/160 列及 owning 扫描范围，短高度、main/alternate、CJK/组合字符/长 URL、鼠标/键盘；Save/Cancel/错误始终可达。为所有跳过项记录原有平台条件，不能把新失败变成 skip。

完成条件：每条显式设计要求都有对应断言或待人工场景；当前失败全部有处理结果。最终完整覆盖率在 Step 18 统一证明，不在其前重复执行一轮 plain test。

## Step 17：同步公开文档、示例、包契约和截图

依赖：Step 15、16，运行时协议已稳定。

修改范围：`docs/mayfly-architecture.md`、`mayfly-seams.md`、相关 AGENTS、中英 README、Website 插件文档、shipped skills、examples、package manifests/types/files 和截图。

操作：描述最终所有权、交互规则、事件/更新迁移方式；历史审计保留时点。逐个验证 pane/overlay/status/editor-extension 的实际外部消费者，ecosystem 仅负责组合。确有 subpath 变化时同步 export/source/types/files；不预设新增 subpath/row，不刷新 Harness 依赖线。对破坏性公共协议明确候选版本及升级说明。终版 build 后同步截图。

完成条件：中英用户文档一致；公开契约没有无人使用字段；没有文档教旧接口；依赖和发布变化有明确原因。AGENTS/skill 修改执行 `check:agent-docs`，截图执行 sync/check，Website 修改走严格 build 和后续 LAN 验收。

## Step 18：运行完整发布候选门禁

依赖：Step 17。

在工作树执行以下命令；若最终源码没有额外变化，不重复完整 coverage：

```sh
pnpm run verify:changed -- --plan
pnpm run verify:full
pnpm run check:pack
pnpm run shots:sync
pnpm run shots:check
pnpm run website:build
```

`verify:full` 已含 workflow/typecheck/lint/diagrams/build/lib/agent-docs/examples/完整 coverage/happy smoke；不再逐个重复其中已经通过的命令。截图同步和 Website build 按实际变更需要执行；本次模型迁移的公开插件文档和截图应纳入最终候选。若修复代码使前置结果失效，重跑对应检查，最终源码版本必须拥有完整通过证据。

完成条件：全量可执行源码逐文件 100%，所有 applicable checks 通过；没有借 frame clamp、覆盖排除、放宽阈值或删除仍有效测试通过。记录确切 commit/差异、Node/pnpm、构建和测试结果。

## Step 19：安装最终 profile 并逐项人工验收

依赖：Step 18。

采用一个明确的工作树 profile，例如：

```sh
PROFILE=mayfly-ui-interaction script/install-dev.sh
dsh --profile mayfly-ui-interaction
```

源码调整后重建，依赖图变化才重装。执行相关 `smoke:pty`、`smoke:pty:mouse`、`smoke:pty:output`；这些现有脚本使用临时 profile，不能把其通过写成最终 profile 已验证。另实际启动上述命名 profile，核对加载路径、主要命令及会话工作流。

按 [续做核查](./ui-interaction-resume-plan.zh.md)“人工验收顺序”的清单给出工作流、期望、失败/窄屏/lifecycle 和相邻不回归行为。体验顺序为表单/选择、页面/树/文档、OAuth/请求决定、市场/Jobs/更新、prompt/会话/扩展；逐项记录用户决定与后续修改。

Website 有变更时，以可用端口运行 `pnpm --dir website exec vitepress preview . --host 0.0.0.0 --port <port>`，给出 `http://<实际局域网IP>:<port>/` 的受影响路由。保持 preview 和 profile，等待每项适用人工验收；视觉调整进入原步骤的代码/测试循环。

完成条件：用户逐项接受最终交互；后续改动对应检查已重新通过。profile 能启动只是其中一个场景，不等于全部迁移完成。

## Step 20：验收后合并和清理

依赖：Step 19 的全部适用人工验收。

操作：整理最终变更与验证记录，按仓库流程合并候选分支；冲突或合并结果改变代码时验证受影响行为。主 checkout 重新 build，使 main 的 `lib/` 对应合并源码。之后才停止 Website preview、移除工作树 profile、清理 worktree，并记录实际验收路由和场景。共享生产 `mayfly` profile 不用作提前验收入口。

完成条件：实现已合并、主构建已刷新、验收证据可追溯，临时资源在验收后清理，用户原有无关改动和 artifacts 得到保留。

## 消费者完成矩阵

下面每行都必须有最终协议下的生产调用、领域行为测试、取消/晚结果证明和适用尺寸覆盖。不能仅填写“已改成 overlay”。

| 消费者 | 主收尾步骤 | 必须保留的特殊行为 |
| --- | --- | --- |
| Provider/add/首启 | 11 | app 生命周期、descriptor revision/path ops、凭据部分成功 |
| OAuth | 11 | 持续 URL/code、prompt.signal、decline/abort 区分、敏感引用清理 |
| Settings | 11 | schema、继承/override/reset、secret、原有文件入口、raw revision |
| Model/effort/preset | 11 | 精确 Agent、原生选择、idle/turn boundary、部分持久化失败 |
| Permission/plan | 11 | 完全访问明确确认、no-op、plan/YOLO 独立 |
| Questions/approval/plan review | 11 | FIFO/allowance、Other/空答案、默认拒绝、原生单次结算 |
| Tools/MCP/Skills | 12 | 精确 Agent、只读浏览、脱敏、共用 skills catalog、子详情清理 |
| Status/context/usage | 11/12 | 原生 projection 一次读取、统计定义与估算含义保持 |
| Version/changelog/help | 12 | app scope、真实按键提示、完整可滚动正文 |
| Market | 12 | tab 内容、首屏动作、离线/安装/回滚、profile/source 检查 |
| Sessions/rewind/agents | 13 | 原生关系与 authority、Tree/Search、恢复/查看/停止 |
| Readonly auxiliary transcript | 13 | 完整历史、cold observation、图片/工具、core 宿主 |
| Jobs | 13 | 普通 sibling、显式消费读取、分页不重读、原生终态 |
| Trace | 13 | 原生事件顺序、完整详情、有界页、复制与 scope |
| Update | 4/14 | 取消结算、preflight/swap/回滚、进行中关闭与最终详情 |
| Editor extensions | 10 | action/completion/transform 各自生命周期及一致回执 |
| Prompt/附件/queue/后台通知 | 6/14 | 原生输入与附件、user 来源、operation 归属和可见时钟 |
| 外部 pane/overlay/status/editor | 3/5/10/17 | 同一协议、冻结与准入、packed consumer、Fiber 清理 |

## 完全迁移的判定

技术完成要求 Step 1 至 18 的产物和证据齐全，生产中所有同角色消费者使用共享状态和动作路径，旧通用控制器退出。交付完成还要求 Step 19 的用户验收及 Step 20 的合并、主构建和清理。测试通过、文件改名、profile 启动或视觉相似，均不能单独替代上述完成条件。
