# 升级与旧数据

此候选版本只发布到 `rc` 通道，稳定的 `latest` 仍为 `0.1.5`。请使用下方的精确版本号安装。

Mayfly 0.1.5-rc.2 使用一个 CLI 管理后台 Host 和独立 TUI，运行时固定为官方 Harness `0.2.2-rc.1`，需要 Node `>=24.9.0`。安装器同时安装四个匹配版本的包，不修改单独安装的全局 `dsh`。

## 从已有分体开发版升级

升级前，在所有 TUI 中退出，等待 Host 工作完成，然后使用原来的命令停止旧实例。保留原来的 `MAYFLY_HOME`，备份该目录，并记下原版本与 profile 名称。

```sh
# 使用旧安装停止旧实例；以下命令沿用原来的 MAYFLY_HOME 和 profile
mayfly server disable --profile <original-profile>
mayfly server stop --profile <original-profile>
# 备份 MAYFLY_HOME 后升级外部安装
npm install -g @ephemeral-ai/mayfly-cli@0.1.5-rc.2
mayfly server upgrade --profile <original-profile>
mayfly server start --profile <original-profile>
mayfly server status --profile <original-profile>
mayfly --profile <original-profile>
```

`server upgrade` 使用当前 CLI 携带的官方 dsh 安装器刷新链接 Host，并在验证组合后更新版本标记。它保留原 profile 的 Session 和设置文件；运行中的 supervisor 或非托管 profile 会被拒绝。先检查 `/sessions`、`/provider`、`/settings` 和一条普通消息，再按需重新开启登录自启。依赖安装失败时，保留日志和备份；修复安装环境后重跑同一个显式升级命令。

普通启动仍拒绝版本不匹配，不会隐式修改旧 profile。不要复制 `node_modules` 或修改版本标记来绕过检查。保留原数据根和 profile；创建另一个 profile 不会转移原配置。请重新打开已有消息的会话验证升级。

默认 CLI 把 Host 以 `link:` 注册到它携带的精确依赖。因此 `/update` 会要求使用原安装器；它不能替换这种托管安装。该限制与显式 `server upgrade` 的外部安装流程配套。

需要回退时，先停止新实例，再安装记录的旧 CLI 版本，并从升级前备份恢复原 profile 后启动。若新 Harness 已改写持久化数据，请从升级前备份恢复完整数据根后再运行旧版。不要同时用两个版本写同一份数据。

## 从旧版单进程 Mayfly 迁移

旧版常用 `~/.dsh`，0.1.5-rc.2 的默认目录是 `~/.mayfly`，其中 `harness/` 存放原生 Host 数据。设置 `DSH_HOME` 不会覆盖 CLI 的托管数据根；需要改变根目录时设置 `MAYFLY_HOME`。

本版没有旧 profile 或 Session 数据的自动导入工具。保留旧安装和 `~/.dsh` 的备份，通过旧版 `/export` 保存需要的对话，在新安装中重新配置 provider、权限和插件。不要把旧版共享 renderer 当作新 Host bundle 安装，也不要把整个旧 profile 复制进托管目录。已有数据的格式转换由原生 Harness 负责，不能用修改 Mayfly 版本标记代替。

## 独立远程 Host

使用 `MAYFLY_DSH_STARTUP_URL` 连接自行维护的 Host 时，CLI 不启动本机实例。Host 与 Remote 必须使用同一 Mayfly 发布集及匹配的 Harness 线。先停止写入并备份，使用各自的原安装器升级两端，再重启 Host、重新取得认证 URL 并启动 TUI。认证 URL 通过环境变量传递。

升级失败时保留日志并运行 `mayfly server status`、`mayfly server logs`。`server restart` 会更换凭证；已有 TUI 需要退出后重新连接。
