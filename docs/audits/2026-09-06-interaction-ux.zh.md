# Mayfly 交互审视：确认、表单和选择

日期：2026-09-06。范围：Mayfly 官方交互层及其使用的 core 控件，不评价第三方插件或模型自己生成的问卷文案。

这次问题的共同原因是把用户的决定压缩成了文本输入或隐含键盘操作。确认应当是选择，输入应当收集真实数据，移动焦点应当与提交区分。现有测试能证明实现符合既定行为，但既定行为本身仍可能违背用户预期。

## 本次已修复

| 原行为 | 影响 | 调整 |
| --- | --- | --- |
| 完全访问、停止子 Agent、删除 Provider、更新 Mayfly 都要求输入固定的 `y` | 把二选一变成文本编辑，输入 `yes` 反而不合法；确认与表单编辑状态混在一起 | 共用显式 Yes / No action 面板；默认焦点为 No；Yes 执行，No / Esc 取消 |
| Provider 删除确认取消后结束整个编辑流程 | 意外丢失尚未保存的草稿，取消的影响超过当前一步 | 确认叠在原编辑表单上，取消后恢复同一个表单与草稿 |
| 完全访问提示“every tool call runs unchecked” | 错把 dsh 的 `never` 审批策略描述为全部放行 | 明确文件沙箱关闭；仍需审批的请求不询问而直接拒绝 |
| 停止子 Agent 只要求输入 `y`，没有说明与中断当前 turn 的区别 | 用户可能把释放整个 live Agent 理解为暂停 | 确认正文说明结束 Agent、释放资源，保留已保存的会话 |

实现集中在 [confirmation-panel.ts](../../packages/mayfly/src/interaction/confirmation-panel.ts)。已有 canonical actions 承担绘制与焦点；没有增加 renderer 或公共 UI 类型。四个消费者仍使用原来的原生写入路径。

验证覆盖默认 No、显式 Yes、Escape、重复激活、中文、返回草稿、权限选择器、子 Agent 的晚结果和后代检查、更新失败回滚，以及宽度扫描。Provider 的 OAuth 现有路径补充了 mock 交互测试；本次没有修改其产品行为。

## 其余问题

以下为仍存在的问题，优先级按误操作与数据影响排序。除已有自动化测试明确覆盖的行为外，证据为当前代码路径，不把静态推导冒充用户实测。

### P1：Tab 在末字段会提交整张表单

位置：[form-panel.ts](../../packages/mayfly/src/interaction/form-panel.ts)，`handleInput` 与 `onTextSubmit`；[ui-compiler.ts](../../packages/mayfly/src/core/ui-compiler.ts)，编辑态的 Tab 分支。

触发：编辑 Provider 最后一个 API key 字段，输入内容后按 Tab。core 将 Tab 交给 `onSubmit`；表单控制器向后已无字段，于是调用整表 `submit()`，触发保存。这里没有独立的 Save / Cancel action。

影响：用户原本只是想移动焦点或检查其他字段，却已经执行写入。Enter 在导航态、编辑态与最后一项也分别代表进入编辑、确认字段和提交表单，操作成本依赖不可见的状态。

建议：Tab / Shift+Tab 只移动并保留草稿；整表增加显式 Save / Cancel。Enter 的行为由聚焦控件决定，字段确认与整表提交分开。改动涉及所有官方表单，需独立迁移并覆盖凭据、设置和 Provider 向导。

### P1：设置里的枚举“查看下一项”就是持久化写入

位置：[settings-command.ts](../../packages/mayfly/src/interaction/settings-command.ts)，`CanonicalSettingsController.activate()`、动态权限行及 `commitRow()`。

触发：在 `/settings` 的枚举设置上按 Enter / Space。界面直接循环到下一值并调用写入；其中包括 `permission.defaultPreset` 等会影响后续会话的配置。

影响：用户看不到完整选项集合，无法先比较后确认。对默认权限这类敏感枚举，一次原本用于“打开选项”的 Enter 会改变默认行为。Boolean 的即时切换通常合理，多个互斥选项不宜共用同一种循环操作。

建议：布尔值保留开关；枚举打开单选列表，清楚标记当前值与候选值，确认后再写入。权限变化同时显示实际的沙箱与审批后果。

### P2：OAuth 的选择题退化成自由文本

位置：[provider-add.ts](../../packages/mayfly/src/interaction/provider-add.ts)，OAuth `interaction.prompt()`。

触发：授权提供方返回 `kind: 'select'` 与 options。当前实现把 `id: label` 拼成字段标签，仍然创建普通输入框，校验只有非空。

影响：用户必须辨认并手输内部 option id，无法直接选择；拼写错误仍会传回提供方。选项缺失时还会呈现空标签输入框。相邻的 Provider 来源和协议步骤已经有可复用的单选控件。

建议：`text`、`secret`、`select` 分别映射到文本、密文、单选控件；无候选项时显示明确错误或由协议定义退路。

### P2：多选“零选中”会隐式选择光标项

位置：[select.ts](../../packages/mayfly/src/interaction/select.ts)，`CanonicalMultiSelectController.confirm()`；已有 [select.spec.ts](../../packages/mayfly/tests/interaction/select.spec.ts) 明确断言这一回退。

触发：在模型多选列表里不勾选任何项，或者取消所有勾选，再按 Enter。若列表非空，提交结果为当前光标项，而不是空数组。

影响：勾选状态与实际提交结果不一致，用户可能无意中采用一个模型。光标表示导航位置，选中集合表示决定，两者不应互换。

建议：允许空集合的调用方提交空集合；要求至少一项的调用方禁用确认或显示局部校验。若需要单选快捷流程，应单独定义，不借多选的空状态实现。

### P2：再次选择已启用的完全访问仍会确认

位置：[permission-panel.ts](../../packages/mayfly/src/interaction/permission-panel.ts)，列表 `onSelect`。

触发：当前已经是完全访问，打开 `/permission`，在标记为 current 的那行按 Enter。仍然打开确认面板，尽管上游 setter 对相同值本来是 no-op。

影响：无变化也要求确认，增加点击并削弱用户对真正权限变化提示的注意力。

建议：选中当前值直接关闭；只有目标配置会改变权限时才确认。

### P2：通用 action 的确认仍是第二次 Enter

位置：[ui-patterns.ts](../../packages/mayfly/src/core/ui-patterns.ts)，`actionToken()`；[ui-compiler.ts](../../packages/mayfly/src/core/ui-compiler.ts)，`pendingConfirmation`。

触发：带 `confirm` 属性的公开 UI action 首次激活后，在原按钮文字后追加问题；再次 Enter 执行，Escape 取消。

影响：这是另一套确认语言，缺少显式 No，与本次官方面板的新行为不同。该机制属于公共 UI 合约，插件也会使用，不能只改官方消费者后宣称所有确认已经统一。

建议：后续为通用 action 提供一致的确认呈现，同时保持已有 `confirm` 字段的行为契约、一次性执行、焦点代际与 Escape 语义；需要 renderer、截图和外部消费者回归。

### P3：集合与数值仍普遍借用字符串表单

位置：[provider-add.ts](../../packages/mayfly/src/interaction/provider-add.ts)，`fillModelDefaults()`；[form-panel.ts](../../packages/mayfly/src/interaction/form-panel.ts)，`FormField`。

触发：补全模型信息时，context window 是纯数字文本；reasoning efforts 是逗号分隔的字符串枚举。官方 `FormField` 仅表达普通输入和密文，缺少这些值的专用语义。

影响：用户需要记住格式和合法值，直到提交才看到错误。多个用途看起来完全一样，输入框被迫承担选择器、数值输入和确认的全部任务。

建议：集合使用多选，数值使用带单位与边界的输入；实际需要自由文本的字段继续用文本框。扩展前先明确每种控件的导航与提交规则，避免把表单里的隐含提交问题复制过去。

## 建议实施顺序

1. 先分离表单导航与提交，并增加显式 Save / Cancel。
2. 再修设置枚举与 OAuth select，让选项可见、选择与提交分开。
3. 修正多选空状态与权限 no-op 确认。
4. 最后统一公开 action 的确认呈现与数值/集合控件，按公共 UI 变更完成全部验收。

本次改动继续保留上一轮的约定：Shift+Tab 只切 normal / plan，YOLO 由独立权限命令控制，状态栏可同时展示 plan 与 yolo。
