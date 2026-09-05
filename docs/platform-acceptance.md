# 平台验收

PR 的 `native platform regressions` 在 Linux、Windows、macOS 的 Node 24
上验证启动器、缓存修复、宿主命令选择和剪贴板子进程。Windows 专项测试
使用路径含空格和中文的 `npm.cmd`、`pnpm.cmd`，不依赖 Git Bash。

发布候选保留三平台 Node 22/24 安装矩阵；Node 24 额外校验完整 profile
组合，并用 `script/smoke-platform-pty.mjs` 运行原生 PTY/ConPTY。流程覆盖：

- 启动、Unicode bracketed paste、退格、40/100 列缩放。
- 文件补全、provider 表单编辑和取消。
- 应用内安装及卸载本地 tarball marketplace fixture，不依赖第三方插件发布。
- 正常退出和 bracketed-paste 终端模式恢复。

每个平台上传 `terminal.log`、`result.json` 和启动校准日志作为发布 artifact。
Windows 子进程 PATH 排除 Git Bash 的可执行目录。驱动启动 JavaScript 入口
使用当前 Node，不把 `.js` 或 `.cmd` 当作 POSIX 可执行文件。

默认驱动已安装的全局候选 launcher：

```sh
node script/smoke-platform-pty.mjs
```

本地源码验收可以指定已安装的独立 profile。`DSH_HOME` 必须显式给定，
profile 必须使用 `mayfly-<tag>`；不得指定生产 profile。例如：

```sh
DSH_HOME=/tmp/mayfly-acceptance \
MAYFLY_SMOKE_PROFILE=mayfly-audit \
MAYFLY_SMOKE_DSH_JS=/absolute/path/to/dsh/lib/bin.js \
node script/smoke-platform-pty.mjs
```

## 桌面人工验收

原生 PTY 日志不能证明图形终端的输入法、系统剪贴板或桌面协议可用。
发布前在以下实际环境执行同一清单并记录版本及结果：

| 环境 | 必测场景 |
| --- | --- |
| Linux Wayland 和 X11 | 中文输入法、文字和图片剪贴板、缺失 helper、复制失败时 OSC52 反馈 |
| Windows Terminal / ConPTY | 无 Git Bash，中文输入法、UTF-8 粘贴、盘符与 UNC 补全、npmrc 镜像、应用内插件操作 |
| macOS Terminal 或 iTerm2 | 中文输入法、pbcopy、Finder 图片/文件粘贴、窗口缩放和退出后终端恢复 |

各平台都检查表单编辑中的 Delete、窄屏长标签值、取消后原输入恢复，以及
热重载/退出后没有遗留子进程。SSH/tmux、图片显示协议和自动主题作为扩展
矩阵单独记录；自动化通过不得替代这些桌面结果。

## 缓存锁边界

缓存发布使用 120 秒 stale、5 秒 heartbeat 的目录 lease，获取重试有界于
约 12 秒。争用错误提示稍后重试；崩溃遗留锁过期后自动恢复，无需删除整个
缓存。锁内只执行有界验证和 rename，递归删除在释放锁后进行。该 lease
不保证进程暂停或同步文件系统阻塞超过 stale 时的强排他性。原生文件检查
验证存在性和大小，不是逐文件内容哈希或完整依赖树校验。
