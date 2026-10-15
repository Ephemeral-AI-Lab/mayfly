# 状态栏

Footer 是单行。所有内置与第三方 entry 都注册在同一个 `mayflyStatus`
service，并使用 renderer-neutral `MayflyStatusNode`；节点可以是 shed 节点
（`ui.shed(full, narrower)`），带有更窄的形态。

会话名称不在 footer 中——它显示在编辑器上边框的右端。Bash 模式保留左缘的
`! shell mode` 标签。

| Entry | Priority | 内容 |
| --- | --- | --- |
| basic | 0 | 当前 `provider/model`；显式选择 thinking effort 时追加 ` Effort`（如 `deepseek/step-5-preview Max`），provider default 不加后缀；行拥挤时先丢弃 provider，再丢弃 thinking 级别 |
| conversation-view、focus | 1 | 打开的会话多于一个时，用标签标出当前会话（` main `、` btw `、` subagent `），`F7`/`F8` 的提示在通知栏；焦点不在输入框时，用标签标出焦点位置（` conversation `、` view `、` search `） |
| mode | 2 | plan/yolo 状态，两者同时开启时同时显示 |
| context | 6（right） | 最近一步的 cache 命中率与 context 占用，如 两条进度条，`cache ▰▰▰▰▱ 82%  ctx ▰▰▰▰▱▱▱▱▱▱ 45%`（context 条超过 70% 变为警告色，超过 90% 变为危险色；cache 条低于 60% 变为警告色，低于 30% 变为危险色）；provider 未报告 cache 时省略 `cache` 段；拥挤时先丢弃 cache 条，再把 context 条缩成 `ctx 45%`，最后丢弃整个读数 |
| cwd | 7 | 当前工作目录；拥挤时丢弃层级，只留最后一段 |
| git | 10 | branch 与变更摘要；行拥挤到 rank 30 时整项丢弃，排在条目计时、provider 和 thinking 级别之后 |
| agents | 11 | `● agents 1/3 41s`——本会话的子智能体；保留到新会话开始 |
| jobs | 12 | `● jobs 2 41s`——live（running/stopping）后台任务数和最久一个已运行的时间；最后一个结束时 `✓ jobs 3/3 41s`（有失败则 `✕`）保留五秒后消失；子智能体任务归 Agents 条目 |
| goal | 13 | `● goal 2/8 1m 59s`——标记就是状态；没有 goal 时隐藏 |
| todo | 14 | `● todo 2/12 4m 12s`；没有列表时隐藏 |

事实在前，条目在后（agents、jobs、goal、todo，排在目录和 git 之后）。

行拥挤时，会先按固定顺序收起细节，再考虑丢弃条目：条目的计时、provider、thinking 级别、git 信息、目录层级、cache 数字、context
meter，最后是 model。条目是 view：行里是简短摘要（`<标记> <名称> <n/m> <计时>`），按 `Alt+↓` 后条目下方出现一条粗线，详情面板在
状态栏下方。没有内容的条目不出现，所以状态栏是一行。

goal 的标记就是它的状态：`●` 进行中且已启动续跑，`○` 进行中但未启动（会话恢复或分叉后只有恢复才能继续它：`/goal resume` 或面板里的 `r`），`⏸` 已暂停，`✕` 受阻；完成后 `✓ goal 8/8 12m` 保留几秒。goal 面板显示目标内容和受阻目标的代码与原因，对应 `/goal` 子命令用单个字母操作，提示行里会列出（`r` 继续、`p` 暂停、`e` 修改——会把 `/goal edit …` 放进输入框，`c` 清除——需先确认），受阻时还会在通知里提示。每一次目标变更和每一轮自主续跑都是会话里的一行（`✓ Goal complete · 2 rounds · 1m 59s`、`── goal round 3 ──`）。

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
