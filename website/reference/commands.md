# 斜杠命令参考

输入 `/` 触发模糊补全与发现提示（见[输入编辑器](/features/editor)）；`/help` 浮层实时列出已注册命令——若与本文有出入，以 `/help` 为准。

## 内置命令

| 命令 | 别名 | 参数 | 描述 | 来源 |
| --- | --- | --- | --- | --- |
| `/quit` | `/q` `/exit` | — | 退出 Mayfly | `mayfly-commands` |
| `/new` | `/clear` | `[preset]` | 回到启动画面；下一条消息才创建新会话（可选指定 agent 预设） | `mayfly-commands` |
| `/fork` | — | — | 把当前会话 fork 成新会话 | `mayfly-commands` |
| `/rewind` | — | — | 从当前会话较早的用户回合创建安全分支 | `mayfly-commands` |
| `/sessions` | `/resume` | `[<session-id>]` | 按工作区（cwd）浏览会话，再打开对话；带 id 直接恢复 | `mayfly-commands` |
| `/rename` | — | `[<name>]` | 重命名当前会话（不带名称打开编辑框） | `mayfly-commands` |
| `/btw` | — | `<question>` | 创建临时旁路 Agent，并把整套 UI 切到该会话；空参数关闭 | `mayfly-btw-command` |
| `/agents` | — | `[stop <id>]` | 浏览 subagent 树、查看 child，或停止 continuable child | `mayfly-agents-command` |
| `/jobs` | — | — | 浏览当前 Agent 的后台任务（列表 + 详情 + Read 输出） | `mayfly-jobs` |
| `/help` | — | — | 显示可用命令与键位 | `mayfly-commands` |
| `/mode` | — | — | 切换计划模式（等价于 `Shift+Tab`；无会话时设置下一个会话） | `mayfly-commands` |
| `/plan` | — | 无会话时 `[off]` | 原生计划命令；无会话时 `/plan` 与 `/plan off` 设置待定计划模式（带消息需先有会话） | `dsh-plan-mode`（原生） |
| `/model` | — | `[id]` | 切换会话模型；无参数打开选择面板 | `mayfly-commands`（model-commands） |
| `/effort` | `/thinking` | `[level]` | 切换当前模型的思考力度；无参数打开横向选择器 | `mayfly-commands`（model-commands） |
| `/provider` | — | `[list \| switch <name> \| add]` | 列出 provider、切换路由或新增 | `mayfly-commands`（model-commands） |
| `/preset` | — | `[name]` | 列出 agent 预设、切换空会话，或在启动前设置新会话默认值 | `mayfly-commands`（preset-commands） |
| `/permission` | — | `[name]` | 原生权限命令：列出或切换沙箱/审批预设 | `dsh-permission-presets`（原生） |
| `/permissions` | — | — | 打开 Mayfly 的权限预设面板（作用于当前 Agent） | `mayfly-commands`（`permission-panel`） |
| `/tools` | — | — | 列出当前会话可见的工具 | `mayfly-commands`（tools-commands） |
| `/mcp` | — | — | 浏览宿主连接的 MCP 服务器与其工具 | `mayfly-commands`（mcp-commands，S34） |
| `/skills` | — | — | 列出可用技能（`#` 前缀调用） | `mayfly-commands`（skills-command） |
| `/theme` | — | 见[主题](/guide/theme) | 列出或切换主题 | `mayfly-commands`（theme-switch） |
| `/init` | — | — | 分析代码库并在项目根写 `AGENTS.md` | `mayfly-commands`（session-init） |
| `/stats` | — | — | 显示当前会话、会话历史（活跃热力图、连续天数）以及各模型的用量和费用 | `mayfly-commands`（stats-command） |
| `/context` | — | — | 显示 token 用量与上下文窗口 | `mayfly-commands`（session-commands） |
| `/version` | — | — | 显示 Mayfly 与 harness 版本及实时模型 | `mayfly-commands`（session-commands） |
| `/changelog` | — | — | 显示发版 changelog（what's new，逐版本分节，当前版本带 `· current` 徽章） | `mayfly-commands`（session-commands） |
| `/trace` | — | `[copy <seq> \| copy all]` | 查看当前会话执行轨迹；可复制单项或完整轨迹 | `mayfly-commands`（trace-command） |
| `/update` | — | `[version]` | 安全升级 Mayfly（预检/快照/装机冒烟/失败自动回滚；不带参数即只读检查） | `mayfly-commands`（update-command，D52） |
| `/settings` | — | — | 按命名空间编辑用户设置（两级面板，改动即落盘；详见[配置](/guide/config)） | `mayfly-commands`（settings-command） |
| `/plugin` | — | `[install <id> [--source npm\|github] \| uninstall <id> \| info <id> \| list \| refresh]` | 浏览/安装/移除插件市场条目（官方、dsh、社区三档来源；缓存优先，离线展示缓存目录；详见[插件市场仓库](https://github.com/Ephemeral-AI-Lab/dsh-plugins)） | `mayfly-commands`（plugin-commands） |
| `/save` | — | `[full] [<path>]` | 把当前会话保存为 Markdown 文件（默认投影对话，`full` 保存完整事件流） | `mayfly-commands`（session-export） |
| `/copy` | — | — | 复制最近一条助手消息到剪贴板 | `mayfly-commands`（session-export） |

## 会话与模型

- **`/sessions` / `/resume <session-id>`** —— `/resume` 是 `/sessions` 的别名：带 id 直接恢复，不带参数按**原生工作区**（Workspace registry）列出。当前显示会话所在工作区排在最前，每行显示会话数量。输入路径进行筛选，按 **Enter** 浏览该工作区。

  工作区面板读取原生 Session Controller 目录：会话名称、状态徽章（`current`、`running`、`archived`、`Reminders`、`migration required`）、摘要自带的标题/模型/用量提示，以及该工作区内的父子会话树。输入名称或 ID 进行筛选，按 **Enter** 打开详情及打开/归档/恢复操作。`migration-required` 会话显示缓存值与提示，Mayfly 不会自行开始迁移。结束编辑或筛选后，使用 **工作区** 按钮或 **Escape** 返回；读取失败则提示刷新重试。

  工作区内的 **Search contents** 搜索该目录的对话；目录列表中的 **搜索所有内容** 跨工作区搜索。内容搜索需要 Harness 的原生搜索能力。

  ![按工作目录分组的会话](/shots/app-sessions.svg)

  ![工作区内的对话](/shots/app-session-workspace.svg)

- **`/rename [<name>]`** —— 重命名当前会话：带名称直接改名，不带参数打开一个预填当前名称的单字段编辑框。用户命名的标题会被锁定，自动命名不再覆盖；名称显示在编辑器上边框与 `/sessions` 中。
- **`/fork`** —— agent 非 idle（正在运行）时返回 `cannot fork while the agent is running`。
- **`/rewind`** —— 单层列出当前会话的直接用户回合；选择一个回合会从该完整回合之前创建普通子 session。父会话不截断、不删除，仍可从 `/sessions` 恢复；agent 运行时拒绝。
- **`/btw` / `/agents`** —— 在主会话旁打开旁支会话，可同时保留多个，新的 BTW 会替换旧的 BTW。所有会话都在 transcript 面板中渲染：live BTW/continuable child 驱动完整布局和编辑器，one-shot 或 cold child 从原生历史读取并标注 `只读` 或 `回复以恢复`；状态栏显式显示 `F7 switch · F8 close`。`/agents stop <id>` 只接受没有 live 后代的 live continuable child，浏览器里的停止需在 Yes / No 确认中选择 Yes；cold/inactive child 不会被误报为已停止，父节点需先从叶子向上停止，避免 Harness 的递归 teardown 扩大操作范围。
- **`/model` / `/effort`** —— 无参数分别打开模型选择面板与横向力度选择器；面板用不循环的 `←` `→` 移动 provider/effort tabs、`Enter` 下钻、内容态 `Tab` 切到 action。`Enter` 提交 **`Set as default`**：切换并持久化为新默认。带参数直接切换并持久化。免开面板的快路：**`Alt+M`** 在当前 provider 的模型列表里逐个切换（草稿保留；见[键位参考](/reference/keys)）。
- **`/provider`** —— 三条子命令：`list` 列出可用 provider 与当前路由；`switch <name>` 切换；`add` 进入新增 provider 流程。
- **`/preset`** —— 在薄宿主预设名册（上游 `standard` / `minimal` / `ptc` / `cordis`，以及 Mayfly `mayfly-cordis`）上切换 agent 组合：工具面、人格与 plan 模式都来自当前预设。没有 `code` alias。**空会话**上切换当前会话；尚无会话时，选择会写入第一个及后续新会话采用的默认值，面板提示 `Default preset: <name>`。已开始的会话返回 `cannot switch presets: this session has already started`。提醒工具（`schedule_*`）由预设决定：`standard`、`ptc`、`cordis` 与 `mayfly-cordis` 挂载 `tool-schedule`，`minimal` 不挂载。Host 级 `schedule` 服务在内置组合中默认禁用，需在 profile 文件中启用该行后才能使用提醒。

## 模式与审批

- **`Shift+Tab` 计划切换** —— normal ↔ plan，只执行 `/plan` 或 `/plan off`。尚无会话时，`Shift+Tab`、`/mode`、`/plan` 与 `/plan off` 设置以 `plan…` 显示的待定模式；首条消息创建的会话会先进入 plan mode 再运行该消息。YOLO 使用 `/permission danger-full-access` 进入、`/permission workspace-write` 退出，可与 plan 叠加（见[会话模式](/features/modes)）。Mayfly 不注册 `/yolo` 或 `/yes`。
- **`/permission`** —— 原生命令，列出/切换权限预设（sandbox 模式 + 审批策略的命名束），保留自己的名称与参数形式。Mayfly 的 `/permissions` 为当前 Agent 打开与 `/preset` 同款的单选列表面板；danger 预设打开 Yes / No 确认，默认选中 No。
- **`/mcp`** —— 三层面板浏览宿主连接的 MCP 服务器：服务器选择器 → 服务器面板（config 伪行 + 工具行）→ 详情（config 状态/脱敏连接/策略，或工具 schema）。只读——增删服务器走 profile patch（见 [dsh/mcp](/dsh/mcp)）；空态有指路。
- **`/init`** —— 让 agent 分析代码库并把结论写入项目根的 `AGENTS.md`：已存在则先读取、延续仍然准确的内容，重写为一个连贯的最新文件（而非追加），使用项目自身文档的主要语言。

## 信息与保存

- **`/save [full] [<path>]`** —— 当前会话保存为 Markdown：默认保存投影后的对话，`full` 保存完整事件流；不带路径时写入默认文件名 `mayfly-export-{id8}-{YYYYMMDD-HHMMSS}.md`。
- **`/copy`** —— 最近一条助手消息的文本进剪贴板：优先 OSC 52 转义序列（经 stdout 到达本地终端模拟器，**SSH 远程会话也能复制到本地剪贴板**），失败再走回退管线。
- **`/trace`** —— 通过 harness 官方会话查询读取当前执行时间线；↑/↓ 选择条目，Enter 打开完整 JSON，PageUp/PageDown 滚动详情，`c` 复制单项，`a` 复制完整轨迹。
- **`/theme`** —— 完整用法 `usage: /theme [<theme>|auto|custom <path> [<base theme>]]`，详见[主题](/guide/theme)。
- **`/quit`** —— agent attach 前输入显示 `no active session`（见 [FAQ](/guide/faq)）。

命令不进入模型轮——成功/错误文本在编辑器 hint 行闪现。下游插件经 `ctx.commands` 注册的命令会自动出现在补全菜单与 `/help` 里；别名不在 `ctx.commands` 注册，由输入层在分发前重写为规范名（kimi `aliases` 移植）。`/permission` 是 `dsh-permission-presets` 注册的原生命令；Mayfly 另注册 `/permissions` 作为面板入口，两者不会互相遮蔽。

## 暂缓的命令

以下命令在参照系产品（kimi/Claude Code）中存在，Mayfly 侧**有意暂缓**——或等上游开出原语，或等真实需求出现（完整裁定见仓库 roadmap 挂起区）：

- `/reload` `/tasks` —— 顺延（任务管理走 profile/config 文件）
- `/archive` `/delete` —— 上游 persistence 暂无删除/归档原语
- `/import` —— 会话格式版本严格性未定
- `/diff`（未提交变更面板）、审批 diff 全屏预览 —— 发版后随 dogfood 反馈同评
- `/debug` —— 需上游诊断导出面

安装 Agent Team 插件并选择 `team` preset 后，`/team` 查看只读成员表与任务板；`/schedule` 查看当前 Agent 的原生会话提醒（逾期优先排序、只读；Host `schedule` 服务需在 profile 文件中启用，提醒工具由预设的 `tool-schedule` 行提供）；`/files` 查看已交付文件。cold continuable child 历史支持 `i` 回复，发送才通过原生子会话地址恢复 Agent；浏览不激活。见 [Team 配置](/features/team)。
