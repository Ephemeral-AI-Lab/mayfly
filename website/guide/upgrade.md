# 升级与旧数据

Mayfly 0.1.5 使用一个 CLI 管理后台 Host 和独立 TUI，运行时固定为官方 Harness `0.2.2-alpha.3`，需要 Node `>=24.9.0`。安装器同时安装五个匹配版本的包，不修改单独安装的全局 `dsh`。

## 从已有分体开发版升级

升级前，在所有 TUI 中退出，等待 Host 工作完成，然后使用原来的命令停止旧实例。保留原来的 `MAYFLY_HOME`，备份该目录，并记下原版本与 profile 名称。

```sh
# 使用旧安装停止旧实例；如果设置了 MAYFLY_HOME，以下命令沿用同一个值
mayfly server disable --profile <old-profile>
mayfly server stop --profile <old-profile>
npm install -g @ephemeral-ai/mayfly-cli@0.1.5
mayfly server start --profile mayfly-015
mayfly server status --profile mayfly-015
mayfly --profile mayfly-015
```

新 profile 从当前 Harness 的 Web 模板创建。Host 的数据根仍为同一个 `MAYFLY_HOME/harness`；profile 自己的 bundle、设置和插件需要重新检查。不要复制旧 profile 的 `package.json`、`node_modules` 或版本标记来绕过检查。先检查 `/sessions`、`/provider`、`/settings` 和一条普通消息，再按需执行 `mayfly server enable --profile mayfly-015` 开启登录自启。后续每次启动都使用这个 profile 名称。

默认 CLI 把 Host 以 `link:` 注册到它携带的精确依赖。因此 `/update` 会要求使用原安装器；它不能替换这种托管安装。旧 profile 的安装标记与新 CLI 不一致时，启动会明确拒绝。使用新的版本化 profile 是本版支持的升级方式。

需要回退时，先停止新实例，再安装记录的旧 CLI 版本，并用原 profile 启动。若新 Harness 已改写持久化数据，请从升级前备份恢复完整数据根后再运行旧版。不要同时用两个版本写同一份数据。

## 从旧版单进程 Mayfly 迁移

旧版常用 `~/.dsh`，0.1.5 的默认目录是 `~/.mayfly`，其中 `harness/` 存放原生 Host 数据。设置 `DSH_HOME` 不会覆盖 CLI 的托管数据根；需要改变根目录时设置 `MAYFLY_HOME`。

本版没有旧 profile 或 Session 数据的自动导入工具。保留旧安装和 `~/.dsh` 的备份，通过旧版 `/export` 保存需要的对话，在新安装中重新配置 provider、权限和插件。不要把旧版共享 renderer 当作新 Host bundle 安装，也不要把整个旧 profile 复制进托管目录。已有数据的格式转换由原生 Harness 负责，不能用修改 Mayfly 版本标记代替。

## 独立远程 Host

使用 `MAYFLY_DSH_STARTUP_URL` 连接自行维护的 Host 时，CLI 不启动本机实例。Host 与 Remote 必须使用同一 Mayfly 发布集及匹配的 Harness 线。先停止写入并备份，使用各自的原安装器升级两端，再重启 Host、重新取得认证 URL 并启动 TUI。认证 URL 通过环境变量传递。

升级失败时保留日志并运行 `mayfly server status`、`mayfly server logs`。`server restart` 会更换凭证；已有 TUI 需要退出后重新连接。
