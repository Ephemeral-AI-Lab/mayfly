# `@ephemeral-ai/mayfly-host`

[English](README.md) | 中文

Mayfly Host 在完整的 `dsh-web-app` 组合中添加 `mayflyConversation` 会话投影和 `mayflyHost` Remote 命名空间。其 bundle patch 禁用浏览器交接和普通 Web URL 行，并在 Loader 稳定后输出一行经过身份验证的 `mayfly host: <url>` 就绪信息。

独立前端是 `@ephemeral-ai/mayfly-remote`；Host 不内嵌该前端。

## 开发 profile

使用 Node `>=24.9.0` 和仓库锁定的 pnpm。在仓库根目录安装并构建：

```sh
pnpm install
pnpm run build:changed
```

从随附的 Web 模板初始化一个全新的、已被 Git 忽略的开发 profile。此替换命令仅用于首次设置；再次运行会重置同名 profile：

```sh
export DSH_HOME="$PWD/.artifacts/dsh-host"
pnpm --dir packages/host exec dsh --profile mayfly-host-dev --from-default-profile web --dump-default-config >/dev/null
pnpm --dir packages/host exec dsh plugin --profile mayfly-host-dev add "link:$PWD/packages/host"
```

生成的 bundle 顺序为 `dsh-base`、`dsh-web-app`，然后是 `@ephemeral-ai/mayfly-host`。Host 包的开发依赖为安装和启动提供同一个 `0.2.2-alpha.2` CLI，与旧版进程内 Mayfly 包使用的 dsh 版本互不影响。

启动外部 Host：

```sh
pnpm --dir packages/host exec dsh --profile mayfly-host-dev --no-open
```

把唯一就绪行中的身份验证 URL 复制到第二个终端的环境变量中；切勿将其放入 argv 或提交到 Git：

```sh
MAYFLY_DSH_STARTUP_URL='<authenticated-url>' pnpm run scenario hostConversation
```

修改源代码后，运行 `pnpm run build:changed` 并重启 Host。修改 manifest 依赖后，运行 `pnpm install`；已有的 profile 链接会保持有效。

## 已安装 profile

当 `@deepseek-ai/dsh` `0.2.2-alpha.2` 和已发布的 `@ephemeral-ai/mayfly-host` 可用时，生产路径使用相同的 bundle 机制，但不使用 `link:`、工作区内的 CLI 或工作区内的 home：

```sh
dsh --profile mayfly-host --from-default-profile web --dump-default-config >/dev/null
dsh plugin --profile mayfly-host add @ephemeral-ai/mayfly-host
dsh --profile mayfly-host --no-open
```

初始化命令会替换已有的自定义 profile，因此仅应在创建或明确需要重置该 profile 时使用。
