# Mayfly 终端 UX 优化设计：统一交互模型下的全表面对齐

- 状态：设计文档（基于已实现的统一交互架构；不含已合并的运行时改动）
- 基线：`867082e`（main）
- 范围：全部已实现的 surface、命令、编辑器状态与按键路由
- 相关文档：`ui-ux-unification.zh.md`（共享交互契约）、`ui-interaction-progress.zh.md`（重构完成记录）、`packages/mayfly/AGENTS.md`、`packages/ui/AGENTS.md`

## 0. 结论摘要

统一交互架构已经完成（Step 1–20）：所有 overlay 走 `UiSurfaceModel` + 编译器按键分发，不存在私有控制器。剩下的是**体验层**问题，可以归纳为五类：

1. **直达键缺失**：决策类列表（provider kind、effort、审批、plan）靠 ↑↓ + Enter，没有数字直达。
2. **弹窗套娃**：`/model` Enter 后再弹二级表单重选 effort；provider edit 的加模型走独立弹窗。
3. **流程隐式**：provider add 的 tab 顺序与实际依赖（key → discover → 选模型 → save）相反；Save 禁用时不给原因。
4. **可发现性差**：segment 行内 ←→ 调 effort 已实现但无提示；select 的方向键即时循环无提示。
5. **输入态冲突**：filterable 列表上绑裸字母快捷键会吞掉 type-to-filter 的首字符。

本文档先固定"现状事实"（第 1–2 节），再给出全局键位语法（第 3 节）、控件规范（第 4 节）、生命周期规范（第 5 节）、编辑器全状态（第 6 节）、逐命令盘点（第 7 节），最后是契约增量清单（第 10 节）与迁移优先级（第 11 节）。每条建议都标注实现代价：*[已支持]* / *[编译器]* / *[契约]* / *[投影]* / *[原生]*。

## 1. 现有统一交互架构（事实）

### 1.1 分层

```
native dsh ──────────────── 领域事实与写入（Agent/Session/Settings/Credentials/Jobs…）
   ↑ 只读快照 + 结构化写入
interaction/ ────────────── 命令 handler → wire 节点（packages/ui 契约，无渲染对象）
   ↑ MayflyUiEvent（observation=事实 / action=结构化提交）
core/ui-interaction-* ───── 共享状态：Form/Choice/Document/Tree/Notification + SurfaceModel
   ↑ UiSurfaceModel.invoke：confirm→decision、validate→handler→reply(accepted/invalid/
     conflict/failed/completed/cancelled)→publish→settle
core/ui-compiler.ts ─────── wire→control 编译、焦点/分组、按键分发（单一优先级链）
   ↓
core/ui-patterns.ts ─────── 渲染原语（renderList/renderForm/renderActions/renderTabs…）
```

要点：

- **按键只在一个地方分发**（`ui-compiler.ts` 的 `handleInput`），优先级固定，见 §1.3。
- **Overlay 声明式**：`{ presentation: 'editor' | 'overlay', dismissal: 'confirm-dirty' | 'discard', capturing, scope }`；`presentation: 'editor'` 的 overlay 替换编辑坞（listSessions、agents、marketplace 等全部如此）。
- **确认是共享 decision 节点**：action 声明 `confirm` 后，invoke 先渲染 `{ danger title, [No]*, [Yes] }` 替换整个 surface，No 默认聚焦；返回后才执行 handler。
- **异步全部围栏**：source `{ resourceId, revision }` + AbortSignal + exact Agent；迟到的快照/回复被拒。

### 1.2 共享状态模型

| 状态 | 载体 | 跨重载存活 |
| --- | --- | --- |
| 表单草稿 | `UiFormState`（字段值、dirty、错误） | 是（frontend 持有，core 重建不丢） |
| 列表焦点/选中/查询/展开 | `UiChoiceState`（focusedIndex、selectedIds、query、matches、expandedIds、searchAnchor） | 是 |
| 文档滚动 | `UiDocumentState` | 是 |
| 确认决策 | `decision`（surface 级，一次一个） | 随 surface |
| 编辑器草稿/历史 | `draft-stash` | 跨 theme/core 重载 |

### 1.3 按键分发优先级（编译器事实）

`handleInput` 的判定顺序，高优先级先消费：

```
1. 焦点控件属于 filterable 列表：
     searching:  Esc→退出搜索  Ctrl+U→清空  可打印字符→进 query（Enter 除外）
     !searching: '/'→进搜索   已声明快捷键/保留动作→优先  其余可打印字符→type-to-filter
2. Esc 链：select picker 取消 → wizard back() → dismissal='discard' 直通
          → 有 tabs 时跳回父 tab 组 → onUnhandledEscape（关 overlay/打断）
3. 声明快捷键（keyed accelerator）：仅当 !searching && !editor && !文本/select 编辑中
4. 空列表 + Enter → selection-accept
5. Tab/Shift+Tab → 先提交进行中的文本/select 编辑，再 moveGroup(±1)
                   （surface 只有一个 editor 时 Tab 透传给编辑器=补全）
6. editor 控件 → editor.handleInput（补全/历史/改写归 pi-tui）
7. 文本字段编辑中 → 编辑器；Enter=单行提交并移出 / textarea 换行；Alt+Enter=换行
8. select 未编辑 + 方向键 → 即时循环（begin+move+select+finish，一步完成）
9. select 编辑中 → picker（↑↓ 移动、Space 勾选 multiselect、Enter 选定退出）
10. scroll 控件 → ↑↓/PgUp/PgDn/Home/End
11. tab 控件 → ←→ 切 tab（发 tab-change 观测）；Enter → 跳到下一控件组
12. list 行 → Space=树展开/折叠；↑↓/PgUp/PgDn/Home/End=移动；←→=segment 调节
13. 方向键 → 同轴组内移动，否则几何最近控件
14. 文本字段未编辑 → Enter 或可打印字符 → 进入编辑
15. select 未编辑 → Enter → 进入 picker
16. field-action → Enter/Space → 发表单 intent
17. toggle → Enter/Space → 翻转
18. submit → Enter/Space → invoke（confirm/validate/handler 链）
19. event 控件 → Enter/Space → 发 activate 事件
```

三条规则推论：

- **裸字母快捷键在搜索中失效**（搜索优先）；**不在搜索时优先于 type-to-filter**——所以 filterable 列表上绑字母快捷键会吞掉该字母的首字符（M2 问题的根源）。
- **Esc 永远先收最内层**（picker → wizard → tab → surface），不会一键炸掉整个栈。
- **方向键有兜底几何导航**：焦点在 actions 行按 ↑ 会回到上方列表。

### 1.4 Overlay 生命周期

| 属性 | 语义 |
| --- | --- |
| `presentation: 'editor'` | 替换编辑坞（picker 类 UI 的默认形态），capturing 时独占按键 |
| `presentation: 'overlay'` | 浮层（decision、confirm 等） |
| `dismissal: 'confirm-dirty'` | 表单 dirty 时 Esc 弹共享 decision（"Discard unsaved changes?"） |
| `dismissal: 'discard'` | Esc 直接关（只读浏览器类） |
| `reopen: 'focus'/'replace'` | 同 id 再开是聚焦还是替换 |
| `scope` | `app` / `session:{id}` / `panel`；session 级随 Agent 精确身份失效 |

## 2. Kimi Code 交互约定 → Mayfly 适配

| Kimi 约定 | Mayfly 现状 | 适配动作 |
| --- | --- | --- |
| 编号直达（1./2./3. 选动作） | 无 `numbered`；plan review 手写 `1. Approve` 进 label | **M1**：`MayflyListNode.numbered`，编译器把 `1-9` 映射为行选择 *[契约+编译器]* |
| `!` 前缀进 bash | 已实现（editor-plus，含空 bash Backspace/Esc 退出） | 保持 |
| `@` 文件提及 / `#` 技能 | 已实现 | 保持 |
| 参数幽灵提示 `/cmd [args]` | 已实现（`input.hint` → ghost） | 保持 |
| Tab/Shift+Tab 组间移动 | 已实现（moveGroup） | 保持 |
| Esc 逐级退（补全→编辑→搜索→向导→surface） | 已实现 | 保持 |
| Enter=确认 / Alt+Enter=换行或次动作 | Enter=确认已实现；Alt+Enter 仅 textarea 换行 | **M2**：`Alt+Enter` 作为"替代提交"（/model session-only） *[契约+编译器]* |
| 搜索：输入即过滤 | 已实现（type-to-filter + `/` 显式搜索 + Ctrl+U 清 + Esc 退） | 保持 |
| 危险动作二次确认、安全项默认焦点 | 已实现（共享 decision，No 默认聚焦） | 保持 |
| 双击 Ctrl+C 退出 | 已实现（2s 窗口 + hint） | 保持 |
| 状态栏极窄、动作行单行 | 已实现 | 保持 |
| 长内容就地展开 | 无 | **M6**：`Ctrl+E` 把聚焦的长文本/url/code 提全屏只读 viewer *[编译器]* |

## 3. 全局键位语法

### 3.1 规范键位表（所有 surface 通用）

| 键 | 语义 | 归属层 | 副作用范围 |
| --- | --- | --- | --- |
| ↑↓ | 组内移动 / 滚动 / picker 选项 | 编译器 | 视图 |
| ←→ | tab 切换（条聚焦时）/ list segment / select 即时循环 | 编译器 | 视图/草稿 |
| Alt+←→ | 全局切 tab（内容区可用，编辑态除外） | 编译器 | 视图 |
| PgUp/PgDn | 翻页（scroll、list、文档） | 编译器 | 视图 |
| Home/End | 首/尾（list、scroll、文档） | 编译器 | 视图 |
| Space | 树折叠、multiselect 勾选、toggle、field-action | 编译器 | 草稿/视图 |
| Enter | 接受/提交/进入编辑/激活 action | 编译器 | 草稿→可能触发 handler |
| Alt+Enter | textarea 换行；扩展：替代提交（session-scope，已定 §12） | 编译器 | 草稿/提交 |
| Tab / Shift+Tab | 下一/上一控件组（提交进行中的编辑） | 编译器 | 焦点 |
| Esc | 逐级退：picker→搜索→向导→tab→surface | 编译器 | 视图/可能触发 dirty decision |
| `/` | 进入列表搜索（filterable） | 编译器 | 视图 |
| Ctrl+U | 清空搜索并回锚点 | 编译器 | 视图 |
| `1-9` | **建议**：numbered 列表直达 | 编译器（M1） | 选择 |
| `Ctrl+E` | **建议**：长内容全屏展开 | 编译器（M6） | 视图 |
| 声明快捷键（如 `c`/`r`/`o`） | action `key` 字段 | surface 声明，编译器分发 | 触发 handler |

### 3.2 编辑器专属

| 键 | 行为 | 条件 |
| --- | --- | --- |
| `!`（空缓冲首字符） | 进 bash 模式 | prompt 态 |
| `/`（首字符） | slash 补全 | 非 bash |
| `@` | 文件提及补全 | 任意位置 |
| `#` | 技能补全 | 非 bash |
| `↑↓` | 历史 | 补全关闭时 |
| Enter | 提交（transforms→followup） | — |
| Alt+Enter | 换行 | — |
| Ctrl+S | steer 当前 turn | running |
| Ctrl+G | $VISUAL/$EDITOR 外部编辑 | 无进行中外部编辑 |
| Shift+Tab | plan 模式循环 | — |
| Alt+M | 轮换会话模型 | — |
| Esc | 关补全 →（running 时）interrupt/撤回 → 清空草稿 | 链式 |
| Ctrl+C | 有草稿→清空；空+running→interrupt；空+idle→双击退出 | 链式 |
| Backspace/Esc（空 bash） | 退出 bash 模式 | bash 态 |

### 3.3 快捷键冲突与提示行

- 声明快捷键经 keymap 批量注册，重复/冲突抛错（已有 `KEY_CONFLICT`/`DUPLICATE_ACTION`）。
- **规则（已定 §12）**：filterable 列表的 surface **不得**绑可打印字符快捷键（会吞 type-to-filter 首字符）；需要快捷操作时要么绑非打印键，要么把动作放 actions 行让 Tab 到达。*[编译器：注册时对 filterable surface 的可打印键告警]*
- 提示行（surface footer 的 muted 行）只列**当前态可用**的键，格式 `key action · key action`，优先级：危险/退出 > 搜索 > 主操作 > 导航。过滤中显示 `/ query` 行替代提示行。

### 3.4 光标与标记

| 标记 | 含义 |
| --- | --- |
| `→` | 焦点行（可到达） |
| `●`/`○` | 已选/未选（multiple 模式） |
| `[x]`/`[ ]` | multiselect/树勾选态 |
| `*`/`current` | 当前生效项（badge） |
| `…` 前缀 | action busy |
| `!` 前缀 | danger intent |
| `‹ ›` | 聚焦 tab / select 占位 |
| `⠋`/`≈` | loader（braille/tide） |

## 4. 控件行为规范（ASCII 演示）

### 4.1 文本输入（input/secret/number）

```
非聚焦        聚焦未编辑      编辑中            校验失败
Name: foo     → Name: foo     → Name: fo▌     → Name: ▌
                                             ! required
```

- Enter 或可打印字符进入编辑；Enter 提交并移到下一组；Tab 提交并移组；Esc 由 §1.3 链处理。
- secret 显示 `•••••`，不回显明文。
- number 显示 `值 unit`，编辑同 input，提交时做 min/max 校验。

**建议**：单字段表单（onboarding、OAuth prompt、plan feedback）支持 Enter 直接提交整个表单——`MayflyFormNode.enterSubmits` 或提交 action 的隐式默认 *[契约+编译器]*。

### 4.2 select（关键发现：已有即时循环）

```
未聚焦                 聚焦（←→ 即时循环）        编辑中（Enter 进 picker）
Protocol: openai-*   → Protocol: openai-*      → Protocol
                                                > [ ] openai-completions
                                                  > [x] anthropic-messages
                                                  > [ ] custom
```

现状：聚焦态按 ←→ **不换焦直接改值**（编译器 §1.3-8）；Enter 才展开 picker。**问题**：无任何提示，用户不知道 ←→ 可用。**建议**：聚焦行尾渲染 `‹ ›` 提示 *[编译器渲染]*。

### 4.3 multiselect / toggle

```
→ Notifications                      → Notifications     → Notifications
   > [x] mentions                       [on]                (无展开，Enter/Space 直接翻)
   > [ ] errors
```

### 4.4 list：browse / choose / multiple / tree / segment

```
╭ Select a model ─────────────────────────────────────────╮
│ / deep▌                    ← 搜索行（searching 时显示）  │
│ DeepSeek                  ← group 头（muted）            │
│ → deepseek-v4-pro  256k    ← 焦点行（反色）              │
│   deepseek-v4      128k                current ← badge   │
│    Thinking: default ‹ off › low +3   ← segment 行      │
│                                        (4/12) ← 计数     │
│ Type filter · ↑↓ · ←→ effort · Enter default · Esc       │
╰──────────────────────────────────────────────────────────╯
```

- `tree: true`：Space 折叠/展开，父子行缩进。
- `segment`：焦点行下方横排选项条，←→ 调值（已用于 model effort）。
- `filterable`：type-to-filter；`/` 显式搜索；`Ctrl+U` 清并回锚点；`Esc` 退搜索。
- `acceptActionId`：choose 模式 Enter 触发的 action。

### 4.5 numbered choose（建议 M1）

```
╭ Add provider · step 1/3 ────────────────────────────────╮
│ → 1. Known provider — preset endpoints                   │
│   2. Custom endpoint — any compatible URL                │
│   3. OAuth provider — browser sign-in                    │
│                                                          │
│ 1-3 choose · Enter next · Esc cancel                     │
╰──────────────────────────────────────────────────────────╯
```

数字键直达；↑↓+Enter 等效。用在 ≤9 项的决策列表：provider kind、effort、审批选项、plan 决策。

### 4.6 tabs / wizard

```
普通 tabs                        wizard（带进度）
‹ Models ›  Connection  Creds    Kind  ‹ Connection ›  Models   ← 完成度由 surface 追
```

- ←→ 切 tab（发 tab-change 观测，handler 可重投影内容）；Enter 跳入页内首控件；Esc 在有 tab 组时先回 tab 组。
- **Alt+←→ 全局切 tab**：内容区任意控件聚焦时可用（文本/select 编辑态除外），切完焦点落进新 tab 的记忆/首个内容控件；焦点在 tab 条上时落在新条目的 strip 位。提示 `Alt+←→ tabs`。
- wizard 的 Back/Next 由 surface 的 `back()`/navigate 驱动，Esc=back。

### 4.7 scroll 文档

```
╭ trace · #12 ────────────────────────────────────────────╮
│ Type: tool/call   Surface: main                          │
│ ┌ json ──────────────────────────────┐                   │
│ │ {...}                              │ ← scroll 控件     │
│ └────────────────────────────────────┘                   │
│ Page: [2] of 5   [ Previous ] [ Go ] [ Next ]            │
│ [ Copy trace item ]  [ Close ]                           │
╰──────────────────────────────────────────────────────────╯
```

焦点在 scroll 控件时 ↑↓/PgUp/PgDn/Home/End 滚动；文档分页由 `documentPages()` 切片（不拆 surrogate pair、不丢行尾）。

### 4.8 actions 行

```
 [ Save ]   Cancel   ! Delete provider
 ↑primary   普通      ↑danger
```

- 聚焦 action 反色 + `→` 标记；busy 显示 `… label`；disabled 灰显。
- **建议**：disabled 必须给 `disabledReason`（契约已有字段，现状多数未填），渲染为 `label (reason)` *[投影]*。
- **建议**：invoke 期间自动把发起 action 标记 busy 直到 reply（M4） *[编译器]*。

### 4.9 loader / empty / progress

```
⠋ discovering models from api.example.com…   ← loader(braille) + elapsedMs
≈ waiting for authorization                  ← loader(tide)

No sessions found                            ← empty
Restore a checkpoint with /rewind            ← empty.description

Progress ██████░░░░ 6/10                     ← progress（窄宽先丢 label 再丢计数）
```

## 5. Surface 生命周期规范

### 5.1 共享 decision（已实现，规范：唯一确认形态）

```
原 surface 被整体替换为：

╭ Discard unsaved changes? ───────────────────────────────╮
│ → [ No ]   [ Yes ]          ← No 默认聚焦                │
╰──────────────────────────────────────────────────────────╯
```

- 所有"危险/不可逆/脏表单丢弃"都走它，不自造确认 UI（permission-panel 的自绘 confirm overlay 是例外，可保留：它需要带说明文字） *[已支持]*。
- 确认期间原 surface 输入被整体屏蔽（decision 节点替换渲染）。

### 5.2 提交与回复链（已实现）

```
action.invoke
  → confirm? ──yes──→ decision（§5.1）→ 返回后继续
  → busy/pending? ──→ 忽略（防重入）
  → submit → 收集表单草稿+revision → 校验
      校验失败 → invalid → 字段错误渲染（! msg），draft 保留
  → handler(event) → reply：
      accepted(node,source)  换快照
      conflict(node,source,message)  换快照+提示（settings 外部修改场景）
      failed(message,…,acceptedFields?)  保草稿+提示
      completed / cancelled   关或留
      + feedback → 通知行   + dismiss → 关   + navigate → 向导跳页
```

### 5.3 异步状态（已实现+建议）

| 状态 | 现状 | 建议 |
| --- | --- | --- |
| pending（等待 handler） | invoke 期间阻塞重入，无视觉变化 | M4：发起 action 自动 `… busy` *[编译器]* |
| loading | 各 surface 自绘 loader 行 | 保持；进入异步页时 loader 就地显示（provider discovery 现状静默，需补）*[投影]* |
| failed-retry | 通知行 + 重开 | `r` 重试只在有该 action 的面板绑 *[已支持]* |
| stale/conflict | settings 用 `conflict` reply 换最新快照 | 推广到 provider edit *[投影]* |
| unload/Agent 切换 | AbortSignal + exact Agent 围栏，迟到结果丢弃 | 保持 |

### 5.4 嵌套 overlay 原则

- 最多两层（主 surface + 共享 decision）。**禁止**二级功能弹窗——这是 `/model` options 弹窗和 provider `add-custom-model` 弹窗要拆的原因。
- 替代手法：行内编辑行（`+ model id: ___ [Add]`）、segment、numbered 直达、wizard 换页。

## 6. 编辑器与输入区（全状态）

### 6.1 布局

```
┌ transcript（上，被动滚动）───────────────────────────────┐
│ ...                                                     │
├ panes（queue/steer inbox，非空才显示）───────────────────┤
│ Queued: refactor the parser                             │
│ Steer:  use the streaming API                           │
╭ editor ─────────────────────────────────────────────────╮
│ > tell me about this repo▌                              │
╰──────────────────────────────────────────────────────────╯
 notification-or-slash-hint（muted 单行）                  ← 反馈/提示二合一
 MAIN⇄SUBAGENT · F7 switch · F8 close                      ← 仅 aux view 打开时
 plan · yolo                                               ← 仅非常态
```

编辑器坞是 overlay 的宿主：`presentation:'editor'` 的 picker 直接替换 `>` 行，关闭后恢复草稿。

### 6.2 状态 × 按键矩阵

| 状态 | Enter | Esc | Ctrl+C | Ctrl+S | ↑↓ | 可打印 | Tab |
| --- | --- | --- | --- | --- | --- | --- | --- |
| idle 空 | 无操作 | 无 | 双击退出(2s) | 无 | 历史 | 输入 | 焦点唯一→编辑器内部 |
| idle 有草稿 | 提交 | 清草稿 | 清草稿 | 无 | 历史 | 输入 | 同上 |
| 补全开 | 应用并提交(slash)/插入(@#) | 关补全 | 关补全+清 | — | 选候选 | 过滤 | 应用候选 |
| ghost hint 显示 | 提交 | 退到命令头 | — | — | — | 继续输入 | — |
| bash 模式 | 执行 shell | 空则退 bash | 清空 | — | shell 历史 | 输入 | 文件名补全 |
| running | —（入队） | interrupt/撤回 | interrupt | steer | — | 输入(入队) | — |
| 外部编辑器 | — | — | — | — | — | — | —（屏幕挂起） |
| overlay 捕获 | 见 §1.3 | 逐级退 | 直通 surface | — | surface | surface | moveGroup |

补充：`Alt+M` 轮换模型、`Shift+Tab` plan 循环、`Ctrl+G` 外部编辑器在任何编辑器态可用；图片粘贴走 Ctrl+V（剪贴板探测）。

### 6.3 补全（三类）

```
/ 补全（模糊，可分发）          @ 提及                 # 技能
│ > /mod▌                     │ > check @src/m▌      │ > #rev▌
│   /model   [name]  — desc   │  → src/mayfly/ dir   │  → #review  Review diff
│ → /mode    — Toggle plan    │    src/main.ts  file │    #release …
│   /effort  [level] — desc   └ Enter=插入不提交     └ Enter=插入不提交
└ Enter=应用并提交命令
```

- slash：Enter 直接分发命令；alias 匹配显示 `Match: /canonical` + `[Tab] apply`。
- @/#：Enter 只插入 token，不提交。
- bash 模式下 `/`/`#` 是 shell 语法，两类补全关闭（已有）。

### 6.4 bash 模式

```
╭ ! shell ─────────────────────────────────────────────────╮
│ ! ls -la▌                                                │
╰──────────────────────────────────────────────────────────╯
```

`!` 符号 + 独立 hue + 顶边 label；空缓冲 Backspace/Esc 退出。命令经 `shell-sanitize` 后执行。

### 6.5 提交管线

```
submit → submitTransformers（image marker 等，可回滚）
       → running? 入队（pane-queue 显示 Queued:/Steer:）
       → 记录 retractionCandidate（Esc 空草稿可撤回刚提交的消息）
       → followup
```

## 7. 命令与界面全量盘点

格式：**现状** → **差距** → **目标**（ASCII）→ **代价**。

### 7.1 会话族：`/quit /new /fork /rewind /sessions(/resume)`

- `/quit`（q/exit）、`/new`（clear）、`/fork`：无 UI，通知行反馈；`/fork` running 时报错。
- `/sessions <id>` 直传跳过 picker；`/resume` 是 alias 重写，非独立注册。

**/sessions**：filterable tree picker，`presentation:'editor'`，cwd 过滤、新→旧、标题分页懒加载、current 保持选中、Enter 非当前→`request-resume`、Enter 当前→提示 "Already the current session"、重开=replace。

```
╭ Sessions ───────────────────────────────────────────────╮
│ / ▌                                                      │
│ → * Fix the parser bug            today 10:41  ← current │
│   ▸ older session                                        │
│   ▾ parent session                                       │
│      └ fork child                                        │
│ Type filter · ↑↓ · Space fold · Enter resume · Esc       │
╰──────────────────────────────────────────────────────────╯
```

差距：无。建议：标题加载期间行内显示 muted `…` 占位（现在是渐显）。*[投影]*

**/rewind**：idle-only；从事件日志取 user-turn 边界，choose 列表，Enter→`request-rewind`，原会话仍在 /sessions。

```
╭ Rewind ───────── select a user turn to branch from ─────╮
│ / ▌                                                      │
│ → Turn 12 · "add retry logic"      today 10:41           │
│   Turn 9  · "fix the parser"       today 09:20           │
│ Enter branch · Esc close                                 │
╰──────────────────────────────────────────────────────────╯
```

差距：无 preview。建议：detail 列显示该 turn 后的消息数（"rewinds 4 messages"）。*[投影]*

### 7.2 `/help`

滚动 overlay（chrome:'overlay'），commands+keys 两节，scroll 控件 + `[Close]` dismiss action，Esc 关，locale 切换重投影。差距：无 `q` 快捷关闭。建议：给 close action 加 `key:'q'`（无 filterable，安全），与"读文档"心智一致。 *[投影]*

### 7.3 `/mode`

无 UI，等价 Shift+Tab plan 循环，通知行确认。保持。

### 7.4 `/model`（重点改造）

现状：filterable browse list（provider group + `current` badge + segment `Thinking:`），Enter→**二级 overlay** 重选 effort + [Set as default]/[Use for this session]/[Cancel]。

差距：effort 选两遍、多一层弹窗、segment 无提示。

目标：

```
╭ Select a model ─────────────────────────────────────────╮
│ / deep▌                                                  │
│ DeepSeek                                                 │
│ → deepseek-v4-pro  256k        thinking ‹ medium ›       │
│   deepseek-v4      128k                        current   │
│ my-corp                                                  │
│   gpt-5.2          400k                                  │
│                                        (4/12)            │
│ Type filter · ↑↓ · ←→ effort                             │
│ Enter set default · Alt+Enter session only · Esc         │
╰──────────────────────────────────────────────────────────╯
```

- **Enter=行内 effort + 写默认**（原 Set as default 路径）。
- **Alt+Enter=session-only**：需要 `inputs.selections[]` 带 `segmentId`（契约增量，现只有 selection-accept 事件带）；`session` action 声明 `key:'alt+enter'` + `selections:[models]`。
- 删二级 `modelOptions` overlay；`/provider switch <id>` 复用同一 picker（filterProvider 已有）。

代价：*[契约（segmentId 入 selections）+ 编译器（Alt+Enter 当 keyed accelerator）+ 投影（删弹窗）]*。已定 §12：Enter 直写默认，不保留 scope 对话框。

### 7.5 `/effort`（`/thinking` alias）

现状：复用 modelOptions 表单弹窗。目标：numbered choose（M1），≤9 级直达：

```
╭ Thinking effort — deepseek-v4-pro ──────────────────────╮
│ → 1. Provider default                                    │
│   2. off   3. low   4. medium   5. high                  │
│ 1-5 choose · Enter default · Alt+Enter session · Esc     │
╰──────────────────────────────────────────────────────────╯
```

代价：*[M1 + 投影]*。

### 7.6 `/provider`（list/edit/switch/add + onboarding + OAuth）

**列表**：行加 detail（`N models · key configured/no key set`），缺 key 用 warning tone；`Add provider` 留 actions 行（filterable 禁裸字母）。*[投影]*

**add**：改显式 wizard（`mode:'wizard'` 已有完成度追踪），修掉"先 Models 后 Credentials"的反序：

```
step1  numbered kind ──→ step2  Connection（name/protocol/   ──→ step3  Models
      1 known 2 custom              baseURL/key 合并一页）          进页自动 discover
      3 oauth                                               ┌ loader→失败给 retry+手加行 ┐
                                                            │ [x] model-a  128k          │
                                                            │ + model id: ___ [Add]      │
                                                            │ [ Save ] (disabledReason)  │
```

- Save `submit` Connection 表单 + `selections` Models；handler 内分开写 settings/credentials（存储边界不外露）。
- discover 失败≠阻塞：`minSelected:1` + 手加行兜底，disabledReason 提示。
- 成功→dismiss+feedback+自动开该 provider 的 /model picker（已有 onCreated）。

代价：*[投影为主；enterSubmits 契约用于 OAuth 子 prompt]*。

**edit**：同构三页 tabs（Models/Connection/Credentials）；`Add custom model` 弹窗→Models 页内联 `+ model id` 行；discovery 后台 probe 显示 loader 行（现静默失败）；`Delete`/`Clear key` 走共享 decision（已 confirm）；`!dirty` 时 Save 灰 + `No changes`。 *[投影]*

**OAuth**（authorization-ui）：notice scroll + URL/code + copy actions + loader + Start/Cancel：

```
╭ Sign in — anthropic ────────────────────────────────────╮
│ Open this URL in your browser:                           │
│ https://claude.ai/oauth/authorize?code_challenge…        │
│ Code: XKCD-1234                                          │
│ ⠋ Waiting for authorization…                             │
│ c copy URL · y copy code · Ctrl-E expand · Esc           │
╰──────────────────────────────────────────────────────────╯
```

裸字母 `c`/`y` 安全（无 filterable）；`Ctrl+E` 全屏展开长 URL（M6）。子 prompt（code/密码）用单字段 + enterSubmits。 *[M6 + enterSubmits + 投影]*

**onboarding**：单 secret 字段 + enterSubmits，Enter=Save，Esc=skip。 *[契约+投影]*

### 7.7 `/settings`

两级：namespace browse list → namespace 表单（Save/Refresh/Cancel + restart 提示 + revision 冲突回复 + 共享 dirty decision）；`settings.yaml` 外部编辑走屏幕挂起。现状良好。建议：namespace 行 detail 显示字段数/修改数。 *[投影]*

### 7.8 `/preset` / `/permission`

- `/preset`：browse list + Refresh/Close；`custom` 行 disabled 说明；Enter→native `agentPresets.select()`（turn 边界围栏已有）。建议：行 detail 显示组成摘要。 *[投影]*
- `/permission`：choose list；`danger-full-access` 预设 → 自绘 confirm overlay（带 sandbox 说明，Yes danger/No 默认）。该自绘合理（需说明文字），保持；dispatch 后通知行回执。

### 7.9 `/theme`

choose list + current；切换触发 renderer 重载（draft/history 经 stash 保留——已验证）。保持。

### 7.10 `/mcp`、`/tools`、`/skills`

- `/mcp`：server browse list（status 排序+tone）→ server detail（tabs Tools/Config，env/header 只显 key）→ tool detail。建议：server 行 detail 显示 `N tools · status`。 *[投影]*
- `/tools`：browse list → tool detail（schema/desc）。保持。
- `/skills`：browse list → detail（不加载 body）；`#` 补全共用目录。保持。

三者同构"list→detail"：统一 detail 页脚 `[ Close ]` + Esc。

### 7.11 `/plugin`（marketplace）

现状：tabs Installed/Not installed → 各组 filterable browse list + actions（Details + `i` install / `u` remove + `r` refresh + Close）→ detail overlay（scroll sections + Close）；install/remove 带进度汇报 + remove confirm。

差距：`i`/`u`/`r` 是**裸字母键绑在 filterable 列表上**——想过滤 "install" 输入 `i` 会先触发 install。

目标（已定 §12）：actions 行保留 Details/Install/Remove/Refresh/Close，**删 `i`/`u`/`r` 裸字母键**，靠 Tab 到 actions 行 + ←→ + Enter；搜索完全交给 type-to-filter。高频的 Refresh 可改绑非打印键 `Ctrl+R`。

```
╭ Plugins ────────────────────────────────────────────────╮
│ ‹ Installed (3) ›   Not installed (12)                   │
│ / ▌                                                      │
│ → mayfly-tools    v1.2.3 · installed                     │
│   web-search      v0.9.1                                 │
│                                                          │
│ [ Details ] [ Install ] [ Remove ] [ Refresh ] [ Close ] │
│ Type filter · ↑↓ · Tab actions · Esc                     │
╰──────────────────────────────────────────────────────────╯
```

代价：*[投影删 key 字段]*；配合 §3.3 的注册告警 *[编译器]*。

### 7.12 `/update`

preflight→confirm（Yes primary/No 默认）→progress overlay（步骤列表 ✓/…/✗/· + 滚动日志区）→结果文案+log 路径；`updateInFlight` 防并发；running 时 Close 禁用（`disabledReason:'The update is still running'`）且 dismiss 事件返回 `failed`——面板在 swap 落定前不可关，已正确。剩余差距：进度步骤行在窄宽下可能丢状态图标。 *[无需改动/width-scan 覆盖]*

### 7.13 `/trace`

filterable browse list（seq/type/surface badge）→ detail（fields + scroll code + Page 表单 + Previous/Go/Next + Copy trace item + Close）；`/trace copy <seq|all>` 直传剪贴板。

```
╭ Trace ──────────────────────────────────────────────────╮
│ / tool▌                                                  │
│ → #12 10:41:02  tool/call · Bash        main             │
│   #13 10:41:03  tool/result · Bash      main             │
│   #14 10:41:05  message/assistant       btw              │
│ Type filter · ↑↓ · Enter detail · Esc                    │
╰──────────────────────────────────────────────────────────╯
```

detail 页导航已经规范（number 字段 + Go + prev/next）。建议：`[c]` copy 快捷键（detail 无 filterable，安全）。 *[投影]*

### 7.14 `/jobs`

filterable browse list（●running/○exited + 时长）→ detail（fields + warning + Read output/Stop/Refresh/Close）→ output（scroll code + page form + Close）。`Read output` 显式消费 `read`（契约要求）；Stop 前重查 status。

```
╭ Jobs ───────────────────────────────────────────────────╮
│ / ▌                                                      │
│ → ● build   running · 2m14s                              │
│   ○ test    exited(0) · 45s                              │
│   ○ lint    failed(1) · 12s                              │
│ Type filter · ↑↓ · Enter detail · Esc                    │
╰──────────────────────────────────────────────────────────╯
```

差距：running 行不自动刷新。建议：列表页挂 5s 轮询 refresh（surface `load` 重取，跟随 revision 围栏）；或行 detail 注明 "snapshot · Refresh to update"。 *[投影]*

### 7.15 `/agents`

subagent tree browser（filterable；running badge + metrics 行：`3 tools · 12k tok · 1m04s`；diagnostic 行 disabled）→ Enter 打开该子 Agent 的 aux view；`q` stop 带 confirm。

差距：`q` 裸字母 vs filterable——同 §7.11，但此处列表 items 的 searchText 含 label/id/mode，`q` 被绑定时无法用它过滤。已定（§12）：删 `q` 键，`[ Stop selected ]` 留 actions 行由 Tab 到达，searchText 恢复完整可过滤。 *[投影]*

### 7.16 `/btw` + 辅助视图

`/btw <question>` 起侧问题 aux Agent；`agents` 树 Enter 也可 attach。状态行 `MAIN ⇄ SUBAGENT/BTW · F7 switch · F8 close`；冷/一次性子会话用共享只读 transcript panel（ScrollablePanel：Esc/arrows/PgUp/PgDn/Home/End，title+hint+footer）。

```
╭ BTW · how does auth work ──────── Esc close ────────────╮
│ （只读 transcript 行）                                   │
│ subagent · read-only                                     │
│ F7 toggle · F8 close · Esc close                         │
╰──────────────────────────────────────────────────────────╯
```

现状良好。建议：aux view 打开时主编辑器提示行显示 `⇄ BTW active · F7`（现只在 aux 侧显示）。 *[投影]*

### 7.17 计划/审批/问卷/授权（Agent 发起的 surface）

**plan review**（plan-review-panel + plan-document）：plan markdown 进内容流；决策控件在编辑坞——手写 `1./2./3.` numbered label + `c` copy / `o` other + `PgUp/PgDn · ⇧↑↓ scroll` 提示。

```
内容流：                     编辑坞：
│ Plan                      ╭ Plan review ────────────────╮
│ ## 1. ...                 │ 1. Approve                   │
│ ## 2. ...                 │ → 2. Reject                  │
│                           │ 3. Other — type feedback     │
│                           │ c copy · o other · PgDn plan │
│                           ╰──────────────────────────────╯
```

建议：迁移到 `numbered`（M1），数字键直发；feedback 子表单用 enterSubmits。 *[M1+契约+投影]*

**审批**（approval-plugin）：tabs `Decision`/`Reject with feedback`；actions [Reject][Allow once][Allow X for session][Reject with feedback]。

```
╭ Approval: Bash — rm -rf dist ───────────────────────────╮
│ ‹ Decision ›   Reject with feedback                      │
│                                                          │
│ → [ Reject ] [ Allow once ] [ Allow Bash for session ]   │
╰──────────────────────────────────────────────────────────╯
```

建议：numbered（1=Reject 安全默认聚焦在最左 danger 已有）。审批属高频，数字直达收益最大。 *[M1+投影]*

**问卷**（questionnaire/AskUserQuestion）：wizard tabs + choose list + `Other:` textarea + Back/Next + Submit/Cancel。现状规范；建议 Other 字段聚焦时 Enter 提交当前页（enterSubmits）。 *[契约]*

### 7.18 信息 overlay：`/status /context /version /changelog /export /copy /init`

- status/context：fields + progress + chart，refresh action；context 的 chart 在窄宽丢 label 保计数（renderProgress 已做）。
- export/copy：文件/剪贴板操作，通知行回执（含路径/字节数）。
- init：canned prompt 直发。
- 全部只读 surface `dismissal:'discard'`，页脚 `[ Close ]`+Esc。

### 7.19 状态栏 / pane / 通知

| 组件 | 现状 | 建议 |
| --- | --- | --- |
| pane-queue | 非空显 `Queued:`/`Steer:` 行 | 保持 |
| agent-view-status | `MAIN⇄AUX·F7·F8` | aux 打开时主侧也提示（§7.16） |
| mode-status | `plan`/`yolo` 非常态才显 | 保持 |
| 通知行 |  severity→tone，app/session scope，取最高 severity 最新 | 保持；操作类通知带 `operationId` 聚合（已有） |
| terminal-title | 镜像会话标题 | 保持 |

## 8. 窄终端与降级（事实+规范）

已有降级（编译器/渲染层内建）：list detail `width≤40` 隐藏；autocomplete description 同阈值；segment 溢出折叠 `+N`；tabs 只留 `‹ active ›`；progress 先丢 label 再丢计数；pane `narrow:'bottom'|'overlay'|'hidden'` 声明。

规范：新 surface **不得**假设宽度——detail 必须可丢、badge 必须可截、提示行按 §3.3 优先级裁剪。验收走 width-scan（`render(width)` 每行不溢出）。

## 9. 契约与编译器增量清单

| ID | 增量 | 服务场景 | 层 |
| --- | --- | --- | --- |
| M1 | `MayflyListNode.numbered: true` → 行渲染 `N.` 前缀 + `1-9` 键直达选择 | provider kind、effort、审批、plan | 契约+编译器+渲染 |
| M2 | `inputs.selections[]` 携带 `segmentId`；`Alt+Enter` 可作 `key` | /model session-scope | 契约+编译器 |
| M3 | select 聚焦行尾渲染 `‹ ›` 可循环提示 | provider edit/add、settings | 编译器渲染 |
| M4 | invoke 期间自动标发起 action busy（reply 落地解除） | discovery、Save、install、retry | 编译器 |
| M5 | `MayflyFormNode.enterSubmits?: actionId` → 单字段 Enter 直达提交 | onboarding、OAuth prompt、plan feedback、questionnaire Other | 契约+编译器 |
| M6 | `Ctrl+E` 把聚焦的长文本/URL/code 提全屏只读 viewer（Esc 返回） | OAuth URL、审批 reason、plan、trace | 编译器（最大件） |
| M7 | filterable surface 注册可打印快捷键时告警（开发态） | marketplace、agents | 编译器/keymap |

M1–M5 小；M6 需要一个全屏只读 presentation 变体（可复用 scroll 控件 + `chrome:'overlay'`）。

## 10. 迁移优先级

| 序 | 内容 | 理由 |
| --- | --- | --- |
| 1 | `/model`（M2+删二级弹窗+segment 提示 M3） | 每天用，改动最小 |
| 2 | `/provider edit` 内联加模型 + 列表 detail | 高频，投影层即可完成大半 |
| 3 | `/provider add` wizard 重排 + 自动 discovery + retry | 流程正确性 |
| 4 | M1 numbered → provider kind、effort、审批、plan | 一次编译器改动多处受益 |
| 5 | marketplace/agents 裸字母清理（M7） | 修输入冲突 |
| 6 | M4 busy 自动标记 | 统一异步观感 |
| 7 | OAuth/onboarding（M5+M6） | 低频但完成闭环 |
| 8 | jobs 轮询、sessions 占位、rewind 计数等打磨 | 收尾 |

## 11. 验收

文档改动：无需运行时验收（docs/** 属文档类）。

后续实现按根 AGENTS：`verify:changed -- --plan` → `verify:changed`；触碰编译器/契约（M1–M7）属 architecture 改动 → `verify:full` + width-scan 更新 + dedicated profile PTY 验收（给出主流程、窄宽、生命周期回归）。契约改动走 `packages/ui` 全门（replay/replacement/duplicate/cancellation/late/Fiber 清理测试）。

## 12. 决策记录

已定：

1. **`/model` Enter 直写默认值**：Enter=写默认、Alt+Enter=session-only，删二级 scope 弹窗。理由：默认值与 `current` badge 均在行内可见，误写代价低（重选即改回），省一层弹窗收益更大。
2. **filterable surface 禁可打印快捷键**：marketplace `i`/`u`/`r`、agents `q` 的 `key` 字段删除，动作留 actions 行由 Tab 到达；高频动作可绑非打印键（如 Refresh 用 `Ctrl+R`）。M7 注册期告警固化此规则，替代方案（显式 `/` 进搜索才让字母归输入）因双层规则难教而否决。

待定：

3. **`Ctrl+E` 展开的范围**：建议先做"长只读内容"（URL/code/reason），不进编辑态文本字段（编辑器已有 Ctrl+G 外部编辑器覆盖该需求）。
