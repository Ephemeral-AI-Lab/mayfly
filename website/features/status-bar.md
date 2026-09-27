# 状态栏

Footer 是单行。所有内置与第三方 entry 都注册在同一个 `mayflyStatus`
service，并使用 renderer-neutral `MayflyStatusNode`；entry 仍可声明
`row: 2` 独占第二行。

会话名称不在 footer 中——它显示在编辑器上边框的右端。Bash 模式保留左缘的
`! shell mode` 标签。

| Entry | Priority | 内容 |
| --- | --- | --- |
| agent-view | 0（center） | 有辅助会话时显示当前侧、辅助类型/标签，以及 `F7 switch · F8 close` |
| basic | 0 | 当前 model |
| mode | 2 | plan/yolo 状态 |
| goal | 2 | 当前 goal 的 `Goal <phase> · <rounds>/<max> · <activation>`（按 phase 着色；无 goal 时隐藏） |
| schedule | 2 | 提醒数（无提醒时隐藏） |
| jobs | 3 | `⏵ N jobs`——live（running/stopping）后台任务数；没有时隐藏 |
| context | 4（right） | 最近一步的 cache 命中率与 context 占用，如 `cache 82%  context: 45% (57.6k/128k)`；provider 未报告 cache 时省略 `cache` 段 |
| cwd | 5 | 当前工作目录 |
| git | 10 | branch 与变更摘要 |

宽度不足时，整行按 priority/id 顺序容纳 entry：放得下的 entry 保留完整
宽度，声明 `overflow: 'hide'` 的 entry 直接隐藏而不是截断，行满后低优先级
entry 被丢弃。已容纳的 entry 再按声明的 left/center/right band 布局。

第三方贡献：

```ts
export const inject = ['mayflyStatus']

export function apply(ctx: Context): void {
  ctx.mayflyStatus.register({
    id: 'acme.health',
    priority: 15,
    band: 'right',
  }, { kind: 'text', content: 'healthy', tone: 'success' })
}
```

Registration 随 Fiber 清理。详情见[插件状态栏](/plugins/status)。
