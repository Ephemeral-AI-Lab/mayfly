# Mayfly UI/UX 统一模型设计提案

状态：分析与设计提案，尚未实施。本文件不替代当前架构文档，不表示下文拟定的内部类型、事件或 API 已经存在。

审视日期：2026-09-06。原始审计基线：`bd171aa`，包含 plan/YOLO 解耦、权限 picker 修复和 Yes/No 确认。设计复审对照主分支 `b57eb0d`，上述修复现已合并；原始探针记录仍对应原基线。

范围：官方命令和面板，以及承载外部插件的四个 UI registry、core compiler、焦点、输入与异步事件路径。结论区分代码事实、已运行的行为探针和建议的新规则。

相关证据：[第一轮交互审视](../audits/2026-09-06-interaction-ux.zh.md)、[通知审计](../audits/2026-09-06-notifications.zh.md)。

编码交付见 [UI/UX 交互重构实施计划](./ui-ux-implementation.zh.md)。本次补齐公共协议、稳定 owner、授权指引和试点门槛；新增协议均为拟实施设计，不是现有 API。

## 1. 结论与目标

当前 Mayfly 统一了大部分绘制，但没有统一交互模型。许多 `Canonical...Controller` 仍自行解释按键、自行保存通用状态，然后把结果转换为同一种 `MayflyUiNode`。不同的内部状态机因此可以画出相似的 UI，却执行不同动作。

建议建立一个 frontend-tree-scoped 的 **UIInteractionModel**：所有 surface 的通用交互状态由它统一管理，状态按 surface/control/session 隔离；同类控件使用同一个 reducer；绘制、快捷键提示和动作可用性来自同一状态与动作描述。

“唯一模型”指唯一权威写入路径和可复用的行为规则。每个列表仍有自己的选中集合，每个表单仍有自己的草稿，但它们是模型中的实例数据，不是各业务功能自建的实现。渲染缓存、不可变快照、原生编辑器的内部缓冲不应成为另一套可独立决策的业务状态。

实施以共享 reducer 和每个 surface 的状态所有权为边界。frontend 协调跨 surface 的导航、输入路由和操作/通知索引；不要求每次按键遍历整棵状态树，也不接管授权、更新或 Job 的领域流程。集中存储的范围由第一阶段的真实可编辑消费者验证后确定。

目标不变式：

1. 导航不写领域数据；只有明确的提交或动作调用才产生领域副作用。
2. 焦点、草稿选择、已经生效的值分别表达，互不冒充。
3. 同种控件在所有命令、pane、overlay 和 editor replacement 中遵循同一规则。
4. 业务模块声明数据、约束和动作绑定；通用 UX 由模型执行。
5. 帮助与提示展示的每个动作都能由同一个输入路由执行。
6. 已卸载、被替换或不属于当前 scope 的结果不能修改另一个 surface 的状态。
7. Harness 仍拥有 Agent、Session、权限、工具、设置和任务领域状态；UI 模型不复制它们的状态机。

## 2. 当前所有权与重复实现

| 状态或行为 | 当前 owner | 结构性问题 |
| --- | --- | --- |
| 文本草稿、正在编辑的字段 | `CanonicalFormController.values/editing/active`；core `UiFormStateStore`、`FocusState`；原生 editor | 功能控制器与 core 互相同步，Tab/Enter 可以被不同层重新解释 |
| 列表焦点与过滤 | `CanonicalSelectController`、`CanonicalDocumentController`、`CanonicalSettingsController`；core `UiListStateStore` | cursor、selectedId、query、filterEditing、分页分别实现 |
| 多选集合 | `CanonicalMultiSelectController.selected`；`Questionnaire.states[].toggled`；公开 list 的 `selectedIds` | 不同分支对零选中和提交采用不同规则 |
| 标签页、组、候选变体 | `CanonicalDocumentController.group/groupId/selectedVariants`；`Questionnaire.tab`；core 的 group focus | 页面状态与焦点同步依赖各自回调，tab 和选项集合容易混用 |
| 审批、计划评审、二次确认 | `ApprovalPrompt`、`PlanReviewPanel`、`createConfirmationPanel`、core `pendingConfirmation` | 有选择列表、数字直达、Yes/No 和二次 Enter 四条决策路径 |
| 滚动与窗口 | Info/Document/PlanReview 私有 `scrollTop`、不同常数；core ScrollView/ListState | 内容高度和页长由多个层决定 |
| 面板栈 | `EditorPanelController.entries`；`EditorDockHost.panels`；各命令的 restore 闭包；公开 overlay registry | 逻辑与挂载两份索引本身可以合理，但取消、异步结束和父子返回缺少统一流程状态 |
| 通知 | input 局部字符串；SettingsPanelNotice；market OperationStatus；update content slots；stderr/logger | 没有共同的 scope、severity、操作 ID 和清除规则 |
| 按键 | core keymap；core compiler 原始键判断；各 controller.handleInput；业务字母快捷键 | keymap 的匹配、实际处理和提示并非同一个来源 |
| 异步动作 | `SurfaceEventOwner`；官方 `void onAction`；各功能的 busy/unloaded/AbortController | 取消、并发、错误和晚结果规则因入口而变 |

现有能力应保留并收拢：[core/ui-surface-state.ts](../../packages/mayfly/src/core/ui-surface-state.ts) 的草稿和虚拟列表机制、[core/ui-compiler.ts](../../packages/mayfly/src/core/ui-compiler.ts) 的语义焦点和宽度保护、[editor-panel-controller.ts](../../packages/mayfly/src/interaction/editor-panel-controller.ts) 的 host replay，以及四个 registry 的 Fiber 生命周期。无需另起一套 renderer 或插件系统。

## 3. 不一致行为清单

### 3.1 提交、表单与选择

| ID | 优先级 | 已存在的行为 | 后果与证据 |
| --- | --- | --- | --- |
| F01 | P1 | 官方表单末字段的 Tab 会调用整表 submit | 导航变成保存；[form-panel.ts](../../packages/mayfly/src/interaction/form-panel.ts) 的 `onTextSubmit` 与 core Tab 分支；探针复现 |
| F02 | P1 | 设置枚举 Enter/Space 循环到下一值并触发写入 | 查看选项即改变默认权限等配置；[settings-command.ts](../../packages/mayfly/src/interaction/settings-command.ts) 的 `activate/commitRow`；探针复现发出变更回调 |
| F03 | P2 | OAuth `select` 被映射为自由文本，只有非空校验 | 用户手输内部 ID；[provider-add.ts](../../packages/mayfly/src/interaction/provider-add.ts) 的 `interaction.prompt` |
| F04 | P2 | core 多选可提交空集合，官方多选补入光标项；问卷另写同样回退 | 同类列表提交结果不同；[select.ts](../../packages/mayfly/src/interaction/select.ts)、[questionnaire.ts](../../packages/mayfly/src/interaction/questionnaire.ts)；探针复现 |
| F05 | P2 | 问卷多选使用 `mode: single` 并把 `[x]` 拼进 label | core 看到单选，功能再拦截 Space 实现多选，语义与显示脱节；探针复现 |
| F06 | P2 | 普通表单、问卷 Other、审批反馈、计划修订分别管理文本编辑/提交 | 有的确认当前字段，有的立即结束请求，有的空文本代表拒绝；领域结果有差异，但文本与提交机制不应各写一套 |
| F07 | P3 | context window 和 reasoning efforts 都借用文本框 | 数值与有限集合需用户记格式；[provider-add.ts](../../packages/mayfly/src/interaction/provider-add.ts) 的 `fillModelDefaults` |

### 3.2 列表、树、搜索与标签页

| ID | 优先级 | 已存在的行为 | 后果与证据 |
| --- | --- | --- | --- |
| L01 | P2 | 设置列表首尾循环，普通列表到边界停止 | 同样的 Up 在首项会去不同位置；Settings `move` 与 Select `moveCursor`；探针复现 |
| L02 | P1 | 市场 `i/u/r` 在 type-to-search 前被业务 handler 消费 | 搜索单词首字母可能变成安装/移除；[frontend-panel.ts](../../packages/mayfly/src/interaction/frontend-panel.ts) 与 [plugin-commands.ts](../../packages/mayfly/src/interaction/plugin-commands.ts)；探针复现优先级 |
| L03 | P2 | Select 搜索 label/filterText，Document 搜索 label+detail，树再自行生成搜索视图 | 搜索范围与匹配结果没有共同的字段声明 |
| L04 | P2 | `selectedIds` 有时表示已选择值，有时表示当前 cursor；另加 current badge 表示已生效值 | 焦点、候选与 committed value 混用；三个 list controller 均可见 |
| L05 | P2 | tabs 上 Tab/Shift+Tab 无动作，Enter 才进入内容；其他区域 Tab 切组或提交字段 | 用户不能依赖同一种 Tab 遍历规则；[ui-compiler.ts](../../packages/mayfly/src/core/ui-compiler.ts)；探针复现 |
| L06 | P2 | 切组会重新播种 selection；各 tab 的光标、query、scroll 没有统一独立保留模型 | 返回原 tab 的位置取决于 controller；Document `reseedSelection/selectedVariants/groupId` |
| L07 | P2 | 40 列及以下列表直接隐藏 detail；disabled 项通常跳过，失败原因有时写入隐藏 hint | 窄屏丢掉理解不可用状态的依据；[ui-patterns.ts](../../packages/mayfly/src/core/ui-patterns.ts) 的 `renderList` |
| L08 | P2 | 所有空视图容易归为 no matches | 初始无数据、搜索无匹配、加载失败、无权限可能缺少清楚区分；各功能自行拼 empty/error 状态 |

L05 是已被现有测试明确规定的旧规则，不应当偷偷作为一个“bug fix”改变；本提案建议以统一导航协议正式迁移。

### 3.3 确认、按键与交互提示

| ID | 优先级 | 已存在的行为 | 后果与证据 |
| --- | --- | --- | --- |
| A01 | P2 | 官方四处已改 Yes/No，公开 `action.confirm` 仍二次 Enter | 仍是两套确认 UX；[confirmation-panel.ts](../../packages/mayfly/src/interaction/confirmation-panel.ts)、core `pendingConfirmation` |
| A02 | P2 | 已启用完全访问，再选 current 仍确认 | no-op 也打断；[permission-panel.ts](../../packages/mayfly/src/interaction/permission-panel.ts) 的 `onSelect` |
| A03 | P2 | primary 视觉 intent 同时决定 core preferred focus | 样式变动可以影响首次 Enter 的目标；core `collectControls/groupTarget`。确认默认 No、审批默认首项也缺少统一的显式默认策略 |
| K01 | P2 | controller 使用 keymap，core 控件大量使用固定 Enter/Esc/转义序列 | 提供的绑定与实际处理可不一致；[keymap.ts](../../packages/mayfly/src/core/keymap.ts)、compiler；探针复现自定义提交键被忽略 |
| K02 | P1 | 全局 handler 在焦点路由前执行，业务又可拦截原始字符 | 缺少统一 capture/scope 规则，跨 Agent 快捷键与未完成交互的关系要逐功能处理；core `index.ts` 与 controller.handleInput |
| K03 | P2 | core 自动提示 + 手工覆盖 + suppressAuto + 字符串拼装并存 | 显示什么和实际做什么可分离；[ui-compiler.ts](../../packages/mayfly/src/core/ui-compiler.ts) 的 `contextualKeyHints` |
| K04 | P2 | 提示固定优先级取前三项，窄屏继续裁剪；用泛化 actions/run/choose 代替实际动作 | 重要的返回/取消或具体提交后果可能不可见，需由动作类型决定保留顺序 |
| K05 | P2 | InfoPanel 支持 Enter/Esc/q 关闭，Document 的 q 依赖是否可搜索 | 同类只读内容仍受不同 controller 控制；[info-panel.ts](../../packages/mayfly/src/interaction/info-panel.ts)、Document `handleInput` |

K02 不表示所有全局快捷键都有错误；它表示现在缺少一个跨 surface 的明确优先级契约。中断、退出与普通导航需要分别定义。

### 3.4 通知、生命周期与渲染一致性

| ID | 优先级 | 已存在的行为 | 后果与证据 |
| --- | --- | --- | --- |
| N01 | P1 | 内部 policy 消息进 queue，进正式 transcript 后又隐藏 | 模型消息和用户待处理输入分类矛盾；通知审计及探针 |
| N02 | P1 | 面板打开时 hint 隐藏，但多个面板仍向 hint 发错误 | 操作失败当时不可见；EditorDockHost 与 jobs/agents/preset；探针 |
| N03 | P1 | 通用 notice 无 scope、ID；旧会话异步结果能写入新会话 | 信息归属错误；input 命令回调；探针 |
| N04 | P1 | severity 在某些入口保留，在字符串 notice 入口丢失 | 同一失败的强调方式取决于入口；market reporter 对照 |
| N05 | P2 | 后写覆盖、空串清除、编辑即清除、常驻 slot 等规则并存 | 新错误可被无关 loading 清理删掉；探针 |
| N06 | P2 | 八行后 `... more` 无展开，更新消息逐行截断，同时还有独立详情面板 | 信息可达性不一致；探针与 updater 代码 |
| N07 | P2 | 更新同时发 hint 和 content slot；部分运行中错误只发 stderr/logger | 重复展示、不可管理和闪现；通知审计 |
| R01 | P1 | 公开 surface 有统一异步事件 owner，官方 controller 仍 `void onAction` 并自管 busy/unloaded | 同类 action 的错误、并发和晚结果处理不同；[surface-renderer.ts](../../packages/mayfly/src/core/surface-renderer.ts)、Document `activate` |
| R02 | P2 | `selection-change` 同时表示多选集合变动与提交，dispatcher 又按 latest 策略处理它 | 草稿变化与提交意图无法从事件名区分；公共 contracts、core `collectControls` 与 `SurfaceEventOwner.emit` |
| R03 | P2 | 官方 adapter 固定 `screenMode: main` 和近似无限高度；公开 surface 使用实际 viewport/mode | 同 kind 的行栈、scroll、actions 可能因入口采用不同布局路径；[canonical-panel.ts](../../packages/mayfly/src/interaction/canonical-panel.ts) |
| R04 | P2 | 不同 controller 自设 6/8/16/20 行窗口与页面步长，依赖字符串 leaf path | 看起来相同的列表滚动距离不同；结构变化还需手工同步窗口 path |
| R05 | P2 | 外部 snapshot、内部重编译、theme/locale 改变的草稿保留策略分散 | 用户态可能因数据刷新或呈现刷新被重置；core `bind`、adapter `invalidate`、各 panel replay |
| R06 | P2 | Document 的读取/构建节点方法顺便修改 selectedId/group/selectedVariants | 状态收敛发生在 render 查询里，而非明确的事件转换中 |

不一致并不意味着所有状态必须显示在一个位置。队列、持久状态、字段校验、工具结果和短通知有不同语义；统一的是分类规则、状态管理和同类交互协议。

## 4. 统一模型与分层

### 4.1 一条交互数据流

```mermaid
flowchart LR
    DSH[原生 dsh 状态与服务] --> DEF[业务数据快照与约束]
    DEF --> MODEL[UIInteractionModel]
    INPUT[终端键鼠与粘贴] --> ROUTE[core 输入解析与作用域路由]
    ROUTE --> MODEL
    MODEL --> VIEW[只读 ViewState]
    VIEW --> RENDER[core renderer]
    MODEL --> AVAILABLE[AvailableActions]
    AVAILABLE --> HINT[控件提示与帮助]
    AVAILABLE --> ROUTE
    MODEL --> EFFECT[已登记的业务动作]
    EFFECT --> DSH
    EFFECT --> RESULT[带 scope 与 operation ID 的结果]
    RESULT --> MODEL
```

UIInteractionModel 内部由按控件种类划分的纯 reducer 组成，所有状态变更通过统一 dispatch。拆文件是为了模块边界，不是允许业务再实现另一份 FormState 或 ListState。

### 4.2 明确每种状态的唯一 owner

| 状态 | 权威 owner | 其他层允许做什么 |
| --- | --- | --- |
| 已生效权限、设置、模型、Agent/Session、Job | 原生 dsh | UI 读取 snapshot、提交原生 action；不建立第二套领域状态 |
| surface 路径、通用表单/选择/向导/确认、通知、UI 操作状态 | UIInteractionModel | 功能提供 readonly 定义与动作映射；renderer 读取派生状态 |
| 焦点及输入语义 | UIInteractionModel 的 core-owned slice | 业务只能请求打开/定位一个语义控件，不能同步自己的 cursor |
| 实际终端几何、行宽、可见窗口、ANSI、命中区、renderer handles | core renderer | 给模型提交导航所需的可达性信息；缓存不成为第二套选择状态 |
| 文本编辑缓冲、undo/redo、粘贴协议 | core 持有的原生 editor | 模型通过唯一绑定取得草稿快照；功能不另建 values/editing 副本 |
| 数据读取、订阅与领域校验 | 原有 service/功能 action handler | 返回数据或校验结果，不能控制 Tab/Esc 等通用 UX |

渲染中需要的缓存与派生快照可以存在，但必须有明确来源且不可反向作为新的权威状态。`render()`、`selectView()`、`availableActions()` 必须不修改语义状态。

### 4.3 与现有包和 Fiber 的关系

- `packages/ui` 继续只拥有 readonly contract、纯 builder 和四个 registry；不放可变 store、renderer 对象或 Harness 对象。
- 统一模型的 reducer 与输入/焦点实现放在 `packages/mayfly/src/core/` 内，确保原始按键、布局和 focus 仍只有 core 处理。
- 稳定状态 owner 挂在现有 `mayfly-frontend` sibling，由 `frontend/index.ts` 挂载 core 内部的纯交互状态模块。模块不经 `core/index.ts` 导入终端或 renderer；不新增公共 subpath 或第五个 UI contribution service。
- 拟定内部服务名为 `mayflyUiInteraction`，不直接扩展 `mayflyInteractionState`。后者由依赖 `mayflyCurrentAgent`、`skills` 的 interaction Fiber 创建，不能成为所有公共 surface 的稳定状态根；它继续持有原有缓存、粘贴资源和配置引用。
- 稳定 owner 不 inject app/current-Agent、skills、theme、components、screen 或 keymap。registry 订阅由其独立子 Fiber 显式 inject 四个 UI service 中实际消费的服务；renderer、官方业务贡献各自 inject 稳定服务，依赖方向不能反转。
- `mayflyEditorPanels` 逐步变为统一 navigation slice 的入口；EditorDockHost 只投影逻辑栈到物理挂载，不另定取消规则。
- 四个公开 UI contribution service 的名称与贡献边界保持不变，数据与事件合约按 4.6 升级。业务插件仍直接使用原生 dsh；不增加 manifest、realm、权限 facade 或特有插件框架。

模型实例随 frontend owner 销毁；renderer/theme reload 只解绑并重建 renderer handles。已迁移的官方贡献必须从依赖 theme/components 的 input 子 Fiber 中移出。Provider 配置等 app-scope 贡献还必须移出依赖 current-Agent/skills 的 interaction 父 Fiber，挂到现有 frontend sibling 的独立业务子 Fiber，仅 inject 实际需要的原生服务；否则 core 重载经 app 传递卸载时仍会丢失表单。真正卸载的贡献不能以“保留草稿”为由复活。所有可保留的用户态存于稳定模型实例，不能依赖已经卸载的组件对象存活。

| 生命周期事件 | 稳定 owner 与贡献的行为 |
| --- | --- |
| renderer/core 暂缺、theme 替换 | owner 与仍存活的注册保留；新 renderer replay 同一 surface 实例，旧 handles 和输入 continuation 失效 |
| app/current-Agent 或 skills provider 重载 | owner 与不依赖这些服务的外部贡献保留；实际依赖这些服务的业务 Fiber 正常卸载，移除自己的 surface 和 bindings |
| 当前 Agent 选择改变 | 业务绑定发布 scope 变化；旧 Agent 的结果不能写入新 scope；无 Agent 依赖的静态 UI 不重置 |
| consumer unload 或 registration dispose | 立即移除该注册的状态、敏感草稿、动作绑定及适用任务；仅隐藏/返回父页不等于 dispose |
| UI provider 重载 | 旧注册全部失效；相同公开 ID 的新注册是新实例，不继承旧动作或草稿 |
| frontend owner 或整个 tree 销毁 | 清理全部状态、订阅、计时与 runtime bindings；其他 tree 不受影响 |

第一阶段的 whole-tree 测试必须实际卸载并恢复上述依赖，不能仅用 `InteractionStateService.dispose()` 的单元测试代替依赖图证明。实施时同步 frontend/core/interaction 所有权文档和包指引。

### 4.4 内部状态分区

以下是拟定的内部结构，不是新增公共 API：

```text
UIInteractionModel
  navigation
    surface stack / active surface / return anchor
  surfaces[surfaceInstanceKey]
    source revision / scope / lifecycle
    forms[formId]
      baseline / draft binding / dirty / field errors / validation state
    lists[listId]
      focused item ID / selected IDs / committed IDs / query / expanded IDs
    tabs[tabsId]
      active tab ID / per-tab content state
    wizards[wizardId]
      active step ID / completed steps / draft answers
    decisions[decisionId]
      action / question / allowed choices / default choice / settlement
  operations[operationId]
    origin / target / source revision / phase / cancellation facts
  notifications[notificationId]
    scope / operation ID / severity / purpose / content / detail action / lifetime
```

原始 Agent、Session、Promise、AbortController、pi-tui 对象、焦点 handle 和宽度信息不进入公开模型快照。业务动作映射、取消句柄与原生 editor 实例在同一 owner 的私有 runtime bindings 中管理。

`surfaceInstanceKey` 在稳定 owner 内由 contribution kind、注册实例及其 generation 确定，不能只用公开 `surfaceId`。不同 registry 可以使用同名 ID；dispose 后重开同名 ID 也必须隔离。控件状态再按稳定的页面路径和 control ID 定位，页面路径使用 tab ID/item ID，不使用标签文案、数组下标或 renderer leaf path。这是内部实例索引，不增加插件 owner token 或 realm。

### 4.5 需要补齐的数据契约

现有只读 node 是良好基础，但不足以表达全部通用 UX。以下能力在既有 node、registration 和事件合约上演进；4.6 定义必须实现的协议，4.7 给出消费者时序。最终导出类型名由类型测试固化，不同时建立另一套面板 DSL。

| 契约 | 复用现有部分 | 需要明确或补齐的语义 |
| --- | --- | --- |
| Form | fields、value、submitActionId、cancelActionId | 类型化约束、明确的提交边界、字段错误；校验函数放注册/effect 层 |
| List/Choice | id、mode、items、selectedIds | browse/choose 角色、焦点与值的区别、选择基数、不可用原因；选择变动与接受分开 |
| Tabs | id、activeId、items | 属于视图导航的语义、每页状态保留和统一退出规则 |
| Action/Decision | id、label、intent、disabled、busy、confirm | 业务动作与视觉强调分开；默认决定、一次性确认与操作状态由统一模型管理 |
| Notification | 现有 readonly text/action 数据与注册事件 | scope、ID、severity、详情、生命周期；入口归既有模型，不新增第五个 UI contribution service |
| Source update | revision/eventRevision、稳定 node/control ID | acknowledgement、数据刷新、schema 改变、整体替换的明确区分 |

动作 handler 可以消费统一模型提交的草稿快照并调用原生服务，但不能持有一份会自行更新的 UI 草稿。外部源的 committed snapshot 和 UI 编辑 baseline 是只读参照，不成为新的领域状态权威。

### 4.6 快照、页面与动作协议

以下称为新交互协议；通过 Mayfly 与 `mayfly-ui` 的明确版本升级发布。试点仅在候选构建使用，现有发布版本的 `MayflyUiEvent` 和 `set(node, { eventRevision })` 保持原义。发布前形成类型迁移说明并迁移仓库内真实外部消费者；不增加永久的新旧模式开关或兼容 export。

| 协议部分 | 新协议的确定语义 |
| --- | --- |
| 注册的初始 node | 表单 `value` 和 choice `selectedIds` 是只读 baseline，首次创建草稿；后续编辑只写 surface 的 draft。浏览列表的光标不再从 `selectedIds` 回写 |
| 注册作用域 | registration 声明 readonly 的 app/session/panel 归属和目标标识；作用域内的业务 authority 留在 handler 私有绑定。目标改变必须整体 replace，不能用 data 把旧草稿悄悄转给另一目标 |
| 普通数据更新 | 扩展 snapshot update metadata，以 `reason: 'data'` 明确表示；新协议省略 metadata 时也按 data 处理。未修改字段跟随新值；已修改字段保留草稿，仅在对应 baseline 值变化时标记冲突 |
| 操作确认回写 | owner 将 handler 的 accepted 回执准入为 `reason: 'ack'`，关联本次 operation ID 和提交的 draft revision。只接纳同一注册实例、scope 和仍有效操作；业务不另发一次 `set()` 确认同一提交，旧回执也不作为 reset |
| 整体替换 | `reason: 'replace'` 明确销毁旧实例状态和适用 continuation，再从新 node 初始化；不能通过改标题或重建等价对象隐式触发 |
| 呈现刷新 | theme、locale、resize 不触发 replace 或制造领域版本；翻译后的 readonly 文案可随等价 data 快照重发，baseline 值不变就不重置草稿。新 renderer 从稳定实例取得状态 |
| tab 内容归属 | 在现有 `MayflyUiChild` 上补充 readonly `tab: { controlId, itemId }` 关联；嵌套关联组成页面路径。该页面切换为不可见时保留草稿，明确删除关联子树时释放状态 |
| 动态页面 | 插件发布页面的 loading/empty/数据子树并保留 tab 关联；不能用删除页面表示暂时未加载。结果绑定页面路径及读取代际，不能覆盖另一页 |
| 选择变动与接受 | `selection-toggle` 仅改变本地 draft；`selection-accept` 才发起选择 action。公共事件类型分开，不能继续用同名 `selection-change` 交给 latest |
| 动作提交 | registration 的 handler 接收 action ID、control/page 路径、不可变草稿及 operation context；context 带取消 signal。业务只读此次提交值，不维护持续变化的表单副本 |
| 校验与结算 | 注册层返回结构化 UI 回执：accepted、invalid、conflict 或 failed。invalid 带字段路径和错误；accepted 回写权威 node 及 ack；failed 保留草稿。回执不改写原生 dsh 的返回类型或错误分类 |

Save 启动前冻结此次 draft revision，并锁住该表单的修改与重复提交；不锁其他 surface，也不阻止该动作必需的子交互。异步只读校验可采用 latest，但结果必须匹配字段草稿版本。写入前的领域校验与原生 effect 由业务 handler 执行，模型不推断 native action 是否成功。

回执的 accepted node 先经 registration/provider 的既有快照发布路径冻结并发布，稳定 owner 将对应 ack 与操作结算一次准入；不能只改 renderer 的私有 node，或先清 dirty、后收到另一个 baseline。准入失败按该操作失败处理并保留草稿。提交中若收到冲突的数据更新，保留冲突与实际原生结果；不能仅因收到 accepted 就抹去更新后的权威值。没有原生 revision/CAS 能力的领域，handler 需要重新读取并报告冲突或请求用户重新确认，不能把 UI revision 当成领域并发保证。

表单提交回执的最小形状如下，属于拟定注册层协议。事件上下文负责关联 operation、页面路径与取消 signal，node 内仍没有 callback/Promise；其他事件不需要返回表单回执。accepted 的 node 是写入后重新读取的完整 surface 快照，conflict 的 node 是最新权威快照，均须先通过现有冻结和准入边界。

```ts
type FormActionReply =
  | { readonly kind: 'accepted', readonly node: MayflyUiNode }
  | { readonly kind: 'invalid', readonly errors: readonly FieldError[] }
  | { readonly kind: 'conflict', readonly node: MayflyUiNode, readonly message: string }
  | { readonly kind: 'failed', readonly message: string }

interface FieldError {
  readonly pagePath: readonly { readonly controlId: string, readonly itemId: string }[]
  readonly formId: string
  readonly fieldId: string
  readonly message: string
}
```

页面关联在 core admission 中验证：引用存在的 tabs/item；同一页面内 control ID 唯一；不同页面可复用同名字段，事件包含页面路径。可见性、宽度和可见窗口仍由 renderer 决定。扩展关联不改变大列表按 viewport 准入、隐藏分支延迟准入和局部失败隔离的契约。

### 4.7 官方与外部表单的同一时序

试点选择官方 Provider 编辑表单，以及通过 `mayflyOverlays.open()` 注册的外部配置表单。两者发布同样的 Form/Choice node；外部示例的业务值通过原生 settings namespace 读写。下表只用协议语义表达调用，不把拟定字段伪装成现有 SDK 示例。

| 步骤 | 插件/业务动作 | 共享模型的结果 |
| --- | --- | --- |
| 打开 | 发布 baseline `name=A`、领域版本 r1 和两个有明确关联的页面 | 创建注册实例，草稿为 A，页面草稿各自隔离 |
| 输入 B，再按 Tab/切页/返回 | 无领域写入；业务可读取只读草稿做校验，无须 `set()` 回送每次键入 | 当前值 B 保留，焦点与页面锚点恢复，原生值仍为 A |
| 后台数据更新 | 发布 `reason: data` 的 `name=C`、r2 | 保留 B 并标记冲突；未修改字段同步，取消不会写回 A |
| 处理冲突 | 用户选择放弃该字段草稿，或在查看新 baseline 后显式重新提交 | handler 使用实际 native revision；无无条件覆盖或自动冲突重试 |
| Save | handler 收到本次草稿、baseline 版本、operation ID 和 signal | 先登记 busy；重复 Save 不启动第二个写入 |
| 校验失败 | 返回 invalid 及字段路径 | 解除 busy，定位错误并保留全部草稿，不产生领域写入 |
| 写入成功 | 原生写入成功后返回 accepted 和权威 node；owner 关联 ack | 原子更新 baseline/draft，清 dirty，显示该操作反馈 |
| renderer reload | 注册和业务 Fiber 仍存活 | 重绑同一实例，恢复草稿；不重发 Save |
| 关闭或重开同名 surface | dispose 旧注册，再创建新注册 | 旧回执无效；新 surface 不继承旧草稿、错误或确认目标 |

第一阶段同时提供上述两种真实挂载和同一参数化事件轨迹。若外部消费者仍需自行维护 tab/草稿或猜测 reset，协议试点不算完成，不能进入全量迁移。

## 5. 统一交互协议

### 5.1 基础动词

必须在内部区分 `navigate`、`edit`、`toggle`、`accept-selection`、`submit-form`、`invoke-action`、`cancel-edit`、`close-surface`、`interrupt-operation`。这些不能继续统一塞入模糊的 `selection-change` 或 `submit`。

| 内部事件族 | 可修改的状态 | 可否直接产生领域副作用 |
| --- | --- | --- |
| FocusMoved / ViewportChanged | 焦点、可见性派生 | 否 |
| DraftChanged / SelectionToggled / FilterChanged | 草稿、候选集合、query | 否；可触发只读搜索/校验 |
| TabActivated / TreeExpanded | 当前视图 | 否；可触发只读加载 |
| SelectionAccepted / FormSubmitted / ActionInvoked | 操作请求 | 通过已登记的 action binding 执行 |
| ValidationFailed / OperationSettled | 校验错误、进度、反馈 | 记录结果，不在 render 中重试 |
| SurfaceClosed / OwnerDisposed / ScopeChanged | 生命周期、取消、归属 | 不把关闭 UI 等同于已回滚领域操作 |

已经公开的 `MayflyUiEvent` 不能悄悄改义。先在内部明确事件，再按版本迁移涉及的 public contract，并同步真实外部消费者；过渡转换只存在于一个边界，不能让每个插件自行猜测新旧语义。

### 5.2 表单

所有配置表单具有显式 Save / Cancel。单字段编辑也是表单，不因“只有一个字段”恢复隐式提交。

| 输入 | 统一行为 |
| --- | --- |
| 聚焦文本字段 | 直接可编辑，显示 caret；不另要求一次 Enter 进入隐藏模式 |
| Tab / Shift+Tab | 移至下/上一个控件，保留草稿；末字段移至 action 区，不提交 |
| 单行字段 Enter | 完成当前字段并前进，不保存整表 |
| 多行字段 Enter | 换行；文本处理复用原生 editor |
| Save 按钮 Enter/Space | 校验整表，通过后提交一次；失败定位首个无效字段并保留全部草稿 |
| Cancel / 表单层 Esc | 无修改直接关闭；有未保存修改则统一确认是否丢弃，默认 No |
| 弹出的选择器/补全上的 Esc | 仅关闭当前选择层，返回同一字段，不丢整表草稿 |

可提供统一的 Ctrl+Enter 提交别名，但只有终端能力与 keymap 能准确表达时才启用和显示；显式 Save 始终可达。不复用 prompt 中已经表示 steer 的 Ctrl+S 作为不可见的全局保存键。

字段校验与导航分开：Tab 不把用户困在错误字段，错误持续标在字段旁；最终提交时阻止无效数据。同步约束来自数据声明，领域校验由业务 handler 返回结构化字段错误。禁止功能通过临时替换标题或全局 notice 模拟字段错误。

### 5.3 值类型与提交边界

| 值类型 | 控件 | 提交位置 |
| --- | --- | --- |
| 自由文本 | input / textarea | 表单草稿，Save 才写领域 |
| 密钥/密码 | secret | 与表单相同；日志和审计快照脱敏，关闭后释放草稿引用 |
| Boolean | toggle | 在表单中改草稿；独立设置行是明确的 toggle action，结算前显示 pending |
| 单一枚举 | choice picker / 明确的 segmented choice | 展开完整选项，接受后改草稿或调用独立设置 action；不得靠反复 Enter 遍历并保存 |
| 有限集合 | multiple choice | 显示已选数与约束，提交实际选中集合 |
| 数值 | 带单位、min/max/step 的数值输入 | 允许键入不完整草稿，提交时规范化/校验；不把暂时的 `-` 等中间态误报为保存值 |

OAuth 的 `text/secret/select` 按上述类型映射。缺少候选项的 select 显示明确不可完成状态，不生成空标签文本框。内部 option ID 不要求用户手输。

### 5.4 列表与树

只保留两种可识别语义：**浏览记录**和**选择值**。视觉结构相同不意味着浏览一条记录就应选择某个配置值，但相同语义必须共享 reducer。

- `focusedItemId` 是光标；`selectedIds` 是草稿集合；`committedIds` 是原生当前值。这三种状态不能由一份 selectedIds 兼任。
- Up/Down 默认到边界停止；Home/End 到首尾；PageUp/PageDown 按 core 实际可见页移动。统一取消各 controller 私有的 6/8/16/20 行步长。
- 浏览列表 Enter 执行清楚命名的 Open/View action；选择器 Enter 接受候选。二者都经过同一个 action 路由，功能不处理原始 Enter。
- 多选 Space 只切换当前项；Enter/确认按钮提交实际集合。`minSelected=0` 可提交空集合，`minSelected>0` 显示校验，不得补光标项。数字快捷键在多选里只切换候选，不提交整个问卷。
- 不可用条目必须有可达的原因。建议记录型条目可聚焦检查，动作仍 disabled；choice 中不可用值不能成为新提交值。renderer 应提供同一详情呈现，不依赖功能吞掉 Enter 后写一条不可见 notice。
- 数据刷新按稳定 ID 保留焦点和选择；删除焦点项时选相邻可达项。选择中的值失效时明确显示，不能悄悄改成另一值。
- 树的展开/折叠、搜索展开和返回位置由共享 TreeState 管理。业务提供 parent/child 关系，不拼缩进字符串来实现另一种树导航。

### 5.5 搜索

- filterable 集合一致支持直接输入进入搜索；`/` 或注册的搜索动作也可进入。
- 输入文本优先于无修饰业务字母。市场安装/移除/刷新应改为显式 action 或统一注册的修饰键，不能再让 `i/u/r` 抢走搜索首字母。
- SearchState 统一持有 query、编辑状态、可见结果与返回锚点。业务声明可搜索字段；匹配与输入规则由模型统一执行，字符处理仍由 core 原生 SearchInput 负责。
- Esc 退出搜索编辑并保留可见 query；Clear 明确清空；随后 Esc 才按 surface 返回规则退出。清空后恢复先前列表锚点。
- 初始无数据、无匹配、加载中、失败、权限不足是不同状态，使用共同的 empty/loading/error 模型与明确可用动作。
- 跨 tab 的过滤默认保留在各 tab 自己的 content state；若是一个全局搜索界面，应明确呈现全局范围，而不是按功能隐含改变搜索范围。

### 5.6 标签页与选项组

- Tab/Shift+Tab 在所有可交互 group 之间前后移动，包括从 tab strip 进入内容；复合控件内部用方向键 roving focus。
- tab strip 的 Left/Right 激活相邻视图，边界不循环；Enter 可进入当前视图内容。视图切换本身不提交业务数据。
- 每个 tab 保留自己的草稿、筛选、焦点和滚动锚点；切换只是激活另一个实例，不清空它。
- 删除/重排 tab 按 ID 重定位，翻译文案变化不重置状态。异步加载结果按 tab/request ID 归属。
- tabs 只代表视图。模型的 reasoning effort 等互斥值应使用 choice/segment 语义，不用 tabs 假装视图切换。

这会有意改变当前“tabs 上 Tab 无动作”的规则，需要明确的版本说明、键位文档与跨面板验收。

### 5.7 确认、审批与问卷

统一 DecisionState 和决策动作，而非把所有问题都强行压成二选一。

| 场景 | 定义与共享行为 |
| --- | --- |
| 二次确认 | 问题、目标、后果、Yes/No；默认 No；Yes 提交一次，No/Esc 返回原 surface |
| 原生工具审批 | 使用原生允许/拒绝及会话授权选项；共享 choice/feedback 控件；原生 outcome 不改名 |
| 计划评审 | document + decision + 可选反馈；共享滚动、choice 与 form；不要手写光标和编辑状态 |
| 多问题请求 | WizardState + 每题的 Form/ChoiceState；跨题草稿保留；最后有明确“提交回答”动作 |

默认焦点由 decision 的明确默认规则决定，不从按钮颜色或 `intent: primary` 推断。需要明确批准的许可/危险决定默认落在不执行项；已有审批首项默认允许属于需要正式迁移的交互决定。

确认只针对实际变化；无变化直接返回。确认对象发生变化、来源 surface 被替换或所属 Agent 不再有效时，旧 Yes 不能执行新目标。取消下层确认恢复父 surface 的同一草稿和焦点。

公开 `action.confirm` 也必须由同一个 DecisionState 呈现；不保留另一套“文字后加问号、再按 Enter”的状态机。业务只登记 action 的语义和后果，不决定确认面板长相、按键或生命周期。

参数化原生 dsh 命令仍按其文档执行，UI 不擅自改写 `/permission` 的权限语义。统一的是 Mayfly 同类控件和 UI action 的呈现/调用路径，不能为了表面一致复制一个 Mayfly 权限系统。

### 5.8 只读文档与长内容

- Help、Info、Trace、Job output、plan 正文使用一个 DocumentState/ScrollState。格式不同由内容数据表达，关闭、分页、锚点保留一致。
- Esc 关闭/返回；非搜索的只读文档可有统一的 q 别名。Enter 仅激活聚焦的明确动作，不再在一部分文档里隐式关闭。
- 真实 viewport 决定窗口；活动控件与确认动作必须保持可达。宽度合规不等于高度合规。
- 窄屏可把同一组按钮纵排，但导航根据实际布局生成，保持逻辑操作顺序。不能仅因官方 adapter 和插件 surface 不同而采用两套布局语义。
- 重要详情不能因宽度小于某阈值而彻底不可达；提供当前行详情区或显式详情动作。省略时必须能查看全文。

## 6. 单一输入路由与提示来源

拟定优先级：终端粘贴/组合输入识别 → 明确的紧急中断 → 最上层 capturing decision/surface → 当前文本编辑器或候选菜单 → 当前控件 → 所属 group/surface → 可用的全局动作。

只有少量明确声明的紧急动作可越过 capturing surface；F7/F8 等普通导航依据当前 surface 是否允许离开来决定可用性。被捕获的按键不得继续传给底层 prompt。

prompt 的已约定语义保留：Enter 发送，Tab 补全，Shift+Tab 只切 normal/plan，Ctrl+S steer；plan 与 YOLO 仍可叠加，YOLO 通过独立原生权限命令控制。其他控件不复用 prompt 的 mode-switch handler。

Alt+M 这类明确命名为“下一个模型”的快捷动作可以保留，并由同一 action registry 限定 scope。它与“在一个普通枚举行按 Enter，隐式切到下个值”不是同一种控件语义。

核心接口应是一个派生查询：`availableActions(model, focusedControl)`。输入匹配、按钮 enabled/busy、快捷键提示、帮助、无障碍名称均读取它。业务只能登记动作 ID、业务标签及 action binding，不再传手拼 `keys` 字符串或 `suppressAutomaticContextHints` 来修补实际处理。

提示规则：

- 展示当前确实可执行的动作和实际绑定；名称使用“保存”“选择”“返回”“取消”等准确语义。
- 输入态不展示会窃取文本的业务字符快捷键。
- 窄屏优先保留退出/取消与主要操作，精简说明而不制造不存在的动作；完整列表可在统一帮助查看。
- 没有可操作的详情入口就不能只显示 `... more`。
- 文案翻译统一按稳定 key 生成，用户提供的内容不当作翻译 key；翻译与主题变化只重绘，不改变交互状态。

## 7. 通知与操作状态

### 7.1 展示语义

| 内容 | 统一位置与责任 |
| --- | --- |
| 模型内部策略消息 | 保留原生 inbox；不作为用户 queue 显示 |
| 用户待处理 prompt/steer/附件 | 上方队列，只读投影；不复制 inbox 状态 |
| 短操作反馈 | 当前 editor 或 panel 下方、footer 上方的统一 feedback slot |
| 等待用户完成外部操作的指引 | 所属交互 surface 持续显示必要信息和动作；feedback 只提示该交互仍在等待 |
| 字段错误 | 同一模型中的 field error，贴近字段 |
| 长任务进度/失败详情 | 所属操作/document surface，feedback 提供摘要与详情动作 |
| 当前 plan/yolo、jobs、context 状态 | footer/pane 持续投影，独立于通知 acknowledgement |
| 启动前或无法维持 UI 的错误 | stderr；运行中可恢复错误同时进入统一反馈 |

feedback slot 不再属于“仅编辑器可见的 hint”。活动面板也有同一个可见出口。建议为短反馈摘要保留一行，长文通过详情呈现，避免通知长度使编辑区反复跳动；实际分配仍由 core 统一根据 viewport 决定。完成操作所需的指引不受这一行摘要配额限制，见 7.3。

### 7.2 生命周期与归属

- 每条通知都有稳定 ID、owner、app/session/panel scope、operation ID、severity 和 purpose。purpose 区分短反馈、进度与待用户操作的指引，不能只靠 severity 决定寿命。
- 同一操作的 loading/success/error 更新同一记录；生产者只能清理自己的记录。
- progress 持续到操作结算；仅 purpose 为短反馈的 success/info 摘要在累计可见 5 秒后消失，所属 surface 隐藏时暂停计时。warning/error 保留到明确处理、同操作替换或 scope 关闭，并可回看详情；待用户操作的指引按交互结算清理，不使用 TTL。计时由 model 的 effect owner 驱动，不在 render 中改状态，也不提供功能各自设定的任意 TTL。
- 不再由任意编辑清空所有错误；滚动“有新消息”是状态提示，不覆盖操作失败。
- 应用级更新结果跨会话可见且标记目标 profile；会话级结果归原会话；panel 关闭不把结果写给另一个 panel。
- 使用有界的会话/应用通知记录，超额按统一策略回收已结算低优先级项；进行中的操作和未处理的关键失败不得因高频普通消息被挤掉。
- 敏感字段内容不进入提示、操作审计快照或通知历史。

### 7.3 OAuth 与持续交互指引

当前 `provider-add.ts` 接受原生 authorization 的 `notify({ message, url?, code? })`。网址和验证码可能是用户在浏览器完成登录所需的唯一信息，必须迁入授权 surface 的持续内容，不能只转成一条 info。原生 authorization 继续拥有认证状态、超时和结果；Mayfly 只持有当前可展示的指引。

| 事件 | UI 行为与清理 |
| --- | --- |
| 收到 url/code 或明确要求用户操作的 notify | 在本次授权实例中发布 `purpose: action-required` 的指引；保留 message、完整 URL 和 code 的结构，不先拼接再截断。无法判断的授权 notify 在请求结束前保留 |
| 随后收到 text/secret/select prompt | 指引仍可在同一授权 surface 查看，prompt 使用共享 Form/Choice；capturing 面板不能挡住查看完整指引、复制所需值和取消授权的动作 |
| 窄终端或长 URL | 使用所属 Document/Scroll 区域呈现全文，保证 prompt 与动作可达；不依赖底层 footer 的详情按钮，也不显示无入口的省略标记 |
| 等待浏览器操作、切 tab 或 renderer reload | 指引持续保留；五秒计时、无关 loading、键入或其他操作反馈不清除它 |
| authorization 更新指引 | 按授权实例和指引 ID 更新；新的码可替换旧码，不能替换另一个授权请求的内容 |
| 原生成功、失败、取消、超时或业务 owner unload | 结算本次交互并释放 URL/code/secret 引用；历史和日志最多保留不含敏感内容的结果摘要 |

URL、code 和 secret 的明文只允许在该授权实例的必要交互中使用，不进入通用通知历史、调试状态导出或审计快照。Provider 新增属于应用配置操作，切换当前 Agent 本身不应把授权指引归给新会话；若其实际业务 Fiber 卸载，按正常取消规则结束。

授权 action 可以在运行期间等待子 prompt。父操作只阻止重复启动授权，子表单必须继续接收输入并独立结算；不能让同一全局 FIFO 等待父 Promise 而阻塞其子交互。取消向原生 signal 传递，晚到的 notify/prompt/result 不能重新打开已关闭的授权 surface。

## 8. 异步、关闭与数据刷新

### 8.1 同一个 OperationState

动作状态统一为 `idle → validating → awaiting-confirmation → running → succeeded/failed/cancelled`；领域动作并不一定经过所有阶段。状态由共享 reducer 驱动，业务只提供校验与原生 effect。`running` 可以关联待用户处理的子交互，其父子结算和局部 busy 规则见 7.3；不把原生授权、更新或 Job 细分阶段复制进通用状态机。

启动 effect 前先在模型中登记 operation 和 busy，防止连续输入重复启动。草稿搜索/校验可以采用 latest；明确提交/动作不能因为同名 `selection-change` 到达就被误当成可丢弃的草稿更新。

本地单次调用防重不等于外部副作用 exactly-once。取消 AbortSignal 也不等于回滚成功：若领域写入已发生或完成状态未知，保留原生结果并重新读取权威状态，不伪报“已取消、没有变化”。

### 8.2 使用已有身份和版本

复用 Fiber 生命周期、既有 surface generation、registry revision/eventRevision、current-Agent revision，以及领域服务自己的 revision。统一校验它们的适用范围，不为每个功能再添加一组私有 loaded/unloaded/generation 标志。

UI 快照仅记录标识；业务 effect 必须通过原生服务取得精确 Agent，不能把 Agent/Session 藏进 renderer-neutral node。session ID 相同也不自动证明它还是原来的 live Agent 实例。

### 8.3 草稿与外部值冲突

| 变化 | 策略 |
| --- | --- |
| 主题、语言、终端尺寸、等价 node 重建 | 保留草稿/焦点/选择；只重算呈现 |
| 外部值更新，字段未修改 | 同步新 baseline |
| 外部值更新，字段有草稿 | 对应 baseline 值变化才标记冲突并保留草稿；提交时使用领域 revision 校验，无 native revision 时按 4.6 处理 |
| 列表重排或新增 | 按稳定 ID 保留锚点，不依赖 array/object identity |
| 字段/条目/动作被删除 | 按共享 reconcile 规则回退；旧动作失效 |
| 返回父 surface | 恢复原实例状态与焦点锚点 |
| 所属 Fiber 真正卸载 | 注销贡献、取消适用任务、移除状态，不复活旧 panel |

公开 surface 当前对 external replacement 有明确的重置语义。新协议按 4.6 的 data/ack/replace 和呈现刷新规则实现，随明确版本升级迁移；旧发布版本不能在原 `set()` 上无说明地改变所有外部插件行为。

## 9. 业务模块允许与禁止的职责

| 允许由业务定义 | 必须由统一模型负责 |
| --- | --- |
| 原生数据来源、只读查询、业务标签 | cursor、编辑态、tab/过滤/展开/滚动状态 |
| 字段类型、必填、数值边界、选择基数 | Tab/Enter/Esc/方向键解释 |
| 明确的 action ID、目标及原生调用 | 确认呈现、默认焦点、busy、防重 |
| 原生领域校验与错误内容 | 校验错误归属和呈现、通用返回行为 |
| 请求允许/拒绝的原生结果编码 | 问卷逐步草稿、选择与提交机制 |
| 业务操作是否可取消及真实结果 | notification ID/scope、并发、晚结果校验 |

区别来自数据语义，不来自命令名。禁止以 `isProviderPanel`、`isSettingsPanel`、`submitOnLastTab` 等新开关保留原先的分叉。

## 10. 迁移映射

| 当前实现或入口 | 目标 | 迁移完成后删除的私有 UX |
| --- | --- | --- |
| `form-panel.ts`；Provider、startup、配置值编辑 | FormState + typed fields | values/editing/submitDirection、末字段提交与各自键链 |
| `select-list.ts`、`select.ts` | Choice/BrowseListState | 自建 cursor/query/filterEditing、零选中回退 |
| `settings-command.ts` | PropertyList + Form/Choice/Toggle | enum cycle、自建 settings cursor/values、SettingsNoticeController |
| `frontend-panel.ts`；市场、模型、jobs | TabbedCollection/Document 组合 | group/selectedVariants/query/scroll 私有规则、raw onUnhandledInput |
| `session-tree.ts`、`/sessions`、`/agents` | TreeBrowser | 各自的展开、过滤和搜索导航逻辑；关系数据仍来自原生服务 |
| `Questionnaire`、`ApprovalPrompt`、`PlanReviewPanel` | Wizard/Decision + 标准控件 | cursor/editing/reasonDraft/toggled 和拼接的 checkbox |
| `createConfirmationPanel`、公开 `action.confirm` | 同一个 DecisionState | closure settled 与 core pendingConfirmation 两套机制 |
| Help/Info/Trace/Job output | DocumentState | 私有关闭键、页长、scrollTop、leaf path |
| hint、settings notice、market status、update notice | NotificationState/OperationState | notice 字符串和各功能的清空/染色/寿命逻辑 |
| 官方 CanonicalPanelAdapter、公开 surface 编译 | 同一个 surface session 与 renderer 接口 | 官方专属 focus mirror、main-mode 与无穷 viewport 分支 |

这些是最终删除目标。候选分支中可以逐个迁移消费者并保留一个短期转换边界；对某类控件宣告完成前，必须覆盖官方和仓库内外部消费者。不能以阶段完成为由发布同一角色的两套默认行为，也不能要求仓库无法控制的所有第三方插件同时完成升级；第三方按发布版本和迁移文档升级。

## 11. 实施顺序

| 阶段 | 内容 | 阶段完成条件 |
| --- | --- | --- |
| 0. 固化协议与独立修复 | 将 4.6/4.7 固化为类型、事件轨迹和迁移说明；列明 owner 依赖图；queue 分类等独立修复单独交付 | 公共更新/回执/页面协议无待猜测的关键语义；每个审计项有目标阶段和回归场景 |
| 1. 成对可编辑试点 | frontend 稳定 owner、按 surface 的 Form/Choice reducer、局部动作执行、最小导航/反馈；官方 Provider 编辑表单与真实外部 overlay 共用它们 | 通过下列强制场景和完整 gate、profile 验收；只读 Document/Decision 为辅助，不能代替可编辑证据 |
| 2. 迁移通知与导航 | 可见 feedback、scope/ID/purpose、返回和异步结算、OAuth 持续指引 | 五个通知探针转为修复回归；无 hidden error、串会话和跨操作清空；OAuth prompt 期间完整指引可达且不超时消失 |
| 3. 迁移 Form 与 Choice | 表单 Save/Cancel、设置 enum、OAuth、数值/集合、多选，以及对应公开字段/事件和消费者 | 所有表单/选择器共用协议；导航零领域写入；删除旧 controller 状态机 |
| 4. 迁移 Tree/Tabs/Wizard/Document/Decision | 会话/Agent 浏览、市场、模型、问卷、计划评审与公开 action.confirm | 搜索、边界、tab 保留、只读关闭和确认规则一致；取消保留父级草稿 |
| 5. 跨入口验证与收尾 | 第三方完整 composition、删除转换边界、文档和发布闭包 | 官方/外部相同逻辑轨迹得到相同 UX；源码门禁禁止私有通用逻辑回流 |

这是跨模块和公共 UI 的架构变更，不能靠零散补丁完成。每阶段应有可单独验收的 worktree/profile；通过完整 gate、必要的 package/example 验证和 PTY 后再交付人工验收。凡涉及 Website 的阶段同时提供 LAN preview，按照仓库流程验收后再合并和清理。

第一阶段强制验收：

1. 官方与外部入口执行相同输入轨迹；Tab/切页零领域写入，Save 单次写入，Cancel 恢复父 surface 的同一草稿和焦点。
2. 异步字段校验的旧结果失效；提交失败保留草稿；data 冲突、ack 结算和 replace 重置得到不同且确定的结果。
3. 两个 tab 复用相同字段 ID，切换/重排后各自恢复；明确删除页面后草稿与敏感数据释放。
4. 真实 renderer/core/theme reload 保留存活贡献；app/skills 重载不清除无依赖的外部表单，依赖已卸载业务的表单不复活。
5. 不同 registry 的同名 ID、关闭重开同名 ID、精确 Agent scope 切换均能隔离；旧 callback 和确认不能写入新实例。
6. 20/40/80/160 列和短终端中 Save/Cancel、冲突、字段错误均可达；大列表窗口化和隐藏分支准入的现有保证继续通过。

试点未通过时只调整协议和共享实现，不继续扩大到市场、问卷或全部表单。若共享 reducer 与实例 owner 已满足目标，协调层不再为“唯一模型”而集中更多业务流程。已经确认且可独立验证的 P1 修复可以先交付；具体编码批次、依赖与验收见 [实施计划](./ui-ux-implementation.zh.md)。

每类控件对应的公共契约迁移随该类一起完成，不等到最后才处理第三方入口。试点或未完成的同类迁移保留在验收分支；发布边界按控件协议闭合，不按修改文件数量或内部阶段编号决定。

## 12. 一致性测试与防回归门禁

### 12.1 以控件角色验证所有消费者

建立参数化 conformance suite，输入是同一组声明式场景和事件轨迹，分别挂到官方命令面板与公开 pane/overlay。断言状态和副作用，再检查真实 renderer 的可见结果。

| 测试族 | 必须验证 |
| --- | --- |
| Form | Tab/Shift+Tab 无领域写入；Save 一次；Cancel 草稿；错误定位；多行输入；secret 不泄露 |
| Choice | 焦点/已选/已生效不同；空集合基数；no-op；disabled；ID 重排 |
| Tree/Search | 无业务字母抢输入；空结果可退出；展开恢复；中英文/长文本/粘贴 |
| Tabs | Tab 可进入内容；方向键不循环；显式页面关联；同名字段隔离；各 tab 草稿和锚点保留及删除释放 |
| Decision | 默认不执行；Yes 一次；No/Esc 返回；目标失效后旧事件无效 |
| Notification | 面板期间可见；severity/purpose；scope；按 ID 更新/清除；晚结果与详情；OAuth URL/code 在 prompt 期间可达、不按 TTL 清除、不入历史 |
| Async | 校验拒绝、失败、超时、取消、重复提交、并发、目标删除、Fiber unload |
| Reload | theme/locale/resize/renderer gap 不改变草稿与业务结果；data/ack/replace 区分；真实 app/skills/provider/consumer 卸载依赖图；跨注册同名 ID 和重开隔离 |
| Input/Help | 同一 AvailableActions 驱动实际处理与提示；改键后两者一起变；捕获 surface 阻止底层响应 |
| Layout | 20/40/80/160 列、短终端高度、CJK/长单词；不仅不溢出，还要看得到可操作按钮和错误 |

关键性质：`render` 不修改语义状态；导航轨迹产生零领域 effects；一次有效确认最多发起一次本地动作；另一个 scope 的结果不能改变本 scope 草稿；语言/主题变化不改变已选值。

### 12.2 源码约束

- raw terminal/key parsing、geometry/focus 只在 core。
- feature 不得新增通用 `cursor/editing/filterEditing/selectedIds/pendingConfirmation` 状态机；领域数据的同名字段不误报，采用模块边界和 AST 检查。
- feature 不调用 `notice('')`，不拼 ANSI 或快捷键提示字符串，不私设通用 TTL、页长与确认键。
- `handleInput` 只允许核心输入实现、原生 editor 绑定及明确迁移边界；已迁移 feature 只提交定义与业务 actions。
- 公开 node 仍为 readonly 数据与结构化 actions；注册层承载 callbacks，node 中不塞 Promise/Agent/Session/renderer。
- 完整 gate 继续执行；100% 覆盖率不能代替 UX 一致性测试，因为现有测试已经覆盖并接受了若干不理想行为。

### 12.3 本轮实际验证

本轮直接运行现有源码的 13 个临时审计探针全部通过，即成功复现现状：前轮五个通知问题，以及末字段 Tab 提交、设置/普通列表边界不同、enum Enter 立即触发写入、业务字母抢搜索、core 忽略 supplied submit binding、官方/公开多选空集合不同、问卷用单选伪装多选、tabs 上 Tab 无动作。

日志：`/tmp/mayfly-ux-system-audit-probes.log`。它们没有被加入产品测试来固化这些不一致，也不表示本提案已经实现。其他条目在上文给出了静态代码依据和实施时需要验证的风险。

## 13. 完成标准

统一改造完成后，业务作者新增一个普通表单、枚举选择器、列表、标签页或确认面板，只需要提供数据与业务动作，不需要编写一个 `handleInput`，不需要决定 Enter/Tab/Esc 的细节，不需要保存第二份通用 UI 状态，也不需要自建通知或异步防重流程。

若新增一个命令仍然需要复制另一面板的 cursor、editing、notice 或确认逻辑，就说明统一模型的覆盖尚未完成。
