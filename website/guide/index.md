# 快速上手

::: info 当前开发线与参照
当前分体实现面向 Harness `0.2.2-alpha.3`，需要原生 Host 与独立 Remote TUI。
已发布的 Mayfly `v0.1.4-rc.2` 是不可改写的 UI、按键和工作流参照，不代表下面的
分体安装产物已经发布。开发产物从本工作区或经验证的匹配 tarball 安装。
:::

升级已有安装前先阅读[升级与旧数据](/guide/upgrade)。

## 一个命令启动

构建当前 checkout 后，可以直接打开 TUI；CLI 自动初始化专用实例、启动后台 Host 并连接：

```sh
pnpm install --frozen-lockfile
pnpm run build
node packages/cli/lib/bin.js --profile mayfly-dev
```

匹配发布集发布后，使用 `npm install -g @ephemeral-ai/mayfly-cli` 安装，日常直接执行 `mayfly`。

```sh
mayfly server              # 等同于 start，后台运行
mayfly server stop
mayfly server restart
mayfly server status
mayfly server logs --follow
mayfly server enable       # 开启登录自启，默认关闭
mayfly server disable      # 关闭登录自启，不停止当前 Host
mayfly server start --profile work
mayfly --profile work
```

Linux 使用 systemd 用户服务，macOS 使用 LaunchAgent，Windows 使用 Mayfly 自管后台监督进程，无需管理员权限。退出 TUI 不停止 Host；`server stop` 会结束 Host 上的工作。下次执行 `mayfly` 会重新启动。

默认数据根是 `~/.mayfly`，可用 `MAYFLY_HOME` 修改；不迁移已有 `~/.dsh`。本机通过当前用户私有记录发现 Host，日志不包含认证信息。远程连接继续使用 `MAYFLY_DSH_STARTUP_URL`，不会自动启动本机实例；显式获取 URL 使用 `mayfly server start --print-startup-url`，不要把认证 URL 放进 argv。

以下原生开发方式仍可用于单独调试两端。

## 前置条件

| 依赖 | 版本 |
| --- | --- |
| Node | `>=24.9.0` |
| pnpm | 仓库锁定的 `11.7.0` |
| dsh CLI | 独立安装的官方 `0.2.2-alpha.3` 可执行文件 |

## 安装专用 Host profile

在仓库根目录执行：

```sh
pnpm install --frozen-lockfile
DSH_BIN=/path/to/dsh PROFILE=mayfly-split-accept script/install-dev.sh
```

安装器构建工作区，从原生 Web 模板创建专用 profile 并添加 Mayfly Host。
它检查 dsh 版本，不修改全局安装，并拒绝共享的 `mayfly` 与 `default` profile。
共享 `@ephemeral-ai/mayfly` 只有 renderer 与展示 subpath，不是可安装的 Host bundle。

## 分别启动两个进程

```sh
# 终端 1：Host；模型 key 在这个进程配置
DEEPSEEK_API_KEY='<your key>' /path/to/dsh --profile mayfly-split-accept

# 终端 2：TUI；复制 Host 打印的认证 URL
MAYFLY_DSH_STARTUP_URL='<Host URL>' script/mayfly-remote.sh
```

认证 URL 只通过环境变量提供，不能放进命令行参数、日志或提交。Host 持有凭据、
provider、权限与 Session；TUI 关闭只解除连接，Host 上的工作继续运行。

不带任务或恢复 id 时，首条普通消息才创建 Session。也可以运行
`script/mayfly-remote.sh '解释这个仓库'`，或加 `--resume <session-id>` 恢复会话；
`--cwd <path>` 指定 Host 上的工作目录。`/new` 和 `/clear` 回到启动界面，不创建空会话。

## 开始使用

- 输入 `/` 或 `/help` 查看当前 Host 与前端真正可用的命令。
- 用 `/provider` 配置原生 provider，用 `/model`、`/effort` 选择模型。
- `/theme` 切换当前 TUI 主题，`/settings` 保存默认值；切换主题保留编辑器草稿。
- 启动界面的 `/plan` 只设置下一个 Session 的模式；`/plan <message>` 需要已有 Session。
- `/quit` 解除连接并退出 TUI，不停止 Host 工作。

修改源码后 rebuild，依赖变化后重新安装专用 profile。更多配置见[配置](/guide/config)，
验证与插件集成见[贡献本仓库](/plugins/contributing)。

## 界面参照

<p align="center">
  <img src="/shots/app-conversation.svg" width="720" alt="Mayfly 终端会话、工具卡片、编辑器与状态栏参照">
</p>
