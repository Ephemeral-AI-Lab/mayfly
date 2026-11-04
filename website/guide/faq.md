# 常见问题

## 为什么不直接 `npm install @ephemeral-ai/mayfly`？

共享包只包含 renderer 与只读展示 subpath。当前产品由原生 dsh profile 中的
`mayfly-host` 和独立 `mayfly-remote` TUI 组成；统一 `mayfly-cli` 精确依赖 Host、Remote 与官方 Harness，
通过 `mayfly server` 管理后台 Host，直接 `mayfly` 自动启动并连接本机实例。安装见[分体快速上手](/guide/)。已发布的 `v0.1.4-rc.2`
是不可改写的 UI 参照；当前开发面向 Harness `0.2.2-alpha.3`，使用经验证的匹配构建产物。

## 安装解析到了旧版本？

pnpm 的 `minimumReleaseAge` 可能推迟新版本可用时间。使用经验证的精确发布集并
保留仓库配置中的 exclusions，不要把无版本的共享 renderer 包当成 Host 安装。
开发安装器构建本工作区，并检查所选 dsh 版本。

## 如何升级 Mayfly？

`/update` 做只读检查；`/update <version>` 准备并检查前端精确发布依赖图，经确认后
升级两端、验证版本，并在失败时补偿恢复。`/update recover` 在原 Host 恢复中断事务。
跨进程锁与恢复标记防止并发 writer。链接、只读或非 npm 前端安装使用原安装方式。

升级后重启两个进程并检查 Host 启动。官方 Host API 没有独立启动检查；前端模块
导入成功不能证明 Host 已成功启动。开发 worktree 在依赖变化后重新构建并安装专用 profile。

## 为什么 `/stats` 历史不可用？

历史即使只查看当前工作区，也可能暴露其他 Session，因此需要 Host 全局授权。
只有所选 Session 的权限时，只允许读取它自身的统计。被拒绝的历史请求明确说明边界，
并且不会开始扫描。

## 粘贴图片没有反应？

Ctrl-V 粘贴依赖两个条件：

1. **终端环境**：按平台探测各自的剪贴板通道——Linux 依次探测 `wl-paste`、`xclip`（3 秒超时），Windows 单次 PowerShell 调用（10 秒），macOS 走 osascript（5 秒）；
2. **模型能力**：粘贴的图片以图片内容块进入消息。如果当前模型路由不支持图片输入，包含图片块的消息会被拒绝——这是上游 harness 的能力协商行为，换用具备视觉输入的模型即可。

TUI 接纳本地图片数据并通过原生 Host 附件 API 暂存；Session 写入保留图片与文件 receipt
的原始顺序，本地图片存储路径不是 Host 文件系统能力。

既可以复制应用中的图片内容，也可以在文件管理器（Ubuntu 文件、Windows 资源管理器、macOS Finder）中复制一个或多个本地 PNG/JPEG/WebP/GIF 文件——三平台都按原顺序整批粘贴。文件管理器路径只接受本地普通文件；远程 URI、目录、符号链接和特殊文件会显示拒绝原因。

## 为什么 AGENTS.md 等注入的上下文不显示在会话流里？

harness 会把工作区指令（AGENTS.md 等）、运行时上下文快照等以合成 user 消息注入会话。Mayfly 按消息来源分拣：人类输入照常呈现为 `»` 消息块；**合成消息零呈现**（不产条目、不留占位行）——对齐"模型侧内容模型侧消化"的呈现哲学，保持会话流干净。这些内容仍然完整发送给模型，只是不渲染。

## 能自定义键位吗？

暂缓。键位经 `mayflyKeymap` 注册、重复绑定会被拒绝，但面向用户的自定义配置属于后续阶段（alt-screen 全屏表面同理）。当前全部键位见[键位参考](/reference/keys)。

## `/quit` 如何退出？

`/quit` 是前端本地命令，尚无 Session 时也可用；它解除连接并退出 TUI，Host 工作继续运行。
两次 Ctrl-C 的退出方式遵循编辑器显示的提示。

## 状态栏的 git 分支什么时候刷新？

git 徽章经 TTL 缓存惰性探测（branch 5 秒、status 15 秒），在任意一次重绘时顺手刷新（输入、流式输出都会触发）——同一目录下切换分支，几秒内就会反映。缓存按工作目录建立：会话切换（`/new`、`/resume` 或重启）带到新的 cwd 时会为它重建缓存。

## 状态栏条目放不下会怎样？

状态栏是单行（条目没有自己的行：唯一的第二行是已进入视图的条目下方那条粗线 `━`）。行拥挤时先按固定顺序收起细节（条目的计时、provider、thinking 级别、git、目录层级、cache 条、context 条，最后是 model）。之后整行不分 band、按 `priority`（再按 id）顺序容纳条目：放得下的条目保留完整宽度，超宽条目截断到剩余预算（声明 `overflow: hide` 的条目宁缺不截、整项隐藏），行满后靠后的条目不再显示。已容纳的条目再按声明的 left/center/right band 布局。会话名不再占用 footer——它显示在编辑器上边框的右端。

## bash 模式的输出会进入会话历史吗？

不会。`!` bash 模式的命令经 Mayfly 自己的执行器运行，输出以 shell 回显卡呈现进滚动区，**刻意不进 session transcript**——模型看不到这些输出。需要模型知晓的结果请贴回输入框或让模型自己跑工具。
