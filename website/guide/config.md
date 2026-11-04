# 配置：模型、Provider 与主题

当前分体实现使用 Harness `0.2.2-rc.1`。原生配置、凭据、模型默认值、权限与
Session 属于 Host；主题应用、剪贴板、导出和外部编辑器进程属于 Remote TUI 所在机器。

| 配置 | 界面入口 | 所有者 |
| --- | --- | --- |
| Provider 与凭据 | `/provider`、`/provider add` | Host 原生 provider/credentials controller |
| 模型与思考力度 | `/model`、`/effort`、`Alt+M` | Host 原生模型目录、默认值与 Session Controller |
| Agent preset | `/preset` | Host 原生 preset registry |
| 沙箱与审批 | `/permissions`、原生 `/permission` | Host 原生 permission service |
| 界面语言与持久主题默认值 | `/settings` | Host settings；TUI 本地应用展示 |
| 当前主题 | `/theme`、`/theme custom <path> [<base theme>]` | TUI；custom 文件从本地读取 |
| Host bundle | `/plugin` | Host 原生 plugin manager |

## 模型与 Provider

在 Host 进程配置 `DEEPSEEK_API_KEY`，或通过 `/provider` 的原生凭据流程配置其他
provider。密钥不会进入投影或返回的 settings 表单；留空的 secret 不是读取到的旧值。

`/model` 与 `/effort` 无参数时打开选择面板，带参数时请求对应原生写入。
Sessionless 选择更新 Host 默认值，由首个 Session 采用。Session 的 `modelSelection`
projection 由原生 `@deepseek-ai/dsh-agent` 持有，写入通过 Session Controller。
`Alt+M` 在当前 provider 内循环切换模型并保留草稿。

Provider 向导、可配置目录、模型元数据和验证由 Host 的公开原生 API 提供。
配置格式与 Host 持久化目录以[Harness reference](https://deepseek-harness.github.io/deepseek-harness/reference/)
及当前 Host 为准，不把旧 `settings.yaml` 或旧 Mayfly patch 当成 alpha.2 的配置契约。

## Settings 表单与原始文档

`/settings` 先按命名空间列出可编辑值，再进入字段表单。表单保留 descriptor/field
revision，保存走原生 settings 写入；冲突需要用户刷新并检查，不会静默重试。
readonly 或缺少服务时，界面说明原因并拒绝写入。

整份文档编辑器读取 Host 的实际 settings 文档，通过 TUI 所在机器的 `$VISUAL`、
`$EDITOR` 或配置的 editor command 打开本地临时副本，再把修改传回 Host。编辑器
不会直接打开 Host 文件系统路径。取消、启动失败或冲突时保留应有的草稿和错误反馈。

原始保存会取得原生 profile 共享锁，在锁内比较 SHA-256 revision、原子替换文件，
并读取返回值。它协调多个 Host writer 与原生配置写入，但只有部分冲突保护：
不遵守锁的外部编辑器仍可在最后一次 revision 检查后写入，因此不保证完整 CAS。

## 语言与主题

`/language` 或 `/settings` 选择英文、简体中文及系统默认。主题持久默认值通过
`/settings` 保存；`/theme` 只改变当前展示。Core/theme reload 保留前端表单、选择、
编辑器 caret、撤销、历史、粘贴与补全状态。自定义 palette 文件保留在 TUI 机器，
不会成为 Host 配置或凭据。详见[主题](/guide/theme)。

## 启动界面与模式

不带任务或恢复 id 时，启动不创建 Session。`/model`、`/effort`、`/preset` 设置 Host
默认值；`/plan`、`/plan off`、`/mode` 与 `Shift+Tab` 设置待定计划模式。
第一条普通 prompt 创建 Session 后，先完成计划模式接纳再发送 prompt；接纳失败不发送。
尚无 Session 时 `/plan <message>` 会拒绝并提示先发送普通消息。

计划状态与权限独立：`Shift+Tab` 只切换计划模式。YOLO 表示当前实际的
`danger-full-access` 沙箱和 `never` 审批策略，可与 plan 同时生效。它依据原生当前
权限事实，包含 custom 或已撤回 preset 的情况，而不是从 preset 名字猜测。
