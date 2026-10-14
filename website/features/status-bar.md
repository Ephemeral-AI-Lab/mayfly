# 状态栏

Footer 是单行。所有内置与第三方 entry 都注册在同一个 `mayflyStatus`
service，并使用 renderer-neutral `MayflyStatusNode`；entry 仍可声明
`row: 2` 独占第二行。

会话名称不在 footer 中——它显示在编辑器上边框的右端。Bash 模式保留左缘的
`! shell mode` 标签。

| Entry | Priority | 内容 |
| --- | --- | --- |
| conversation-view | 1 | 打开的会话多于一个时，用标签标出当前会话（` main `、` btw `、` subagent `）；`F7`/`F8` 的提示在通知栏 |
| basic | 0 | 当前 `provider/model`；显式选择 thinking effort 时追加 ` Effort`(如 `deepseek/step-5-preview Max`),provider default 不加后缀；宽度不够时截断而不是整个丢弃 |
| mode | 2 | plan/yolo 状态 |
| schedule | 2 | 提醒数（无提醒时隐藏） |
| jobs | 3（第二行） | `⏵ N jobs`——live（running/stopping）后台任务数；没有时隐藏 |
| context | 4（right） | 最近一步的 cache 命中率与 context 占用，如 `cache 82%  context: 45% (57.6k/128k)`；provider 未报告 cache 时省略 `cache` 段 |
| cwd | 5 | 当前工作目录 |
| git | 10 | branch 与变更摘要 |

状态区是两行。第一行（上表）是事实；第二行是**条目**——jobs、goal、todo——每个条目是一个简略摘要（`<标记> <名称> <n/m> <计时>`：`● todo 2/12 4m 12s`、`● goal 2/8 1m 59s`、`⏵ 1 job`），各占整行宽度的五分之一，放不下用 `…` 截断；没有内容的条目不出现，全部都没有时第二行也不出现，所以状态栏默认只有一行。`Alt+↓` 在第二行下方打开条目的详情面板，条目下方画一条粗线。

goal 的标记就是它的状态：`●` 进行中且已启动续跑，`○` 进行中但未启动（会话恢复或分叉后只有恢复才能继续它：`/goal resume` 或面板里的“继续”按钮），`⏸` 已暂停，`✕` 受阻；完成后 `✓ goal 8/8 12m` 保留几秒。目标面板显示目标内容和受阻目标的代码与原因，对应 `/goal` 子命令用单个字母操作，提示行里会列出（`r` 继续、`p` 暂停、`e` 修改——会把 `/goal edit …` 放进输入框，`c` 清除——需先确认），受阻时还会在通知里提示，每一次目标变更和每一轮自主续跑都是会话里的一行（`✓ Goal complete · 2 rounds · 1m 59s`、`── goal round 3 ──`）。

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
