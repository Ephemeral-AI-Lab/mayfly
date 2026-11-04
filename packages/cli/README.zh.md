# @ephemeral-ai/mayfly-cli

`mayfly` 打开独立 TUI，并自动启动本机后台 Host；`mayfly server` 管理该 Host。退出 TUI 只断开 Client，Host 上的工作继续运行。

匹配的分体发布集发布后：

```sh
npm install -g @ephemeral-ai/mayfly-cli
mayfly
```

当前开发 checkout 使用 Node >=24.9.0 和仓库锁定的 pnpm：

```sh
pnpm install --frozen-lockfile
pnpm run build
node packages/cli/lib/bin.js --profile mayfly-dev
```

worktree 使用专用 `mayfly-<tag>` profile。CLI 精确依赖匹配的 Host、Remote 和官方 Harness 包，无需额外全局安装 dsh，也不解压运行时归档。

```sh
mayfly server                         # 启动并等待就绪
mayfly server start
mayfly server stop
mayfly server restart
mayfly server status
mayfly server logs                    # 最近 100 行
mayfly server logs --follow
mayfly server enable                  # 开启登录自启
mayfly server disable                 # 关闭登录自启，不停止当前实例
mayfly server start --profile work --port 0
mayfly --profile work
mayfly --resume <session-id>
mayfly --cwd /path/on/host '解释这个仓库'
mayfly -- server 是这条任务的第一个词
```

默认 profile 为 `mayfly`。两端使用 `MAYFLY_HOME`（默认 `~/.mayfly`）：`harness/` 保存独立的原生数据，`run/<profile>/` 保存私有发现记录，`logs/<profile>/` 保存最多五份、每份 10 MiB 的轮转日志。不迁移现有 `~/.dsh` 数据。首次使用初始化原生 Web profile 并安装 Host bundle；已有 profile 记录的发布版本不匹配时明确拒绝，不静默升级。

Linux 使用 systemd 用户服务，macOS 使用 LaunchAgent。Windows 使用隐藏窗口、脱离终端的 Mayfly 监督进程，无计划任务、Windows Service 或管理员权限要求。Host 崩溃后按有界退避重启，连续失败十次停止重试，健康运行一分钟重置计数。Windows `enable` 只写入当前用户的 Run 注册表项。各平台登录自启均默认关闭，不承诺注销后持续运行；Linux/macOS 需要原生用户服务管理器可用。

`stop` 请求原生 Host 清理并结束监督；十秒后仍未退出则强制结束所拥有的确切子进程。Host 上正在运行的工作随之终止。下次执行 `mayfly` 会重新启动。`enable`、`disable` 不改变当前运行状态。`status` 对健康、停止、失败或未知分别返回 0、3、1；仅有 PID 不代表就绪。start/restart 接受具体的 `--host` 地址和 `--port`（默认 127.0.0.1、0），按 profile 保存设置，初始化完成后最多等待 60 秒就绪。

Host 重启会轮换连接凭据。已有 TUI 请退出后重新运行 `mayfly`，读取新的本机连接记录。

显式远程连接：

```sh
mayfly server start --print-startup-url
# 将这次显式输出的凭据安全传递到另一台机器：
MAYFLY_DSH_STARTUP_URL='<authenticated-url>' mayfly
```

凭据不进入 argv 或普通日志。本机发现使用当前用户私有记录与认证控制通道；远程继续使用环境变量中的认证 URL。无密钥 `--host <HTTP(S)-url>` 可覆盖远程地址，token 仍来自该环境变量。显式远程输入不能与 `--profile` 同用，也不会启动本机 Host。

Remote 的 `--resume`/`--session`、`--cwd`、位置任务和 `MAYFLY_SESSION_ID`、`MAYFLY_CWD`、`MAYFLY_TASK` 保持现有行为。不提交初始任务时，首条 prompt 前不创建 Session；交互选择使用 `/sessions` 或 `/resume`。`--help` 与 `--version` 不初始化或启动 Host。
