# Mayfly 通知与队列审计

日期：2026-09-06。基线：`bd171aa`，Harness `0.1.2-alpha.5`。
范围：官方 interaction、app、transcript、core，以及本次权限消息的原生 dsh 生产路径。
本轮是行为审计，没有修改运行时代码。

## 为什么切换权限会显示 queued / step

权限切换和模型消息投递是两件事，当前界面把它们混在了一起：

1. `/permission danger-full-access` 调用原生 permission-presets。
2. 该服务先更新权限，再调用 `approval.setPolicy(agent, 'never')`。
3. `setPolicy()` 写入 `approval/policy` 后，通过 `agent.inject()` 放入模型下一步要读取的消息，来源为 `{ kind: 'plugin', plugin: 'user-approval' }`。
4. [pane-queue.ts](../../packages/mayfly/src/interaction/pane-queue.ts) 无条件遍历 `inbox.nextTurn` 和 `inbox.nextStep`，把所有消息渲染为 `queued / turn` 或 `queued / step`，没有检查来源。
5. 正常的用户反馈另走编辑器下方的 notice，内容是 `preset danger-full-access`。它在下一次编辑、清除或 Agent 选择回调时消失；inbox 消息则要等待被消费或撤回。

所以截图中的 queued 不是权限还没生效，而是给模型的变更说明尚未投递。用户停止发送消息时，它会继续占据编辑器上方；连续切换还可能积累多个方向相反的变更说明。

同一来源在另一个阶段又被隐藏：[conversation/projection.ts](../../packages/mayfly/src/conversation/projection.ts) 的 `user/message` 分支只呈现 `source.kind === 'user'`。于是内部消息在“等待模型读取”时显示，在进入已记录会话后不作为用户消息显示，来源策略前后不一致。`plan-mode` 也会注入插件来源的状态说明，因此问题不只限于 approval。

原生证据来自已安装的 `@deepseek-ai/dsh-permission-presets` 和 `@deepseek-ai/dsh-user-approval` 对应版本的 `lib/index.js`。原生审批含义参见 [Harness 审批参考](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/approval/)。

修复应发生在 UI 的消息分类和路由上，保留模型应收到的原生 inbox 消息；不应为了消除界面文字而删除模型消息，也不应匹配这句英文文案来过滤。

## 当前显示路径

| 类型 | 生产与持有位置 | 显示位置 | 生命周期 |
| --- | --- | --- | --- |
| 通用操作反馈 | `SharedEditor.notice(text)`；`input-plugin` 的单个 `notice` 变量 | 编辑器框下方、状态栏上方 | 后写覆盖前写；编辑、提交、选择回调或空串清除；input reload 后丢失 |
| 待投递消息 | 原生 `Agent.inbox`；`pane-queue` 读取 | 编辑器上方的 bottom pane | 跟随精确 Agent；insert / claim / discard 刷新 |
| 设置反馈 | `SettingsPanelNotice` | 一级设置面板外下方，二级设置面板内部 footer | 面板私有状态；直到替换、关闭或 locale refresh 清除 |
| 插件市场反馈 | `panelStatus: OperationStatus` | 市场面板 header | 面板私有状态，保留 tone；同类命令式操作改用编辑器 notice |
| 更新可用提示 | `local.update-offer` + 编辑器 notice | 内容区域和编辑器下方同时显示 | 内容 slot 随创建 Fiber 存活；hint 更早消失；缓存命中也会重新挂载 |
| 更新中断警告 | `local.update-interrupted` | 内容区域 | 读取持久化 pending marker，slot 随 Fiber 存活，显示行截断 |
| 更新过程与失败详情 | `UpdateProgressState` + document panel | 独立进度/结果面板，关闭后再发 notice | 操作进行中不可关闭，结束后可关闭；有日志路径与回滚状态 |
| 应用导航错误 | `app/index.ts` 的 stderr 输出 | 绕过受管理的 UI surface | 不受通知清除、优先级或会话归属管理 |
| shell 输出、工具结果、会话错误 | local shell slot 或会话 projection | 内容区/对应工具条目 | 属于操作结果与会话内容，不应当整体迁成短暂通知 |
| plan / yolo / jobs 等当前状态 | 原生状态 + status contribution | footer | 当前状态持续展示，独立于通知是否已消失 |

## 问题与不一致

### P1：模型内部说明被展示成用户排队任务

位置：`pane-queue.ts:23`，对照 `conversation/projection.ts:430`。

表现就是本次截图。除了暴露内部 `turn` / `step` 术语，还使用户误判“操作仍在等待”。队列同时缺少来源标识；只有图片的用户消息又会显示为空的 `queued / turn:`。已有 queue 单测只构造用户文本，对图片的测试反而明确接受空文本，没有覆盖策略消息来源。

建议：用户主动提交但尚未处理的内容才进入任务队列；运行时策略说明继续留在原生模型通道。附件队列应显示附件摘要。插件主动产生的用户通知应由明确的 UI 贡献或通知语义表达，不能因其位于 inbox 就自动认作用户排队任务。

### P1：面板中的失败写入了已隐藏的通知区

位置：[editor-dock-host.ts](../../packages/mayfly/src/interaction/editor-dock-host.ts) 的 `render()` / `renderHint()`。

只要 panel stack 非空，host 只绘制最上层 panel，完全不绘制 editor hint。以下调用却在保持面板打开时调用 `getSharedEditor(...).notice(...)`：

- [agents-command.ts](../../packages/mayfly/src/interaction/agents-command.ts)：one-shot、不再 live、拥有 live 后代等停止拒绝分支。
- [jobs.ts](../../packages/mayfly/src/interaction/jobs.ts)：读取详情失败、kill 被拒绝。
- [preset-commands.ts](../../packages/mayfly/src/interaction/preset-commands.ts)：选中损坏的 preset。
- [permission-panel.ts](../../packages/mayfly/src/interaction/permission-panel.ts)：选择 derived custom 的拒绝分支。
- [provider-add.ts](../../packages/mayfly/src/interaction/provider-add.ts)：OAuth `notify()` 的网址与验证码在授权 prompt 打开期间可能被遮住。

用户看到的是按键没反应，关闭面板后反而出现上一条错误。设置面板明确知道这个限制，因此单独建了 `SettingsPanelNotice`；市场又另建 `OperationStatus`。目前不是一个统一策略在不同地方渲染，而是各功能是否自行绕开这个坑的区别。

建议：当前交互面下方保留统一的反馈出口，面板打开也可见；字段校验仍留在字段旁，完整进度与结果详情仍在所属面板中。

### P1：迟到的反馈会落在别的 Agent 上

位置：`input-plugin.ts:445` 的 `commands.execute(agent, ...).then(...)`；`permission-panel.ts:98`；`mode-commands.ts:59`。

通用命令结果回调只检查 input Fiber 是否卸载，不检查用户是否已切到另一个 Agent。切换会清除旧 notice，但旧操作随后完成，又向现在的全局 hint 写入旧结果。权限面板与快捷键也通过“当前 shared editor”发布结果，没有记录发起时的 Agent/选择代际。

建议：反馈记录绑定发起时的 scope 和操作 ID。session 级结果在对应会话显示；application/profile 级操作可以跨会话，但应明确标明目标，不能统一套用“只检查 unload”。

### P1：严重级别丢失，错误与普通信息不能稳定区分

位置：`editor-instance.ts:22`、`input-plugin.ts:192`、`plugin-commands.ts:161`、`paste-image.ts:520`。

通用接口只有字符串，没有 `severity`。普通命令错误会由调用方先套 `colors.error`，粘贴失败、jobs 失败等则直接传字符串；HintLine 再统一套 muted。不能仅因外层 muted 就断言所有嵌套颜色失效，但最终视觉确实依赖各调用点是否预先染色。

最明确的对照是插件市场：面板内 reporter 保留 `{ text, tone }`；命令式默认 reporter 只发送 `status.text`，丢掉 danger/success。相同安装失败因入口不同而呈现不同。

建议：生产者传结构化 severity，renderer 统一决定颜色与标识；不要把 ANSI 编码当通知语义。

### P2：通知互相覆盖，也能被别的流程清空

位置：`input-plugin.ts:298`、`commands-plugin.ts:163`、`input-plugin.ts:775`。

所有生产者写同一个变量。`/sessions` 扫描结束用 `notice('')` 清除“loading sessions”，但期间的新错误也会被一并清掉；滚动暂停时的“new messages available”同样可以覆盖一条操作失败。没有 stable ID、owner 或按 ID replace/clear，清理动作无法证明自己删的是哪一条消息。

建议：同一 operation 的进度与结果按 ID 更新，清除只能清除自身消息。滚动提示属于状态，不应抢占重要操作反馈。

### P2：持续时间取决于实现路径，而不是消息语义

位置：`input-plugin.ts:653` / `:685`、`settings-command.ts:1021`、`updater/check.ts:192`。

hint 不是定时 toast：不编辑可以一直存在，编辑任意字符则立即清除，input/theme reload 会丢失。设置自己的反馈会在 locale refresh 清除，更新 slot 则独立于 input/theme 存活。同样的错误可能一键消失、藏在面板后继续保留，或者常驻内容区。

建议：明确 success/info、进行中的操作、warning/error、恢复警告各自的清除条件；进行中的反馈随操作结算，重要失败提供可回看详情，不能全部绑定编辑器的 onChange。

### P2：长通知的裁剪和详情获取不一致

位置：`input-plugin.ts:199`、[update-notice.ts](../../packages/mayfly/src/interaction/update-notice.ts) 的 `render()`，对照 `update-command.ts` 的 document panel。

hint 最多八行，超过后只显示 `... more`，没有展开 action；更新可用和更新中断提示逐行截断，恢复路径等信息可能在窄屏下不可读。更新失败的完整进度面板却有滚动和日志路径，说明已经存在更合适的详情承载方式。

建议：短摘要在反馈区，长文本提供明确的查看详情入口；截断标记不能暗示存在实际不可操作的“更多”。

### P2：相同动作的重复展示与清除不同步

位置：`updater/check.ts:207` / `:211`；本次 permission 的 inbox + hint + footer。

更新提示同时挂内容 slot 和发 hint，二者没有共同的 acknowledgement 或清除状态。权限的 footer、成功反馈、模型说明分别读不同生命周期的数据。持久状态与短反馈并存本身合理，但重复呈现内部变更句子并不增加有用信息。

建议：每种事实明确一个主要展示位置。footer 表示当前状态，notice 表示本次操作结果，队列只表示待处理输入。

### P2：部分可恢复错误仅输出到终端或 logger

位置：`app/index.ts:175` / `:183` / `:199` / `:216`；`permission-panel.ts:111`；`mode-commands.ts:66`。

resume/new/fork/rewind 失败走 stderr；普通命令失败走下方红色提示；某些 picker/快捷键的执行异常只记 logger。同一件“用户动作失败”没有统一的可见结果。

core 已有 [terminal.ts](../../packages/mayfly/src/core/terminal.ts) 的 output recovery，alternate 模式遇到旁路 stdout/stderr 后会重绘，所以不能将此描述成必然永久破坏终端。问题在于重绘不把原始输出变成一个可管理、可回看的通知，文字可能闪现后被恢复帧覆盖。

建议：启动前、无法建立 UI 或退出中的错误继续使用 stderr；UI 运行期间的可恢复动作失败应同时落到所属反馈区，日志仅作为详细诊断。

### P3：文档描述与真实布局已漂移

位置：`input-plugin.ts` 文件头仍写“flattened to one display row before truncation”，实际 HintLine 会换行并保留最多八行；`SettingsNoticeController` 注释仍写“always exactly one row”，实际 canonical text 可换行且空状态不保留这一行；`docs/mayfly-architecture.md` 把临时 notice/echo 一并归入 local activity，实际大量 notice 属于 editor dock。

建议：先确定通知模型和位置，再同步这些所有权与布局说明，否则后续实现会继续根据过时描述选择错误出口。

## 不应混为通知的内容

- 用户真正排队的 prompt/steer：是待处理输入，应留队列，不应因为内部策略消息问题而全部移到 hint。
- plan/yolo、任务数等：是当前状态，应留 footer/pane。
- 工具错误与执行结果：属于对应会话/工具条目，不能只给短暂通知然后丢失上下文。
- 字段校验：应该贴近字段；审批和问题：是需要用户回答的交互，不应退化成通知。
- 用户手动执行 shell 的输出：是本地操作结果；更新日志：是长任务详情，均有独立内容区域的合理性。

## 建议统一方向

| 语义 | 默认呈现 |
| --- | --- |
| 模型内部 runtime 通知 | 保留原生模型消息，不进入用户排队面板 |
| 用户待处理输入 | 编辑器上方队列，带可理解的目标与附件摘要 |
| 短操作结果、警告、错误 | 当前 editor 或 panel 下方、footer 上方的统一反馈区 |
| 字段校验 | 原字段旁，必要时有摘要 |
| 长任务进度/详情 | 所属面板；反馈区提供摘要或详情 action |
| 当前状态 | footer 或对应 pane |

统一记录至少需要来源/owner、scope（app/session/panel）、操作 ID、severity、状态、正文/详情、清除策略。可以在现有 interaction owner 和现有 slot 里统一，不必新增一套公开 UI service；renderers 仍消费 readonly 数据，dsh 继续持有领域状态。

建议实施顺序：先修 queue 的来源分类；随后让面板也有可见反馈；再处理消息归属、异步代际、按 ID 更新/清除和 severity；最后统一长文本、重复提示与文档。

## 验证证据

五个隔离的临时 Vitest 探针直接运行现有源码，均复现了现状：

1. plugin 来源的 policy 消息被渲染为 `queued / step`。
2. panel 打开时 notice 不显示，关闭后才显示。
3. 一个生产者的空串清理会清除另一生产者的新消息。
4. 旧 Agent 的慢命令完成后写入新 Agent 的 hint。
5. 十二行通知只剩八行，末行 `... more`，后续内容不可见。

执行记录：`/tmp/mayfly-notification-audit-probes.log`。这些探针证明问题存在，不代表修复已完成；它们未写入产品测试来固化这些不理想的行为。原有运行时代码与验收 profile 本轮保持不变。
