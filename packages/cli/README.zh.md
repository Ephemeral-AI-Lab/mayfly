# @ephemeral-ai/mayfly-cli

`mayfly` 命令是独立的终端 UI 启动器。它通过 `@ephemeral-ai/mayfly-remote` 连接单独运行的 dsh Host；自身不包含、不解压、不启动也不停止 dsh Host、Agent Loop、模型提供方、工具运行时或 Session 存储。

当前开发分支使用仓库的规范安装器和启动器，搭配独立安装的官方 dsh
`0.2.2-alpha.2`：

```sh
pnpm install --frozen-lockfile
DSH_BIN=/path/to/dsh PROFILE=mayfly-cli-accept script/install-dev.sh
# 终端 1
/path/to/dsh --profile mayfly-cli-accept
# 终端 2：复制 Host 打印的认证 URL
MAYFLY_DSH_STARTUP_URL='<authenticated-url>' script/mayfly-remote.sh
```

匹配且经过验证的分体版本发布后，`npm -g install @ephemeral-ai/mayfly-cli`
安装该启动器与精确 Remote 版本。`mayfly` 命令使用同一个认证启动环境变量：

```sh
export MAYFLY_DSH_STARTUP_URL='<Host-打印的认证启动-URL>'
mayfly
```

该 URL 必须使用 HTTP(S)，并恰好包含一个非空 `token` 查询参数。token 和由此获得的 cookie 只保存在进程内存中，不接受通过命令行参数传入，也不会写入普通诊断信息。不要把带认证信息的 URL 放进 `mayfly` 的参数；已有终端会话也可以使用各自的密钥安全环境机制提供该值。

Mayfly 只支持独立 Remote 选项：

```text
mayfly [--host <无密钥-URL>] [--resume <session-id>] [--cwd <path>] [task ...]
mayfly --session <session-id>
mayfly --version
mayfly --help
```

`--host` 可以更改 HTTP(S) Host URL，但不接受凭据、查询参数或片段；token 仍从 `MAYFLY_DSH_STARTUP_URL` 读取。`--resume` 和 `--session` 选择已有的 Host Session；两者和初始任务都未提供时，Mayfly 在第一条 prompt 前不创建 Session。创建时使用 `--cwd` 或启动器的当前目录，并将其作为 Host 上的路径。位置参数会合并为一个初始任务；以连字符开头的任务应放在 `--` 之后。

对应参数未提供时，`MAYFLY_SESSION_ID`、`MAYFLY_CWD` 和 `MAYFLY_TASK` 分别提供环境默认值，命令行值优先。需要交互式选择 Session 时，在 TUI 内使用 `/sessions` 或 `/resume`。

npm 包只包含小型启动器、文档，以及对 `@ephemeral-ai/mayfly-remote` 的精确版本依赖。包中没有捆绑的 dsh CLI 运行时归档，也没有首次运行时的 profile 校准或解压缓存。重装 `@ephemeral-ai/mayfly-cli` 即可升级 TUI；Host 由 dsh 独立升级和运维。
