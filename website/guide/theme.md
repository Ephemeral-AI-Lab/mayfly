# 主题

Mayfly 的视觉表面全部由一张**语义色表**驱动。`/theme` 命令在这张表的不同提供方之间热切换——切换会重建渲染树，但输入草稿、历史与输入模式经 draft stash 存活。

## /theme 用法

```
usage: /theme [<theme>|auto|custom <path> [<base theme>]]
```

- `/theme` —— 列出全部内置调色板，按**适合深色终端**与**适合浅色终端**分组，每项显示名称与一句说明，当前项打勾（`✓`）
- `/theme <键>` —— 切到某个内置调色板，例如 `/theme tide`
- `/theme auto` —— 跟随终端背景色（OSC 11 探测）在 Mayfly Dark 与 Mayfly Light 间选择
- `/theme custom <path> [<基础主题>]` —— 挂载文件调色板，叠在任一内置调色板之上（默认 `dark`）

切换实现为 provider fiber 的整体替换：依赖主题的插件（transcript、输入层等）随之重载。挂载失败时会自动回退到 Mayfly Dark，界面永远不会没有主题。

## 内置调色板

每个调色板遵循同一套配方：一种安静色相的四级中性墨色，`primary` 及其周边 token 共用一个品牌色相，状态色（绿、琥珀、红）与品牌色相保持距离。每个调色板都为一种终端背景（画布）设计；主题不绘制背景，把终端背景设为对应画布即可得到设计效果。

Mayfly 自有的调色板（每个分组的前几行）：

| 键 | 名称 | 风格 | 画布 |
| --- | --- | --- | --- |
| `dark` | Mayfly Dark | 默认紫色：近黑底上的石板灰墨 | `#0A0A0C` |
| `light` | Mayfly Light | 白底上的默认配色 | `#FFFFFF` |
| `tide` | Tide | 深水色，水绿主色 | `#08191D` |
| `dusk` | Dusk | 暖梅色，兰紫主色 | `#1B1118` |
| `graphite` | Graphite | 中性灰，钴蓝主色 | `#141414` |
| `linen` | Linen | 纸上墨色：米白底上的暖灰，墨蓝主色 | `#F8F3E9` |
| `mist` | Mist | 淡蓝白底上的青色 | `#F3F8FA` |
| `heather` | Heather | 丁香灰，梅紫主色 | `#F8F4F9` |
| `obsidian` | Obsidian | 黑底高对比度：每种色调对比度不低于 7:1 | `#000000` |
| `porcelain` | Porcelain | 白底高对比度：每种色调对比度不低于 7:1 | `#FFFFFF` |

`auto` 不是独立调色板，而是按终端背景在 Mayfly Dark 与 Mayfly Light 间二选一；`custom` 见下文。

### 现成配色的移植

22 个移植调色板只使用原配色方案自身的颜色，分配到 Mayfly 的各个角色。在原背景上对比度低于 4.5:1 的色调只调整明度、保持色相；Gruvbox 的橙色与其警告黄过近，因此主色改用它的蓝色。来源与许可证见包内的 `THIRD-PARTY-NOTICES.md`。

| 系列 | 适合深色终端 | 适合浅色终端 |
| --- | --- | --- |
| Catppuccin | `catppuccin-mocha`、`catppuccin-macchiato`、`catppuccin-frappe` | `catppuccin-latte` |
| Rosé Pine | `rose-pine`、`rose-pine-moon` | `rose-pine-dawn` |
| Dracula | `dracula` | |
| Nord | `nord` | |
| Tokyo Night | `tokyo-night`、`tokyo-night-storm` | `tokyo-night-day` |
| Solarized | `solarized-dark` | `solarized-light` |
| Gruvbox | `gruvbox-dark` | `gruvbox-light` |
| One | `one-dark` | `one-light` |
| Kanagawa | `kanagawa-wave` | `kanagawa-lotus` |
| Everforest | `everforest-dark` | `everforest-light` |


## 持久默认主题

`/theme` 切换的是**会话级**主题；持久默认写在 settings.yaml 的 `mayfly:` 段（或用 `/settings` 面板的 Theme 行按名称选择，名称后标注深色或浅色——实时生效、同时落盘）：

```yaml
mayfly:
  theme: tide   # 上文任一调色板的键，或 auto
```

启动时应用该默认；会话内的 `/theme` 选择覆盖它，且无关的设置写入不会把会话选择冲掉。若保存的值不再对应任何调色板（旧版本的 `ocean` 或 `paper`），启动时使用 Mayfly Dark，其余设置不受影响。custom 调色板（`/theme custom <path>`）保持会话级，不落盘。

## custom：JSON 调色板

custom 主题从 JSON 文件读取 token 到 `#rrggbb` 十六进制色的映射，叠在 `base`（任一内置调色板的键）之上：

```json
{
  "primary": "#9A86E6",
  "accent": "#C9C0F0",
  "roleUser": "#9A86E6",
  "selectedBg": "#2b2b30"
}
```

规则：

- 只需写想覆盖的 token，其余落到 base 的对应项；
- **未知 token**（不在下表中，亦非下方的 `logoInks`）与**非法颜色**（非 `#rrggbb` 格式）会被丢弃并打印警告，回退 base 对应项；
- `logoInks` 是唯一接受数组的 token——恰好五个 `#rrggbb`，依次染横幅标志的身体、翅膀，以及飞入轨迹由近到远的三档淡出色；
- `selectedBg`、`diffAddedBg`、`diffRemovedBg` 染背景色，其余颜色 token 均染前景色；
- 文件不可读或不是 JSON 对象时，整表回退 base。

## 语义 token 表

以 Mayfly Dark 的值为参照（每个调色板各有对应值；auto 按 OSC 11 探测结果在 Mayfly Dark 与 Mayfly Light 间二选一）：

### 基础

| token | dark 值 | 用途 |
| --- | --- | --- |
| `text` | `#EDEDF2` | 正文、状态栏最亮档（model、context） |
| `textStrong` | `#F5F5F7` | 强调文本 |
| `muted` | `#9AA3B8` | 次要文本、状态栏中档（cwd、git 徽章） |
| `textMuted` | `#5C6476` | 最暗档（工具摘要行、tips、代码块边框） |
| `accent` | `#C9C0F0` | 点缀色（指针、次强调） |
| `primary` | `#9A86E6` | 主色（斜杠语境编辑框、运行态工具圆点、链接） |
| `border` | `#45406B` | 常规边框 |
| `success` | `#4ec87e` | 成功态 |
| `error` | `#e85454` | 错误态 |
| `warning` | `#e8a838` | 警告态 |
| `selectedBg` | `#2b2b30` | 列表选中行背景 |
| `roleUser` | `#9A86E6` | 用户消息 `»` 边栏 |
| `shellMode` | `#C9C0F0` | `!` bash 模式（编辑框、`$ ` 前缀） |
| `modelHighlight` | `#E9E6F4` | 横幅模型行高亮 |
| `logoInks` | `#9A86E6` … | 横幅标志：身体、翅膀、三档轨迹色 |

### Markdown 渲染

| token | dark 值 | 用途 |
| --- | --- | --- |
| `mdHeading` | `#F5F5F7` | 标题 |
| `mdLink` | `#B9A9F0` | 链接文字 |
| `mdLinkUrl` | `#5C6476` | 链接 URL |
| `mdCode` | `#C9C0F0` | 行内代码 |
| `mdCodeBlock` | `#EDEDF2` | 代码块正文 |
| `mdCodeBlockBorder` | `#45406B` | 代码块边框 |
| `mdQuote` | `#9AA3B8` | 引用文字 |
| `mdQuoteBorder` | `#5C6476` | 引用竖线 |
| `mdHr` | `#45406B` | 水平分割线 |
| `mdListBullet` | `#C9C0F0` | 列表符号 |

### diff 着色

| token | dark 值 | 用途 |
| --- | --- | --- |
| `diffAdded` | `#4ec87e` | 新增行的 `+` 号 |
| `diffRemoved` | `#e85454` | 删除行的 `-` 号 |
| `diffAddedBg` | `#1E3A2B` | 新增行背景色带 |
| `diffRemovedBg` | `#43232A` | 删除行背景色带 |
| `diffMeta` | `#9AA3B8` | diff 文件头元信息 |
