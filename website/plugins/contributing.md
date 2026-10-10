# 贡献 Mayfly

Mayfly 是 pnpm 11 workspace，要求 Node `^22.19.0 || >=24.0.0`。当前发布集为
三个 package：`@ephemeral-ai/mayfly-ui`、`@ephemeral-ai/mayfly` 与
`@ephemeral-ai/mayfly-cli`（frontend、conversation、app、core、transcript、
interaction 是 `mayfly` 内部的源码区域，不再单独发布）。

先阅读根 `AGENTS.md` 与 owning package 的 `AGENTS.md`。用户可见行为、
public seam 或 Website 变更必须在专用 worktree/branch 开发。

```sh
pnpm install
pnpm run check -- --tier round   # 每次修改：增量构建、lint、受影响的测试
pnpm run check                   # 提交前：再加上本次改动涉及的检查
pnpm run check -- --tier full    # 发布或大范围改动：完整检查
```

`--plan` 只列出将要运行的步骤；结果写在 `.artifacts/verify/summary.md`。

发布形态另跑：

```sh
pnpm run check:lib
pnpm run check:pack
pnpm run check:examples
```

Runtime/public/composition 变更需安装专用 profile：

```sh
PROFILE=mayfly-my-change script/install-dev.sh
dsh --profile mayfly-my-change
```

Website 变更需 build 并通过 LAN preview 验收。适用的人类验收全部完成前，不
merge、不删除 profile、不停止 preview。
