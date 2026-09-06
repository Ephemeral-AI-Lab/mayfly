# Mayfly UI/UX 交互重构实施计划

状态：待实施。依据 [统一模型设计](./ui-ux-unification.zh.md)，编码从当前主分支建立专用 worktree；原始审计基线是 `bd171aa`，本计划对照 `b57eb0d`。这份计划不表示运行时或公共 API 已经改变。

## 1. 交付边界

先证明“共享控件行为 + 每个 surface 的唯一状态 owner”可用于真实编辑流程，再扩大迁移。frontend 只协调跨 surface 的导航、输入和操作/通知索引；原生 dsh 继续持有授权、Agent、设置、Job 和更新的领域事实。

下文批次可以形成独立提交和评审，但不等于每批都能正式发布。独立缺陷修复可单独验收；采用新公共协议的试点先留在候选分支，相关控件的官方与仓库内外部消费者迁移闭合后才能发布。不给外部插件增加特殊 CLI、私有 realm、第五个 UI service 或长期兼容 export。

| 批次 | 依赖 | 交付物 | 进入下一批的条件 |
| --- | --- | --- | --- |
| A. 协议与场景 | 无 | 新旧契约差异、类型方案、参数化事件轨迹、owner 依赖图 | 设计 4.6/4.7 的每个分支都有确定输入输出 |
| B. 稳定 owner 与成对试点 | A | 官方 Provider 编辑 + 外部 overlay；最小共享 Form/Choice、actions、navigation | 设计第 11 节六项强制场景与人工验收通过 |
| C. 通知和授权指引 | B | 可见 feedback、通知归属、OAuth 持续内容与子 prompt | 五个通知回归、完整 OAuth 生命周期、短终端验收通过 |
| D. Form/Choice 全类迁移 | B；OAuth 部分依赖 C | 配置、Provider、startup、设置枚举、多选和公共消费者 | 同类控制器状态删除，公共契约与用户行为迁移闭合 |
| E. 复合交互迁移 | C、D | Tabs/Tree/Document、市场、问卷、审批和计划评审 | 每种角色的官方/外部 conformance 及原生结果保持测试通过 |
| F. 发布与收尾 | C、D、E | 完整 composition、升级文档、截图、发布闭包 | 全部门禁和适用人工验收通过 |

实现前重新核对主分支，避免把 PR #14 已完成的 Yes/No 和权限解耦重复实现。原始审计中的 P1 可先在单独分支修复：queue 按 source 分类、官方表单末字段 Tab 不保存、面板期间错误可见。修复应落在现有共享实现，并在后续迁移中保留回归；每项按实际 blast radius 执行 gate 和 profile 验收。

## 2. A：协议与测试输入

代码范围：`packages/ui/src/contracts.ts`、`builders.ts`、`services.ts` 及对应测试；先阅读 `packages/ui/AGENTS.md`。具体实现只扩展已有 readonly node、registration metadata 和 callback 合约，保留四个 contribution service。

1. 固化 baseline/draft、data/ack/replace、提交 draft revision 与 operation 回执。把选择变动和接受选择拆成事件；结构化字段校验留在注册层。
2. 固化 `MayflyUiChild.tab` 的页面关联、控件事件页面路径、同名字段隔离、页面暂时隐藏与真正删除的区别。source update 不再依赖对象身份或 label。
3. 写下新旧协议差异，列出所有 `onEvent` 和 `set(..., { eventRevision })` 消费者。新协议的默认 data 语义只能随明确版本升级发布，不能悄悄改变现版本的 external replacement。
4. 建立参数化 conformance 输入：同一 Form/Choice 场景分别挂到官方 editor replacement 与公共 overlay；断言草稿、原生调用次数、事件归属和渲染可见性，不写仅复述 reducer 的测试。

回执测试需覆盖重复 ack、错误 operation ID、旧注册同名 ID、提交时并发 data、无 native revision 的冲突处理。冻结/准入继续拒绝 accessor、cycles 和 renderer 对象；页面关联不能引入隐藏分支的全量编译或大列表扫描。

本批协议代码与 B 的真实消费者一起形成可运行候选，不把无人消费的公共类型扩展单独发布。

## 3. B：稳定 owner 与成对可编辑试点

| 区域 | 编码工作 |
| --- | --- |
| `src/frontend/index.ts` | 在既有 frontend sibling 挂载内部稳定服务；不 export 新运行时 API，不注入 app/skills/theme/terminal |
| `src/core/` | 建立不传递导入终端的 `ui-interaction-state.ts` 和按需拆分的 Form/Choice reducer；注册实例索引、reconcile、局部 operation/busy 与字段错误归属 |
| `src/core/ui-surface-state.ts`、`ui-compiler.ts` | 收拢现有草稿和列表逻辑；编译器读实例状态、提交语义事件；保留原生 editor、窗口化、宽度与局部失败机制 |
| `src/core/surface-renderer.ts`、`index.ts` | registry 观察从 renderer 生命周期移到稳定 owner 的独立订阅子 Fiber；renderer 只绑定/解绑；试点 action 统一执行和防重 |
| `src/interaction/canonical-panel.ts`、`form-panel.ts`、`editor-panel-controller.ts` | 为试点提供结构化 surface 注册；解除 theme/input 的注册依赖，使用同一协议恢复父级草稿与焦点 |
| `src/interaction/provider-add.ts` | 迁移 Provider 编辑表单的节点定义、原生 settings/credentials action 和结构化错误；不复制 UI 草稿 |
| `examples/mayfly-ecosystem/` | 增加通过原生 settings namespace 实际读写的外部配置 overlay，使用同一 Form/Choice 与两个 tab；验证完整普通 Cordis composition |

上述 `src/` 指 `packages/mayfly/src/`；新文件名是实施定位，不要求预建空的 Tree/Wizard/Notification 总框架。外部例子沿用 owning package 的 AGENTS 和测试模式。

稳定服务由 frontend Fiber 持有，每个注册单独拥有可变状态；作用域索引不把 Agent/Session 放入 node。Agent-scoped 业务 action 在发起时捕获精确 Agent authority，并在执行和结算时校验对应作用域。消费 current-Agent/skills 的业务 Fiber 真正卸载时必须清理，独立静态外部 UI 则保留。

Provider 配置试点属于 app scope：将其贡献挂载到现有 frontend sibling 的独立业务子 Fiber，仅依赖必要的原生 commands/settings/credentials 等服务。只迁出 input 子 Fiber 仍会受 interaction 父 Fiber 的 current-Agent/skills 依赖影响，不能通过稳定性验收。该挂载调整随实际生命周期变化更新包指引及 bundle 测试。

Provider settings 与 credentials 是既有的多个原生写入步骤，通用 operation 不把它们伪装为事务。部分成功时由业务 handler 重新读取实际状态并返回明确失败/冲突，不把“取消”或 UI busy 当作回滚。

本批验收必须覆盖设计第 11 节全部六项；重点是后台刷新与草稿冲突、失败不丢草稿、renderer/core/theme reload、真实 app/skills 卸载，以及旧结果不能污染重开的同名 surface。只读 Document 和 Yes/No 可作为辅助场景，不能替代表单。

在此设置停止扩张条件：若仍需业务维护草稿、为 tab 猜测 reset 或保留已卸载 renderer 实例，回到 A/B 修改；不提前迁移其他命令。

## 4. C：通知与授权指引

主要文件：`interaction/input-plugin.ts`、`editor-instance.ts`、`editor-dock-host.ts`、`provider-add.ts`、`settings-command.ts`、`plugin-commands.ts`、`jobs.ts`、`agents-command.ts`、`preset-commands.ts`、`update-notice.ts`、`updater/check.ts`，以及 core 固定 slot 的实现。

1. 接入按 ID、operation、owner 和 scope 更新/清理的反馈记录；severity 和 purpose 是结构化数据。feedback 在 editor replacement 打开时仍可见，不移动固定 root host 顺序。
2. 逐个迁移 notice 生产者，删除跨操作的空串清除与预染色。恢复警告、长输出、队列和当前状态按设计保留各自语义。
3. 将 OAuth notify 的 message/URL/code 放入授权 surface 的持续指引；prompt 和查看全文/复制/取消在 capturing 面板里可达。父 operation 等待子 prompt 时，只限制重复启动，不能阻塞子交互。
4. 认证完成、失败、取消、超时或 owner unload 后释放敏感引用；迟到的 notify/prompt 不重开面板。五秒摘要计时只用于短反馈 success/info。

验证：把五个临时通知探针对应的期望行为加入持久回归。OAuth 使用可控 authorization mock，先 notify 再 prompt，等待超过五秒、覆盖面板、切 tab、reload，再分别结算/取消；断言完整 URL/code 仍可访问且不会进入历史或审计输出。PTY 同时检查短高度与窄宽度。

## 5. D：Form/Choice 全类迁移

主要文件：`interaction/form-panel.ts`、`select-list.ts`、`select.ts`、`settings-command.ts`、`provider-add.ts`、`provider-onboarding.ts`、`questionnaire.ts` 中对应的基础选择逻辑，以及使用公共 Form/List 的 examples。

按配置表单、独立枚举、OAuth select、数值/集合、多选依次迁移。显式 Save/Cancel、导航零写入、空集合基数和 no-op 共用同一规则；Boolean 独立 toggle 仍可即时执行明确 action。保留原生 settings revision 校验、credentials 处理和 permission 命令语义。

每个消费者改为 readonly 定义和 action handler 后，删除该消费者的 values/editing/cursor/零选中回退；最后删除不再有消费者的转换路径。问卷此时复用 Choice，完整 Wizard 的跨题导航留给 E，不能再拼 `[x]` 冒充多选。

验收覆盖 Provider 凭据编辑/删除取消恢复、startup、设置枚举的完整候选、OAuth text/secret/select、数值中间态、多选零集合和公共 overlay/pane。原生写入次数、失败保留和精确 Agent scope 都必须断言。

## 6. E：复合交互与完整动作路由

依次迁移 `frontend-panel.ts` 和 `info-panel.ts`，再到 `session-tree.ts`、sessions/agents、市场和模型选择器，最后是 `questionnaire.ts`、`approval-plugin.ts`、`plan-review-panel.ts` 与公开 `action.confirm`。

共享 Tabs/Tree/Document 只承接页面、过滤、展开、滚动和语义动作。Job output 的消费式读取、分页 cursor 与有界文本页仍由业务/native 读取路径持有；不把输出重新变成 canonical snapshot 内的大缓存。

在 `core/keymap.ts`、`core/index.ts`、`core/ui-compiler.ts` 收敛完整输入优先级和 `availableActions`，让实际匹配、可用性和提示同源。删除已迁移 feature 的 raw `handleInput` 与手拼 keys；保留 prompt 的 Enter/Tab/Shift+Tab/Ctrl+S 约定，F7/F8 遵守 capturing scope。

审批、计划评审和问卷只共享 Decision/Wizard 控件，不重写原生 outcome。验收包含默认不执行、重复确认、目标变化、原生请求 abort、Agent 切换，以及取消后返回原实例。市场直接输入搜索不得触发 i/u/r 业务动作。

## 7. F：发布闭包与验收记录

删除无消费者的转换边界，更新 `docs/mayfly-architecture.md`、`docs/mayfly-seams.md`、相关包 `AGENTS.md`，同步受影响 README 中英版本和 Website 的公开协议/键位文档。仅在实际改变 package subpath 时才增加 entry/export/types/files；本设计通过既有 frontend entry 挂载稳定服务，不预设新增 subpath 或 composition row。

发布说明必须列出新的快照更新协议、选择事件、tab 内容关联、表单提交及确认行为。仓库外消费者通过明确版本和迁移示例升级；已发布旧版本的行为不被追溯改变。

## 8. 每批验证与交付

| 时点 | 要执行的验证 |
| --- | --- |
| 开始编码 | 专用 branch/worktree；读 owning AGENTS；新 worktree 先完整 build，避免 package-name imports 读到旧 lib |
| 每次迭代 | `pnpm run verify:changed -- --plan` 后执行 `pnpm run verify:changed`；按实际变更触发宽度、生命周期与改动文件覆盖率 |
| 公共 UI、架构、composition 阶段交付 | `pnpm run verify:full`；不先重复运行 plain test；manifest/subpath/依赖变化另做 `check:pack`，相关 examples、bundle、preset 验证必须通过 |
| 文档和截图同步 | 按需执行 `check:agent-docs`；renderer 变更在 build 后 `shots:sync`、`shots:check`；Website 改动额外严格构建并提供 LAN preview |
| 运行时人工验收前 | `PROFILE=mayfly-ux-<batch> script/install-dev.sh`，运行相关 headless/PTY smoke；后续源码改动重建，依赖图变化才重装 |
| 人工验收 | 给出 `dsh --profile mayfly-ux-<batch>` 和本批主流程、预期结果、失败/窄屏/lifecycle、相邻不回归清单；等待所有适用验收 |
| 验收后 | 才合并可交付批次；涉及运行时则重建主 checkout；停止 preview、移除 worktree profile，在合并摘要记录场景与路由 |

本计划与设计修订本身只有文档变更，执行文档适用的 change-aware gate 和 Markdown 链接检查，不安装运行时验收 profile。未来编码批次必须遵循上表，不能把本轮文档检查当作运行时验收。
