# UI 节点参考

本页描述 `@ephemeral-ai/mayfly-ui` 当前 Public Beta 的完整 wire-node 构造接口。
`ui.*` builder 只负责构造、复制并冻结 renderer-neutral 数据；Mayfly renderer 负责
校验、布局、主题、宽度、焦点、输入路由和事件派发。插件仍然拥有业务数据、
native effect 以及权威 data snapshot。

> 节点树如何组织、受控状态如何流转，见配套指南[组件模型](/plugins/component-model)。

```ts
import type { MayflyUiActionEvent, MayflyUiEventContext, MayflyUiObservationEvent } from '@ephemeral-ai/mayfly-ui'
import { ui } from '@ephemeral-ai/mayfly-ui'
```

## 职责边界

| Mayfly 负责 | 插件负责 |
| --- | --- |
| 绘制 text、tabs、list、form、actions 等节点 | 提供节点数据和业务文案 |
| 保存当前 registration 的 draft、selection、page、operation 与 feedback | 保存领域事实并调用所属 native service/action |
| 当前 renderer 的主题、宽度降级、焦点和导航 | 为 data snapshot 提供 baseline、source stamp 与 scope |
| 事件分类、回包准入、ack 发布、abort/stale/unload fence | 返回结构化 action reply；外部数据变化时调用 handle `set()` |

节点不接受 renderer callback、raw key、终端坐标、ANSI 或 focus handle。不要把
I/O、Agent、Session 或 mutable renderer object 放进节点。

## 公共规则与限额

- 一棵树最多 256 个节点，根节点深度为 0、最大深度为 8；任一数组最多 200 项；
  全树字符串合计最多 20,000 个 UTF-16 code unit。
- builder 会递归复制并冻结输入，循环对象会被拒绝。Host admission 只接受普通
  object 和 dense array，并移除 ANSI、C1 与不安全控制字符。
- 一棵树最多 8 个 `image` 节点。`image` 的 `attachmentId` 为 1 到 128 个字符，
  `maxRows` 为 1 到 40 的整数。
- 所有数值布局字段都是非负 safe integer。`minSize` 不能大于 `maxSize`，viewport
  的最小值不能大于对应最大值。
- tabs/list/form 的 control id、form field id、action item id，以及 form/loader 的
  submit/cancel id 在同一棵交互树中不能产生冲突。Tab/list item id 至少在所属
  节点内唯一；作为 control 的 id 不能为空。
- `tone` 是语义颜色，不是色号：
  `default | muted | accent | success | warning | danger`。
- `emphasis` 是 `normal | strong`；省略时按普通文本处理。
- Identity 就是缓存键。到达 renderer 的 node 是冻结的 snapshot，未变的子树在重新
  发布时不产生任何开销：让未变的子 node 保持同一个对象，不要重建，或者给组件设置
  `memo: true`。`memo` 按引用比较 props，只有每个 prop 都稳定才会命中，包括以
  `MayflyTranslate` 传入的翻译函数；见 [公共 UI kit](/plugins/ui-kit)。

下面的“默认”描述 `0.1.3-rc.2` 当前 Mayfly TUI。wire contract 只承诺字段语义，
不会承诺具体边框字符、颜色值或按键绑定。

### 从 alpha.3 迁移

- 将单一 `onEvent(event, context)` 拆成 `onEvent.observe` 与 `onEvent.action`。
- 将 `selection-change` 改为观察用 `selection-toggle` 或 action 用
  `selection-accept`；事件都携带 `pagePath`。
- 删除插件自己的 form/tab/list draft、pending confirmation 与 renderer cursor；
  node 中的值只作为 initial/data baseline。
- Action handler 必须返回结构化 settlement。提交读取 `event.submission.forms` 与
  `selections`，不再读取扁平 `values`。
- 删除 `set(node, { eventRevision })`。外部刷新使用 `reason: 'data'`，新 instance
  使用 `reason: 'replace'`；ack 只由 registration-bound publisher 产生。

## 内容节点

### `text`

![`text` 节点渲染效果](/shots/text.svg)

*危险 tone 的单行提示（宽度 48）。*

```ts
ui.text(content: string, options?: {
  tone?: MayflyTone
  overflow?: 'wrap' | 'truncate' | 'middle' | 'start'
  styles?: readonly ('strong' | 'italic' | 'strike')[]
})
```

一段可换行的语义文本，用于状态提示、结果摘要等说明性内容；`tone` 省略时使用
主题正文色。上面的截图渲染的就是这个节点：

```ts
ui.text('Connection lost', { tone: 'danger' })
```

六种 tone 的完整对照：

![`text` 的全部 tone](/shots/text-tones.svg)

*`default`、`muted`、`accent`、`success`、`warning`、`danger`（宽度 56）。*

```ts
ui.stack.column([
  ui.text('Default body text'),
  ui.text('Muted secondary text', { tone: 'muted' }),
  ui.text('Accent highlight text', { tone: 'accent' }),
  ui.text('Success confirmation text', { tone: 'success' }),
  ui.text('Warning caution text', { tone: 'warning' }),
  ui.text('Danger failure text', { tone: 'danger' }),
])
```

长文本在分配宽度处换行，不会被截断：

![`text` 的换行行为](/shots/text-wrap.svg)

*同一条 warning 文本在宽度 48 下占三行。*

```ts
ui.text('A long status message wraps at the allocated width instead of clipping, so narrow panes stay readable.', { tone: 'warning' })
```

`overflow: 'truncate'` 则让节点恰好占一行：换行与制表符折叠为空格，超出部分以
`…` 结尾。适合底部 pane 中的紧凑行——换行会多占 dock 一行：

```ts
ui.text(`${label} · ${activity}`, { tone: 'muted', overflow: 'truncate' })
```

`overflow: 'middle'` 与 `'start'` 同样恰好占一行，但省略的是中间或开头而不是末尾，
让路径或标题里用来区分的那一端始终可见。`styles` 与 span 一样接受 `'strong'`、
`'italic'`、`'strike'`：

![`text` 的省略行为](/shots/text-ellipsis.svg)

*路径省略中间，同一路径省略开头并加粗（宽度 32）。*

```ts
ui.stack.column([
  ui.text('~/work/mayfly/packages/mayfly/src/core/ui-compiler.ts', { overflow: 'middle' }),
  ui.text('~/work/mayfly/packages/mayfly/src/core/ui-compiler.ts', { overflow: 'start', styles: ['strong'] }),
])
```

### `richText`

![`richText` 节点渲染效果](/shots/richText.svg)

*muted 前缀接 strong accent 模型名（宽度 64）。*

```ts
ui.richText(spans: readonly MayflyInlineSpan[], options?: { overflow?: 'wrap' | 'truncate' })

type MayflyInlineSpan = {
  text: string
  tone?: MayflyTone
  emphasis?: 'normal' | 'strong'
  motion?: 'shimmer' | 'loader'                        // 一行只有一个动效通道
  variant?: 'bloom' | 'fill' | 'gap' | 'breath'        // 配合 motion: 'loader'；默认 'gap'
}
```

在同一段文本中组合 tone 与强调，适合“标签 + 高亮值”这类行内混排。renderer
负责换行（设为 `overflow: 'truncate'` 时与 `text` 一样保持单行并以 `…` 截断），
插件不要拼 ANSI。上面的截图渲染的就是这个节点：

```ts
ui.richText([
  { text: 'Model ', tone: 'muted' },
  { text: 'deepseek-chat', tone: 'accent', emphasis: 'strong' },
])
```

tone 与 emphasis 可以自由组合成更长的混排段落：

![`richText` 的 tone/emphasis 组合](/shots/richText-mix.svg)

*muted 叙述、strong accent 路径、strong 数值与 danger 结尾（宽度 56）。*

```ts
ui.richText([
  { text: 'Rebuild of ', tone: 'muted' },
  { text: 'packages/mayfly', tone: 'accent', emphasis: 'strong' },
  { text: ' failed after ', tone: 'muted' },
  { text: '42s', emphasis: 'strong' },
  { text: ' with 2 errors', tone: 'danger' },
])
```

span 可以动。`motion: 'shimmer'` 让一个三字宽的窗口扫过 `text` 的各个字母
（窗口内 `primary` 加粗，其余弱化）；`motion: 'loader'` 是一个会动的 loader 单元
（`text` 必须为 `''`），样式取 `variant`。一行 rich text 至多一个动效通道，status
节点不允许动效。时钟归 renderer 所有（100 ms 一步，breath 每四步一档），一次 tick
只重绘含该 span 的那一行；减少动效时通道停在首帧，截图展示的也是首帧：

![`richText` 的动效](/shots/richText-motion.svg)

*闪动的标签与呼吸的单元，均为首帧（宽度 48）。*

```ts
ui.stack.column([
  ui.richText([{ text: 'Running commands', motion: 'shimmer' }, { text: ' · 12s', tone: 'muted' }]),
  ui.richText([{ text: '', motion: 'loader', variant: 'breath' }, { text: ' Waiting for authorization', tone: 'muted' }]),
])
```

### `fields`

![`fields` 节点渲染效果](/shots/fields.svg)

*两行 label/value，状态值带 success tone（宽度 64）。*

```ts
ui.fields(rows: readonly {
  label: string
  value: readonly MayflyInlineSpan[]
}[])
```

用于紧凑的 label/value 信息，例如会话元数据或环境摘要。`value` 始终是 span
数组，不是任意 `MayflyUiNode`。上面的截图渲染的就是这个节点：

```ts
ui.fields([
  { label: 'Status', value: [{ text: 'Ready', tone: 'success' }] },
  { label: 'Model', value: [{ text: 'deepseek-chat' }] },
])
```

多行 fields 中，每个 value 可以由多个 span 拼出强调层次：

![`fields` 的多 span value](/shots/fields-spans.svg)

*四行 fields：strong accent 会话名、拼色 branch、组合状态与 muted 时间（宽度 64）。*

```ts
ui.fields([
  { label: 'Session', value: [{ text: 'fix-width-scan', tone: 'accent', emphasis: 'strong' }] },
  { label: 'Branch', value: [{ text: 'p2/' }, { text: 'ui-gallery', tone: 'accent' }] },
  { label: 'Status', value: [{ text: 'Running', tone: 'success' }, { text: ' · 2 panes', tone: 'muted' }] },
  { label: 'Elapsed', value: [{ text: '4m 12s', tone: 'muted' }] },
])
```

### `code`

![`code` 节点渲染效果](/shots/code.svg)

*带 `ts` 语言提示的多行代码块（宽度 64）。*

```ts
ui.code(value: string, options?: { language?: string, numbered?: boolean })
```

表达代码或预格式化文本，例如补丁片段、命令输出或配置内容。带可识别的
`language` 时默认语法高亮：关键字用 `primary`，字符串用 `success`，注释弱化，
其余为正文色；高亮只覆盖前 12 行且代码不超过 32 KB，超出部分为纯文本。上面的截图渲染的就是这个节点：

```ts
ui.code([
  'export function estimateTokens(text: string): number {',
  '  // Rough heuristic: four characters per token.',
  '  return Math.ceil(text.length / 4)',
  '}',
].join('\n'), { language: 'ts' })
```

`numbered: true` 画出弱化的 `n │ ` 行号栏；折行后的续行缩进在代码之下：

![`code` 的行号](/shots/code-numbered.svg)

*两行带行号的代码（宽度 48）。*

```ts
ui.code('const frame = glyphFor(state)\nreturn frame', { language: 'ts', numbered: true })
```

### `diff`

![`diff` 节点渲染效果](/shots/diff.svg)

*多行 before/after：新旧两列行号，改动行以 `−`/`+` 标出，红/绿色带只铺在代码上（宽度 64）。*

```ts
ui.diff(before: string, after: string, options?: {
  start?: number      // 首行行号（默认 1）
  numbered?: boolean  // 新旧两列行号（默认 true）
  hunkHeader?: boolean // 即使只有一个 hunk 也画 `@@` 头（默认：多于一个才画）
  context?: number    // 每处改动周围的未改动行，0 到 3（默认 1）
  maxRows?: number    // 超出后显示 `… +N rows · Ctrl+O`
})
```

表达同一内容修改前后的语义对比，例如待确认的编辑。插件提供原始文本，不手工
添加 diff 颜色：Mayfly 画出新旧两列弱化行号（以 `│` 结尾），删除行与新增行以
`−`/`+` 标出，并用主题的 `diffRemovedBg`/`diffAddedBg` 色带铺在代码上（从不铺在行号上）；
每处改动保留一行上下文，跳过的未改动行显示为一个弱化的 `⋯`，过长的行以 `…` 结尾。
上面的截图渲染的就是这个节点：

```ts
ui.diff(
  ['export function connect() {', '  const retries = 3', '  return open(retries)', '}'].join('\n'),
  ['export function connect() {', '  const retries = 5', '  return open(retries)', '}'].join('\n'),
)
```

选项决定从哪一行起编号、是否用 `@@` 头标出 hunk、上下文放宽或去掉，以及行数上限：

![`diff` 的选项](/shots/diff-options.svg)

*从第 41 行起编号，带 hunk 头（宽度 48）。*

```ts
ui.diff(
  ['const a = 1', 'const b = 2', 'const c = 3'].join('\n'),
  ['const a = 1', 'const b = 4', 'const c = 3'].join('\n'),
  { start: 41, hunkHeader: true, context: 1 },
)
```

### `sections`

![`sections` 节点渲染效果](/shots/sections.svg)

*一个展开的 section 与一个 collapsed section 并排（宽度 64）。*

```ts
ui.sections(sections: readonly {
  title?: string
  body: MayflySectionContentNode
  collapsed?: boolean
}[])
```

每个 `body` 只能是轻量 section-content union：`text | fields | code | diff | sections`。
它不能直接包含 tabs、form、actions 或其他完整 `MayflyUiNode`。
`collapsed` 省略时等同 `false`；设为 `true` 时当前 TUI 只显示 section 标题，
无标题则显示省略提示。它是静态展示状态，不会自动生成展开/折叠事件。上面的
截图渲染的就是这个节点：

```ts
ui.sections([
  {
    title: 'Environment',
    body: ui.fields([
      { label: 'Node', value: [{ text: 'v24.15.0' }] },
    ]),
  },
  {
    title: 'Raw transcript',
    body: ui.text('Hidden until expanded.'),
    collapsed: true,
  },
])
```

### `markdown` 与 `diagram`

```ts
ui.markdown(source: string)
ui.diagram(mermaidSource: string)
```

Markdown 复用 Mayfly 的 pi-tui adapter，支持表格与代码 fence。Mermaid 通过
`beautiful-mermaid` 渲染为终端 Unicode；assistant 消息中的闭合 `mermaid`
fence 也走同一路径。解析失败、不支持、结构复杂度/源码/输出超过配额，或图形
超宽时，会保留原始 Mermaid code fence。这样复杂图不会阻塞终端渲染循环。图本身
绝不 wrap 或 truncate。

```ts
ui.diagram('flowchart TD\n  Request --> Validate\n  Validate --> Result')
```

`markdown` 与 `diagram` 可用于普通 pane、passive overlay 与 capturing overlay，不能用于
status、editor extension 或 `sections.body`。

### `chart`

`chart` 携带数据而不是 renderer options。Mayfly 通过 `simple-ascii-chart` 适配，
把 semantic tone 映射到当前 theme；图无法容纳时降级为有界文本摘要。

```ts
ui.chart({
  chart: 'line' | 'point',
  title?: string,
  xLabel?: string,
  yLabel?: string,
  height?: number, // 4..20
  series: [{
    id: string,
    label?: string,
    tone?: MayflyTone,
    points: [{ x: number, y: number | null }],
  }],
})

ui.chart({
  chart: 'bar',
  layout?: 'grouped' | 'stacked' | 'normalized',
  // 'horizontal' 仅与 layout: 'normalized' 组合：把每个 category 画成
  // height 行（默认 10）× ⌈100/height⌉ 列的按比例格网——每格约 1%、渲染
  // 两列宽；非零份额保底一格，empty: true 的 series 渲成 '░' 空轨（如 free space）。
  orientation?: 'vertical' | 'horizontal',
  title?: string,
  yLabel?: string,
  height?: number, // 4..20
  categories: readonly string[],
  series: [{ id: string, label?: string, tone?: MayflyTone, empty?: boolean, values: readonly (number | null)[] }],
})

ui.chart({ chart: 'sparkline', values: [2, 4, null, 7], label: 'Load', tone: 'warning' })

ui.chart({
  chart: 'heatmap',
  columns: ['Linux', 'macOS'],
  rows: ['Node 22'],
  values: [['pass', 'fail']],
  levels: [
    { value: 'pass', label: 'Passed', tone: 'success' },
    { value: 'fail', label: 'Failed', tone: 'danger' },
  ],
})
```

heatmap 由 Mayfly 自己绘制：标题、列名表头、每个行标签一行格子，以及图例行。
`cell: 2`（默认）把每个值画成两格（`░░ ▒▒ ▓▓ ██`，三个等级时为 `░░ ▒▒ ██`），
列名补到四列宽；`cell: 1` 每个值一格、格间无空隙（`· ░ ▒ ▓ █`），一整年的天数
也放得进一行，`columnLabels`（每列一个）写在各自那一列的起点，用来标月份。没有
等级的值为空白，超出可用宽度的行被裁剪。sparkline 只有一行：弱化的标签，接着是
按最大值缩放的八级格子，用节点的 tone 绘制（默认 `accent`）。

![`chart` 的 heatmap](/shots/chart-heatmap.svg)

*单格模式与月份标签（宽度 40）。*

```ts
ui.chart({
  chart: 'heatmap',
  cell: 1,
  title: 'Commits',
  columns: ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'],
  columnLabels: ['Jan', '', '', 'Feb', '', ''],
  rows: ['Mon', 'Fri'],
  values: [[0, 1, 2, 3, 2, 1], [1, 0, 0, 2, 3, 3]],
  levels: [
    { value: 0, label: 'none', tone: 'muted' },
    { value: 1, label: 'some', tone: 'success' },
    { value: 2, label: 'more', tone: 'success' },
    { value: 3, label: 'most', tone: 'success' },
  ],
})
```

数值必须 finite，`null` 表示缺失数据。series id 与 heatmap level value 必须唯一；
bar values 数量匹配 category，heatmap 矩阵维度匹配 row/column label。每个 chart
最多 20 个 series，单棵树最多 4,000 个 chart cell。与 `document` 一样，`chart`
可用于普通 pane、passive overlay 与 capturing overlay，不能进入更窄的 status、
status、editor extension 或 section-content 树。

## 布局节点

### `child`

![`child` 节点渲染效果](/shots/child.svg)

*宽度 64 满足 `minWidth: 48`，detail 正常显示。*

```ts
ui.child(node: MayflyUiNode, options?: {
  tab?: { controlId: string, itemId: string }
  basis?: number | 'auto'
  grow?: number
  shrink?: number
  minSize?: number
  maxSize?: number
  when?: {
    minWidth?: number
    maxWidth?: number
    minHeight?: number
    maxHeight?: number
  }
  priority?: number                      // row 中的录用顺序；越小越先保留
  band?: 'left' | 'center' | 'right'     // 被录用的子节点所在区段（默认 left）
  overflow?: 'truncate' | 'hide'         // 放不下时怎么办
})
```

普通节点可直接放入 stack；只有需要尺寸提示或响应式条件时才包装为 `ui.child()`。
尺寸是当前 stack 方向上的布局提示，不是固定终端行列承诺。`when` 使用该 surface
当前实际分配的 viewport；条件不满足时节点及其 controls 一起离树，Mayfly 会重新
协调焦点。`child` 只能作为 stack 成员出现，两张截图渲染的都是这个节点：

```ts
ui.stack.column([
  ui.text('Session overview'),
  ui.child(ui.text('Wide-only detail'), { grow: 1, when: { minWidth: 48 } }),
])
```

同一节点在宽度 40 下条件不再成立，detail 离树，只剩标题行：

![`child` 在窄宽度下隐藏](/shots/child-hidden.svg)

*宽度 40 不满足 `minWidth: 48`，`Wide-only detail` 离树。*

`tab` 为 child 指定稳定的页面身份，归属某个 `tabs` 控件。仅活动页可见，
隐藏页保留原有的表单和列表状态。它不适用于 status 或 editor decoration 树。

### `stack.row` / `stack.column`

![`stack` 节点渲染效果](/shots/stack.svg)

*column 中嵌套一个带 gap 的 row（宽度 64）。*

```ts
ui.stack.row(children, options?)
ui.stack.column(children, options?)

type StackOptions = {
  gap?: 0 | 1 | 2
  align?: 'stretch' | 'start' | 'center' | 'end'
}
```

`row` 表达横向排列意图，`column` 表达纵向排列意图。省略 `gap` 时当前 TUI 使用
0；省略 `align` 时使用 stretch。renderer 可以在没有空间布局能力的 surface 上
安全降级，因此不要依赖某个子节点的绝对坐标。上面的截图渲染的就是这个节点：

```ts
ui.stack.column([
  ui.stack.row([ui.text('left'), ui.text('right')], { gap: 1 }),
  ui.text('below'),
])
```

配合 `ui.child()` 的 `grow`，row 按比例分配宽度：

![`stack` 的 grow 比例](/shots/stack-grow.svg)

*`grow: 1` 与 `grow: 2` 把 row 宽按 1:2 分配（宽度 64）。*

```ts
ui.stack.row([
  ui.child(ui.surface({ chrome: 'lane', child: ui.text('grow 1') }), { grow: 1 }),
  ui.child(ui.surface({ chrome: 'lane', child: ui.text('grow 2') }), { grow: 2 }),
], { gap: 1 })
```

带 `priority` 的子节点让 `row` 改为录用而不是按尺寸排布：子节点按优先级（相同时按
原顺序）依次录用，只要放得下，之间隔 `gap`（默认 2）。放不下的子节点——`overflow: 'truncate'`
取走剩余宽度（至少 8 列，之后这一行满了）；`overflow: 'hide'` 直接退出，后面的子节点仍可能放得下；
都不写则录用到此为止，它和它后面的子节点全部丢弃。被录用的子节点按 `band` 放置：
右区段贴边，中区段在左右邻居之间居中。每个子节点只画第一行。Mayfly 的状态行用同一条规则，
插件条目与 Mayfly 条目被一视同仁地录用：

![`stack` 的录用](/shots/stack-admission.svg)

*宽度 64：右侧的 `cache 34%` 保留，路径截断进剩余的宽度。*

```ts
ui.stack.row([
  ui.child(ui.richText([{ text: 'deepseek-chat High' }]), { priority: 0 }),
  ui.child(ui.richText([{ text: 'PLAN', tone: 'primary', styles: ['strong'] }]), { priority: 1 }),
  ui.child(ui.richText([{ text: 'cache 34%', tone: 'muted' }]), { priority: 4, band: 'right', overflow: 'hide' }),
  ui.child(ui.richText([{ text: '~/work/mayfly/packages/mayfly', tone: 'muted' }]), { priority: 5, overflow: 'truncate' }),
], { gap: 2 })
```

同一节点在宽度 30 下：`cache 34%` 放不下而隐去，路径剩下不足 8 列，于是这一行止于 `PLAN`。

![`stack` 的录用（窄）](/shots/stack-admission-narrow.svg)

*宽度 30。*

### `surface`

![`surface` 节点渲染效果](/shots/surface.svg)

*title、subtitle、badges、`surface` 边框、padding 与 footer 的完整组合（宽度 64）。*

```ts
ui.surface({
  title?: string
  subtitle?: string
  badges?: readonly MayflyInlineSpan[]
  chrome?: 'none' | 'lane' | 'surface' | 'overlay'
  padding?: 0 | 1 | 2
  child: MayflyUiNode
  footer?: MayflyUiNode
  titleAlign?: 'left' | 'right'
  border?: MayflyTone
  escapeLabel?: 'close' | 'back' | 'cancel' | 'reject' | 'leave'
  hint?: 'auto' | 'none' | 'completions'
})
```

`surface` 把标题、徽标、正文和 footer 组合成一个语义容器。

| 字段 | 含义 |
| --- | --- |
| `title` | 主标题 |
| `subtitle` | 标题后的弱化说明行 |
| `badges` | 使用 span tone/emphasis 的徽标，位于标题规则线右侧（窄时先省略） |
| `chrome` | 边框意图；默认 `none`。`overlay` 与 `surface` 都是圆角框，标题嵌在顶部规则线里（`╭ 标题 ─── 徽标 ╮`），`overlay` 用焦点边框色，`surface` 用安静边框色；`lane` 只有规则线；`none` 是粗体标题 |
| `padding` | 内容侧留白级别；默认 `0`。带框的 chrome 在边框内至少保留一列 |
| `child` | 必填正文 |
| `footer` | 可选尾部节点，位于正文与底边之间 |
| `titleAlign` | `right` 把标题放到右上角、徽标放到左边；规则线放不下的长标题丢掉开头，路径的末端得以保留 |
| `border` | 边框 tone；省略时用 chrome 自己的颜色 |
| `escapeLabel` | `Esc` 提示里的字，以及内部没人接管 `Esc` 之后它做什么：请 host 关闭 surface（`reject` 以拒绝的方式关闭） |
| `hint` | `none` 不画按键提示行；`completions` 只在编辑器的补全列表打开时才画 |

`chrome: 'overlay'` 只是视觉意图，不会创建 overlay；真正的浮层仍通过
`api.overlays.open()` 打开。若 registration 的根节点就是这种 surface，core 会把
它与 registration title 合并成一个外框。普通 overlay 和
`presentation: 'editor'` 都遵守 `maxHeight`。未声明时，普通 overlay 最多占终端高度的
三分之一，编辑器形态最多占一半（至少 10 行）；内容较少时按自然高度显示，不会为了填满
上限而拉伸。
上面的截图渲染的就是这个节点：

```ts
ui.surface({
  title: 'Settings',
  subtitle: 'Profile mayfly-dev',
  badges: [{ text: 'alpha', tone: 'accent' }],
  chrome: 'surface',
  padding: 1,
  child: ui.fields([
    { label: 'Model', value: [{ text: 'deepseek-chat' }] },
  ]),
  footer: ui.text('Footer note', { tone: 'muted' }),
})
```

`chrome: 'lane'` 是更轻的变体：标题嵌在顶部规则线里，没有完整边框：

![`surface` 的 lane chrome](/shots/surface-lane.svg)

*lane chrome：顶部规则线嵌入标题（宽度 64）。*

```ts
ui.surface({
  title: 'Context',
  chrome: 'lane',
  child: ui.text('Lane chrome body'),
})
```

![`surface` 右对齐标题](/shots/surface-title-right.svg)

*右对齐标题与边框 tone（宽度 40）。*

```ts
ui.surface({
  title: '~/work/mayfly/packages/mayfly',
  titleAlign: 'right',
  chrome: 'surface',
  border: 'warning',
  badges: [{ text: 'dirty', tone: 'warning' }],
  child: ui.text('The end of the path stays visible.'),
})
```

### `scroll`

![`scroll` 节点渲染效果](/shots/scroll.svg)

*16 行内容放进 8 行 viewport、向下滚动 3 行后的呈现，`scrollbar: true` 的滚动条可见（宽度 56）。*

```ts
ui.scroll(node: MayflyUiNode, options?: {
  id?: string
  follow?: 'none' | 'start' | 'end'
  scrollbar?: boolean
  height?: number
  expandedHeight?: number
  fit?: boolean
  pill?: boolean
})
```

`follow` 表达刷新后的跟随意图；省略时等同 `none`。`id` 存在时 frontend owner
按内容 block 与字符 offset 保存语义锚点，数据插入、宽度变化或 renderer 重建后仍
恢复相同位置；`follow: 'end'` 持续跟随追加内容。交互 surface 在 main 与 alternate
mode 都使用父布局给出的实际高度；被动 transcript 的 main-mode scroll 线性化后由
外层 transcript viewport 接管。`scrollbar: true` 请求可见滚动条；嵌套 scroll 会被拒绝。
上面的截图渲染的就是这个节点：

```ts
ui.scroll(
  ui.stack.column(Array.from({ length: 16 }, (_, index) => ui.text(`log line ${index + 1}`))),
  { scrollbar: true },
)
```

写了 `height`、`expandedHeight`、`fit` 或 `pill` 之一，scroll 就有了自己的 viewport：恰好 `height`
行（默认 6）；被 `Ctrl+E` 展开时为 `expandedHeight` 行（默认 14）；内容旁边多一列滚动条
（`░` 轨道上的 `█` 滑块，`scrollbar: false` 除外）。外面的 surface 保持自然高度，不再
撑满终端。`fit` 让 viewport 收缩到短内容，内容溢出前不画滚动条。`pill` 在视图离开被跟随的
末尾、且其后又来了 N 行时，在最后一行上画 `↓ N new · End`，按 `End` 跳回。用户滚到的位置
在重新发布后保持；带 `id` 时由上文的锚点保持。

![`scroll` 区域](/shots/scroll-region.svg)

*12 行内容放进跟随末尾的 4 行 viewport（宽度 40）。*

```ts
ui.scroll(
  ui.stack.column(Array.from({ length: 12 }, (_, index) => ui.text(`log line ${index + 1}`))),
  { height: 4, follow: 'end', pill: true },
)
```

## 受控交互节点

插件提供 readonly baseline 与 action 声明。Mayfly frontend owner 按 registration
instance 持有当前 draft、选择、页面、确认、operation 和反馈；renderer 只投影这些
状态并发出语义事件。外部领域变化仍由插件发布新的 data snapshot，native action
通过结构化回执结算。

### `tabs`

![`tabs` 节点渲染效果](/shots/tabs.svg)

*初始状态：`activeId: 'summary'`，advanced 带 count 徽标，legacy 禁用（宽度 64）。*

```ts
ui.tabs({
  id: string
  activeId: string
  mode?: 'tabs' | 'wizard'
  orientation?: 'horizontal' | 'vertical'
  hintLabel?: string
  items: readonly {
    id: string
    label: string
    disabled?: boolean
    count?: number | string
    attention?: boolean
    group?: string
    clip?: 'end' | 'start'
    backId?: string
  }[]
})
```

- `activeId` 必须对应一个 item，是 registration 初始或 data snapshot 的 baseline；
  当前活动页由 Mayfly instance 保留。
- `disabled` item 会显示但不能激活。
- `count` 是跟在标签后的弱化数字或短文本（`3`、`2/6`）；`attention: true` 用加粗的
  `warning` 色 `!` 取代它。
- 放不下的 tab 条围绕当前 tab 折叠为 `‹ 当前 下一个 +N ›`，再退为 `‹ 当前 +N ›`，最后按宽度截断。
- `orientation: 'vertical'` 绘制侧栏（见下）；`hintLabel` 是提示行中 `Alt+←/→` 切换 tab
  使用的词（默认 `tabs`）。
- `mode: 'wizard'` 按已验证 form revision 标记完成步骤；编辑或 conflict 会使标记失效。
  向导是横向 tab 条，聚焦时提示行把 `Esc` 写作 `back`。
- `backId` 声明同组返回目标；未知目标和循环会被准入拒绝。
- Tabs 只绘制 tab strip；用 `ui.child(node, { tab })` 关联页面 body。
- 激活 item 时向 `onEvent.observe` 发出带 `pagePath` 的 `tab-change` 事实；插件无需
  回声调用 `set()` 才能切页。

```ts
ui.stack.column([
  ui.tabs({
    id: 'settings-tabs',
    activeId: 'summary',
    items: [
      { id: 'summary', label: 'Summary' },
      { id: 'advanced', label: 'Advanced', count: 4 },
      { id: 'legacy', label: 'Legacy', disabled: true },
    ],
  }),
  ui.child(ui.text('Summary content'), { tab: { controlId: 'settings-tabs', itemId: 'summary' } }),
  ui.child(ui.text('Advanced content'), { tab: { controlId: 'settings-tabs', itemId: 'advanced' } }),
])
```

用户切换到 advanced 后，tab strip 与关联 body 从同一 frontend page state 投影：

![`tabs` 切换后的状态](/shots/tabs-active.svg)

*`activeId: 'advanced'`：count 徽标随高亮项显示，body 同步切换（宽度 64）。*

```ts
ui.stack.column([
  ui.tabs({
    id: 'settings-tabs',
    activeId: 'advanced',
    items: [
      { id: 'summary', label: 'Summary' },
      { id: 'advanced', label: 'Advanced', count: 4 },
      { id: 'legacy', label: 'Legacy', disabled: true },
    ],
  }),
  ui.text('Advanced content'),
])
```

### 竖向侧栏

![`tabs` 竖向侧栏](/shots/tabs-rail.svg)

*`orientation: 'vertical'`：分组、计数与注意标记，右侧是当前标签的页面（宽度 64）。*

侧栏用于标签很多的场景（按工作区分的会话、按分组的设置）。把它放进 row 并设置 `basis` 与
`shrink: 0`，旁边的页面用 `ui.child(node, { tab })` 关联。

- `group` 让连续的 item 归在同一个弱化、大写的标题下。当前标签带加粗的 `→`：侧栏有焦点时为
  `primary`，焦点进入内容后变弱。计数和 `!` 右对齐。`clip: 'start'` 对长标签保留区分度高的
  末尾（`…ackages/mayfly`），默认裁掉末尾。
- `↑` / `↓` 移动并立即发出 `tab-change`，页面实时跟随。`→` 或 `Enter` 进入内容；侧栏上的 `←`
  不起作用。
- 视口宽度不足 60 列时，侧栏按横向 tab 条绘制和操作。
- `←` 阶梯：聚焦的控件先得到 `←`，只有它确实改变了内容才占用（不在第一个选项的 select、
  还能后退的行内 segment、已展开的树节点、action 行中靠后的 action）。它没用上的第一个 `←`
  把焦点移到 surface 的侧栏，无论侧栏在焦点顺序的哪里，提示行此时才写 `← labels`。
- 在文本编辑和选择器之外的任意位置，`Alt+↑` / `Alt+↓`（`F4` / `F5`）在控件之间移动，
  `Alt+←` / `Alt+→`（`F2` / `F3`）切换 tab。`Esc` 先把焦点还给第一个控件（`Esc back`），
  再关闭。

```ts
ui.stack.row([
  ui.child(ui.tabs({
    id: 'settings-rail',
    orientation: 'vertical',
    activeId: 'model',
    items: [
      { id: 'general', label: 'General', group: 'Session' },
      { id: 'model', label: 'Model', group: 'Session' },
      { id: 'permissions', label: 'Permissions', count: 2, group: 'Session' },
      { id: 'providers', label: 'Providers', attention: true, group: 'Integrations' },
      { id: 'mcp', label: 'MCP', count: '4/9', group: 'Integrations' },
    ],
  }), { basis: 24, shrink: 0 }),
  ui.child(ui.text('Model page'), { grow: 1, tab: { controlId: 'settings-rail', itemId: 'model' } }),
], { gap: 2 })
```

### `list`

![`list` 节点渲染效果](/shots/list.svg)

*single 模式下选中第一项（宽度 64）。*

```ts
ui.list({
  id: string
  mode?: 'single' | 'multiple'
  role: 'browse' | 'choose'
  selectedIds?: readonly string[]      // default []
  items: readonly MayflyListItem[]
  filter?: string
  filterable?: boolean
  filterMode?: 'type' | 'slash'
  tree?: boolean
  numbered?: boolean | 'focus'
  minSelected?: number
  maxSelected?: number
  acceptActionId?: string
  empty?: MayflyUiNode
  marker?: 'cursor' | 'selection'
  marks?: boolean
  maxRows?: number
  expandFocused?: boolean
  acceptVerb?: 'open' | 'choose' | 'expand' | 'edit' | 'restore'
  autofocus?: boolean
  focusItem?: { id: string, rev: number }
  hintLabel?: string
})

type MayflyListItem = {
  id: string
  label: string
  detail?: string
  detailSpans?: readonly MayflyInlineSpan[]
  badge?: string
  group?: string
  disabled?: boolean
  disabledReason?: string
  parentId?: string
  searchText?: string
  segment?: MayflyListSegment      // { label?, options, selectedId?, inheritedId? }
  unavailableActions?: Readonly<Record<string, string>>
  confirm?: string | MayflyConfirmation
  labelSpans?: readonly MayflyInlineSpan[]
  right?: readonly MayflyInlineSpan[]
  rightFocus?: readonly MayflyInlineSpan[]
  body?: string | MayflyListBodyNode   // 内容用 ui.listBody(...) 构建
  bodyAlways?: boolean
  expanded?: boolean
  wrap?: boolean
  wrapMax?: number
  meter?: { value: number, max: number, width?: number, tone?: MayflyTone }
  indent?: number
  rule?: string
  gap?: boolean
}
```

`role: 'browse'` 用于打开或检查条目，`role: 'choose'` 用于提交选择。`mode` 默认为
`single`。`selectedIds` 可省略，默认为 `[]`（无选中项）。single mode 最多有一个 `selectedIds`；所有 selected id
必须存在于 `items`。`detailSpans` 存在时优先于 `detail`。`group` 只表达分组标题，
`badge` 是紧凑标签；窄宽度下 renderer 可隐藏 detail。上面的截图渲染的就是这个
节点：

```ts
ui.list({
  id: 'item-list',
  role: 'browse',
  selectedIds: ['one'],
  items: [
    { id: 'one', label: 'First item' },
    { id: 'two', label: 'Second item' },
  ],
})
```

`filterable: true` 启用共享搜索；`filter` 只提供初始 query。输入字符或 `/` 开始搜索（`filterMode: 'slash'` 时只有 `/`），
Escape 结束搜索并保留 query，Ctrl+U 清空。Mayfly 在已给出的 items 上维护匹配和焦点，
不触发网络读取。`tree: true` 配合 `parentId` 提供共享展开状态（Space 或 Right/Left
展开、折叠分支）。大型 items 只校验和绘制当前窗口。items 为空时渲染 `empty`。

disabled 行永远不会获得光标，移动时直接跳过；没有 `detail` 的 disabled 行会在该位置
显示 `disabledReason`。`numbered: true` 为前九个可见行加上 `1.`–`9.` 前缀，数字键直接
选择该行；编号按可见顺序计算，列表滚动时保持不变。`numbered: 'focus'` 显示同样的编号，
但数字只移动光标，适合需要显式 Enter 才接受的关卡。

**斜杠筛选。** `filterMode: 'slash'` 让可打印键不再开始搜索，只有 `/` 才会（它也会恢复保留的
query），所以单个字母可以留给 `i install`、通用的 `x delete`、`r refresh` 等 accelerator。搜索
打开后数字是文本。没有 `filterMode` 的 `filterable` 列表把每个可打印键当作文本，validator 会拒绝
与之并存的可打印 accelerator；每个可筛选列表都设为 `filterMode: 'slash'` 时才放开。搜索打开时筛选
行显示 `N matches`，提示行只列出结束或清除搜索的键。

**行。** `marker: 'selection'` 让光标行在焦点离开后保留一个 muted 的 `→`（详情跟随它的 rail）。
`marks: true` 在 single choose 列表上画 `●`/`○`。`maxRows` 围绕光标开窗口，并以
`↑ n more · ↓ n more` 结尾。`acceptVerb` 在提示行命名 Enter，`hintLabel` 命名 `↑/↓`，`autofocus`
让该列表最先获得焦点。`focusItem` 在 `rev` 变化时移动光标（并展开该行的父级）；重新发布相同 `rev`
不会动读者已经移动过的光标。`expandFocused` 展开光标行的 body 或分支。`labelSpans` 绘制标签（`label`
仍是筛选读取的纯文本），`right` 把 span 对齐到行右缘，`rightFocus` 在光标下替换它，`meter` 画
`▰▱`，`indent` 缩进，`wrap` 在行自己的前缀下折行（最多 `wrapMax` 行，之后是
`▸ N more lines · Enter`），`rule` 与 `gap` 是方向键跳过的不可选 muted 分隔线与空行。树中 `*`
展开所有分支、`-` 折叠；multiple 树的父级在部分子项被选中时显示 `◐`。

**Body。** 字符串 `body` 在行下方以 `│ ╰` 引导线展开；节点 `body`（用 `ui.listBody` 构建，仅限内容：
text、rich text、fields、code、diff、sections、progress、image、divider）作为内容展开。带 body 的行
显示 `▸`/`▾`，用 Enter、Space 或 Right 展开（Left 折叠）；`bodyAlways` 不带展开箭头直接显示，
`expanded` 让行初始展开。每个 body 随其 item 在各自 32 个节点的预算下校验，长列表只校验光标附近的行，
所以数千条富行不会占用比普通行更多的树配额。body 永远不是 control：其中的 list、form、actions、
tabs 会被拒绝。

**Segment 条。** `segment` 只在焦点行上画一条横向选项（`min ‹ high (default) › max`）。
`←`/`→` 步进并在两端夹紧，跳过 disabled 选项；有 `inheritedId` 时，未固定的行把该选项标为
`(default)`，步进到它即取消固定，`Delete` 也取消固定（提示行 `Delete use default`）。仅当继承了某项
的行被固定时，`selection-accept` 才携带 `segmentId`。窄宽度下先去掉 `(default)`；该行放不下时，
列表预先保留一行 footer（`  Thinking: min ‹ high (default) › max`，其次去掉标题，再折叠为 `+N`，
最后只显示当前选项），因此焦点不会让任何一行移动。

![带斜杠筛选、body 与 meter 的 `list`](/shots/list-rows.svg)

*斜杠列表、选中 rail、右对齐 span、meter 与展开的 body（宽度 64）。*

```ts
ui.list({
  id: 'plugins',
  role: 'browse',
  filterable: true,
  filterMode: 'slash',
  marker: 'selection',
  selectedIds: [],
  items: [
    { id: 'loop', label: 'Loop', detail: 'official', right: [{ text: '1.4.0', tone: 'muted' }], meter: { value: 3, max: 4 } },
    { id: 'git', label: 'Git Helper', detail: 'community', right: [{ text: 'update 1.3.0', tone: 'muted' }], body: 'Commits, branches, and pull requests\nfrom the prompt.' },
  ],
})
```

![带 segment 条的 `list`](/shots/list-segment.svg)

*焦点行带有自己的条；向右键固定了下一个选项（宽度 64）。*

```ts
ui.list({
  id: 'models',
  role: 'browse',
  acceptVerb: 'choose',
  selectedIds: [],
  items: [
    { id: 'pro', label: 'DeepSeek V4 Pro', detail: '977k context', segment: { label: 'Thinking', inheritedId: 'high', options: [{ id: 'min', label: 'min' }, { id: 'high', label: 'high' }, { id: 'max', label: 'max' }] } },
    { id: 'flash', label: 'DeepSeek V4 Flash', detail: '256k context' },
  ],
})
```

`unavailableActions` 把 action id 映射到“当本行是该 action（通过其 `selections`）所指向
的选择时，该 action 为何不能执行”的原因。此时 action 以 disabled 呈现并显示原因，
Mayfly 会在任何确认之前拒绝它，用户不会确认一个注定失败的操作。行上的 `confirm`
会在接受这一行之前弹出共享 decision（见 `actions`）；选 No 时选择保持不变。

multiple 模式配合 `group`、`badge`、`detail` 与 `disabled` 可以表达更丰富的清单：

![`list` 的 multiple 模式](/shots/list-multiple.svg)

*multiple 模式：两组分组标题、badge、detail 与一个 disabled 项（宽度 64）。*

```ts
ui.list({
  id: 'plugin-list',
  role: 'choose',
  mode: 'multiple',
  selectedIds: ['context'],
  items: [
    { id: 'context', label: 'Context', group: 'Official', badge: 'core' },
    { id: 'remote', label: 'Remote', group: 'Official', detail: 'Session transport' },
    { id: 'lark', label: 'Lark', group: 'Optional', badge: 'notify', disabled: true },
  ],
})
```

选择变化向 `onEvent.observe` 发出 `selection-toggle` 和完整 `selectedIds`；明确接受
向 `onEvent.action` 发出 `selection-accept`。Action 也可通过 `selections` 把当前
选择连同表单输入放入 immutable submission。

### `form`

![`form` 节点渲染效果](/shots/form.svg)

*常用 field 的默认状态：secret 值被遮蔽，select 显示当前值，toggle 显示开关。多字段表单画一个主要的 Save；单字段表单不画按钮（宽度 64）。*

```ts
ui.form({
  id: string
  fields: readonly MayflyFormField[]
  submitActionId?: string
  submitLabel?: string
  cancelActionId?: string
  cancelLabel?: string
  enterSubmits?: string
})
```

Form field 是以下判别联合：

| `kind` | 必填字段 | 可选字段 | `value-change` value |
| --- | --- | --- | --- |
| `input` | `id`、`label`、`value: string` | `placeholder`、`pattern`、`patternMessage`、`suggestions`、`error`、`disabled` | `string` |
| `textarea` | 同 input | 同 input | `string` |
| `secret` | 同 input | 同 input；renderer 遮蔽 value | `string` |
| `number` | `id`、`label`、`value: number \| null` | `min`、`max`、`step`、`unit` | 编辑时为 `string` draft |
| `select` | `id`、`label`、`value: string \| null`、`options: MayflyListItem[]` | `error`、`disabled` | `string \| null` |
| `multiselect` | `id`、`label`、`value: string[]`、`options` | `minSelected`、`maxSelected` | `string[]` |
| `toggle` | `id`、`label`、`value: boolean` | `error`、`disabled` | `boolean` |

所有 `kind` 还接受 `help`（字段聚焦时在其下方显示的一行弱化文字，窄表单最先丢弃它）和 `group`
（同一 `group` 的字段归在一个 `── Group ──` 标题下；值一变就开始下一个标题）。`pattern` 是不超过 256 个
字符的正则表达式，以 `u` 标志编译，仅对非空值检查；`patternMessage` 给出错误文字（省略时为本地化的
“值无效”）。`suggestions`（最多 64 条单行文本）在编辑字段时提供补全：已键入文本是其开头的第一条以 `⇥`
标记，按 Tab 采用。

上面的截图渲染的就是这个节点：

```ts
ui.form({
  id: 'profile-form',
  fields: [
    { kind: 'input', id: 'name', label: 'Name', value: 'Ada' },
    { kind: 'textarea', id: 'bio', label: 'Bio', value: 'Compiler tinkerer' },
    { kind: 'secret', id: 'token', label: 'Token', value: 'sk-live-9f27' },
    { kind: 'select', id: 'theme', label: 'Theme', value: 'dark', options: [
      { id: 'dark', label: 'Dark' },
      { id: 'light', label: 'Light' },
    ] },
    { kind: 'toggle', id: 'updates', label: 'Auto-update', value: true },
  ],
  submitActionId: 'create-profile',
  submitLabel: 'Create profile',
})
```

Mayfly frontend instance 保留文本 draft，并向 `onEvent.observe` 发出带 field
revision 的 `value-change`，用于可选的异步校验；插件不应把每次输入回声为 snapshot。
权威 data snapshot 改变时，model 协调未修改值、草稿和冲突。文本字段聚焦后保持
导航态，直接输入或 Enter 才进入编辑；编辑态的 Enter 提交该字段并移到下一个字段，
textarea 用 Alt+Enter（或 Ctrl+J）插入换行。设置 `enterSubmits: actionId` 后，表单任一字段中的
Enter 都会执行该 action，包括 select、multiselect 与 toggle（此时 Space 打开选项列表或切换开关）；
只有一个字段且设置了 `submitActionId` 的表单同样以 Enter 提交。Escape 结束编辑并保留草稿，
再按一次 Escape 才离开 surface。聚焦的 textarea 会展开成一个框来显示各行。
number 字段会在值后显示 `unit`；聚焦时读作 `‹ 45 › s  5–120`，Left/Right 按 `step` 步进并限制在
`min` 与 `max` 之间（到达上下限时该键交给旁边的 control）。

下面的 form 聚焦 Name 字段并键入 `Ada Lovelace`——截图中
的草稿文本和光标就是这个交互序列留下的状态：

![`form` 的文本编辑态](/shots/form-editing.svg)

*编辑态：draft 实时显示，光标位于文本末尾（宽度 64）。*

```ts
ui.form({
  id: 'profile-form',
  fields: [
    { kind: 'input', id: 'name', label: 'Name', value: '' },
    { kind: 'toggle', id: 'updates', label: 'Auto-update', value: true },
  ],
  submitActionId: 'create-profile',
  submitLabel: 'Create profile',
})
```

聚焦的 select 用 Left/Right 直接切换取值并跳过 disabled 选项（未设值时 Right 选第一项、
Left 选最后一项）；Up/Down 永远移动到相邻字段。Enter 打开 select 的共享选项列表，
multiselect 用 Enter 或 Space 打开。列表内方向键移动、Space 切换多选项、Enter 应用。
Escape 放弃打开的列表并停在当前字段；Tab 应用高亮选项（或已勾选的集合）并继续前进。
打开的列表在 renderer 重建期间保留。可切换时，聚焦的 select 把取值放在切换标记之间，
例如 `Theme: ‹ Dark ›`。

下面的 form 在 Theme 字段按下 Enter 打开选项列表，再按一次 Right 把高亮移到 Light：

![`form` 的 select 选项列表](/shots/form-select.svg)

*打开的选项列表：`→` 标记高亮项，`●` 标记当前值、`○` 标记其余选项；Enter 把高亮项写入 field draft（宽度 64）。*

```ts
ui.form({
  id: 'profile-form',
  fields: [
    { kind: 'input', id: 'name', label: 'Name', value: 'Ada' },
    { kind: 'select', id: 'theme', label: 'Theme', value: 'dark', options: [
      { id: 'dark', label: 'Dark' },
      { id: 'light', label: 'Light' },
    ] },
  ],
  submitActionId: 'create-profile',
  submitLabel: 'Create profile',
})
```

`error` 在字段下方显示校验信息；`disabled` 字段不进入焦点导航，但仍保留在
提交表单中。`required`、长度、数值、`pattern` 与选择约束在 action 开始前统一校验。值被修改且
编辑结束（Enter、Tab 或 Escape）之后，违反的约束会以 `! message` 显示在该字段下方；正在键入的字段不会
被提前指责。被拒绝的保存会标出每个无效字段并提示“请修正标出的字段”，焦点留在原处（其他页面上的错误会把该页面
带到前台）。下面的 form 同时展示这两种状态：

![`form` 的 error 与 disabled 状态](/shots/form-validation.svg)

*Name 带 `error` 校验提示；Email 为 `disabled`，跳过焦点导航（宽度 64）。*

```ts
ui.form({
  id: 'profile-form',
  fields: [
    { kind: 'input', id: 'name', label: 'Name', value: '', error: 'Name is required' },
    { kind: 'input', id: 'email', label: 'Email', value: 'ada@example.com', disabled: true },
  ],
  submitActionId: 'create-profile',
  submitLabel: 'Create profile',
})
```

`origin: 'inherited' | 'explicit'` 在值后标注 `(继承)` 或 `(覆盖)`（英文界面为 `(inherited)`、`(override)`）；
修改继承值即成为显式覆盖。与默认值不同或被修改过的字段，在箭头列显示 `•`。`resetValue` 让已修改或显式覆盖
的字段可以重置：在该字段上按 Delete 恢复为 `resetValue`（字段带 `origin` 时即继承值），提交时该字段
报告 `change: 'reset'`；没有 `resetValue` 时，Delete 让已修改的字段回到打开时的值。只有重置会
产生变化时提示行才显示 Delete；表单不再渲染单独的覆盖或重置按钮。尚未改动的已保存 secret 读作
`•••• (saved)`。草稿期间权威值发生变化的字段，需先选择 **使用当前值** 或 **保留我的修改** 才能保存。

下面的 form 中 Endpoint 字段聚焦，所以显示它的 help：

![`form` 的分组、help 与标记](/shots/form-groups.svg)

*两个 `── Group ──` 标题下的分组。聚焦的字段显示 `help`；secret 读作 `(saved)`，Model 读作 `(inherited)`，Timeout 与 `resetValue` 不同，因此带 `•`（宽度 64）。*

```ts
ui.form({
  id: 'provider-form',
  fields: [
    { kind: 'input', id: 'name', label: 'Name', value: 'production', group: 'Connection' },
    { kind: 'input', id: 'endpoint', label: 'Endpoint', value: 'https://api.example.com/v1', help: 'Base URL, including the version path',
      pattern: '^https?://\\S+$', patternMessage: 'Must be an http(s) URL' },
    { kind: 'secret', id: 'key', label: 'API key', value: 'sk-live-0123456789' },
    { kind: 'select', id: 'model', label: 'Model', value: 'deepseek-chat', origin: 'inherited', group: 'Behaviour', options: [
      { id: 'deepseek-chat', label: 'deepseek-chat' },
      { id: 'deepseek-reasoner', label: 'deepseek-reasoner' },
    ] },
    { kind: 'number', id: 'timeout', label: 'Timeout', value: 45, resetValue: 30, min: 5, max: 120, step: 5, unit: 's' },
    { kind: 'toggle', id: 'stream', label: 'Streaming', value: true },
  ],
  submitActionId: 'save',
})
```

surface 上任何 form 存在未保存的修改时，surface 头部会在作者给出的徽章之后显示 `unsaved changes` 徽章。
Ctrl+S（`ui.save`）可在任一字段上提交该 form：依次使用它的 `submitActionId`、`enterSubmits` 指定的
action，或提交该 form 的 action（优先 primary）。

`submitActionId` 为多于一个字段的 form 增加一个主要的提交 control，按钮文字为 `submitLabel`（省略时为本地化的
“保存”），id 不会显示。只有一个字段的 form 不画按钮，用 Enter 提交。提交使用声明 action 的 `submit` 地址聚合一个或
多个页面中的表单，并锁定这次 boundary：

```ts
{
  kind: 'submit',
  controlId: form.id,
  pagePath: [],
  submission: {
    actionId: 'save',
    draftRevision: number,
    source: [{ resourceId: 'settings', revision: 3 }],
    forms: [{ pagePath: [], formId: form.id, draftRevision: number, fields: [
      { id: 'name', change: 'set', value: 'Ada' },
    ] }],
  },
}
```

`cancelActionId` 从不画成按钮：最外层的 Escape 会执行它，并关闭 surface；dirty form 会先进入默认 No 的丢弃确认。
宿主没有提供 `onUnhandledEscape` 时，提示行把 Escape 写作 `cancel`。关闭类 action 从不返回上一页，
返回由 Escape 负责。

### `actions`

![`actions` 节点渲染效果](/shots/actions.svg)

*primary、secondary 与带 confirm 的 danger 三种 intent（宽度 64）。*

```ts
ui.actions({
  id: string
  scope?: string | readonly string[]   // controls whose focus puts the group's keys in effect
  items: readonly {
    id: string
    label: string
    intent?: 'primary' | 'secondary' | 'danger'
    disabled?: boolean
    disabledReason?: string
    busy?: boolean
    confirm?: string | MayflyConfirmation
    submit?: readonly MayflyFormAddress[]
    read?: readonly MayflyFormAddress[]
    selections?: readonly MayflySelectionAddress[]
    defaultFocus?: boolean
    hidden?: boolean          // no button, no focus stop; runs from `key` or as a form `enterSubmits` target
    dismiss?: boolean
    navigate?: MayflyPagePath
    key?: string              // with `action`, that action's default key
    semantic?: 'save' | 'copy' | 'delete' | 'refresh' | 'external' | 'search'
    action?: string           // `<owner>.<action>`; `ui.*` is reserved
    hintLabel?: string
  }[]
})

type MayflyConfirmation = {
  title: string
  detail?: string
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'danger'
}
```

激活可用 item 时向 `onEvent.action` 发出包含 `actionId`、`controlId` 与 `pagePath`
的 `activate`。`disabled` 和
`busy` item 不可激活；`busy` 同时表达进行中呈现，并让光标停留在运行中的 action 上。
disabled item 会在标签旁显示 `disabledReason`。带 `confirm` 的 action 需要在共享
default-No decision 中明确选择 Yes，Escape、Ctrl+C 或 No 返回原 surface。结构化的
`confirm` 可以附加一句说明后果的 `detail`、自定义 `confirmLabel`/`cancelLabel` 按钮文字
以及 `tone: 'danger'`；按钮顺序始终是先 No（默认聚焦）后 Yes。请使用它，而不要自行
绘制 Yes/No overlay。

`key` 声明 surface 聚焦时触发该 action 的快捷键。它必须是 key id（`ctrl+r`、
`alt+enter`、`f5`、`q`）；共享导航键（Enter、Escape、Tab、Shift+Tab、Space、方向键、
Page/Home/End、Alt+Left/Right、Backspace、Ctrl+C、Ctrl+E、Ctrl+U）被保留；同一页
内每个键只能绑定一次；在含可筛选列表的 surface 上，纯字符键会被拒绝，因为它会吞掉
筛选输入。文本字段聚焦时纯字符快捷键不会触发，输入会直接开始编辑。列表筛选进行中，
组合键快捷键仍然有效。`intent` 只表达
语义优先级，具体样式由主题决定。外层 `actions.id` 标识这组 action；事件的
`controlId` 使用被激活 item 的 `id`。两张截图渲染的都是这个节点：

```ts
ui.actions({
  id: 'session-actions',
  items: [
    { id: 'save', label: 'Save', intent: 'primary' },
    { id: 'archive', label: 'Archive', intent: 'secondary' },
    { id: 'discard', label: 'Discard', intent: 'danger', confirm: 'Discard all changes?' },
  ],
})
```

在 danger 项上按 Enter 后进入共享 Yes/No decision，默认焦点为 No；只有 Yes 才发出
原 action：

![`actions` 的待确认状态](/shots/actions-confirm.svg)

*待确认：`Discard all changes?` 显示为默认 No 的共享 decision（宽度 64）。*

`busy` 表示进行中，`disabled` 表示不可用，两者都不可激活：

![`actions` 的 busy 与 disabled](/shots/actions-busy.svg)

*busy 项以省略号呈现进行中状态，disabled 项保留但不可激活（宽度 64）。*

```ts
ui.actions({
  id: 'session-actions',
  items: [
    { id: 'deploy', label: 'Deploy', intent: 'primary', busy: true },
    { id: 'retry', label: 'Retry', disabled: true },
    { id: 'cancel', label: 'Cancel' },
  ],
})
```

行操作可以声明它的含义，而不是固定某个键。`semantic` 声明一个通用含义，item 随该含义的
当前绑定触发：`delete` 默认是 `x`，用户重绑 `ui.delete` 后，所有面板的删除键一起改变。
声明含义的 item 不能再带 `key` 或 `action`，其默认键同样受上面的页面规则约束，因此
`copy`（`c`）、`delete`（`x`）和 `refresh`（`r`）不能与输入即筛选的列表同页。`action`
命名一个组件动作 `<owner>.<action>`（`ui.*` 命名空间归 core 所有），`key` 是它的默认键；
Mayfly 会列出见过的动作供用户重绑，提示行和按钮都跟随生效的键。`hintLabel` 是提示行中
键后显示的词（缺省时用标签）。

`scope` 指定同一页或外层页上的一个或多个控件：只有当其中之一（或其中的行、字段、标签）
获得焦点时，这组键才生效并显示提示。同一页上的两组 action 只有在 scope 指向不同控件时
才能绑定同一个键。下面的列表只在自身获得焦点时响应 `x` 和 `t`：

![带命名行操作键的 `actions`](/shots/actions-named.svg)

*隐藏的通用含义与组件动作，作用域限定在它们操作的列表上（宽度 64）。*

```ts
ui.stack.column([
  ui.list({ id: 'providers', role: 'browse', selectedIds: [], items: [
    { id: 'production', label: 'production', detail: 'api.example.com' },
    { id: 'staging', label: 'staging', detail: 'staging.example.com' },
  ] }),
  ui.actions({ id: 'provider-keys', scope: 'providers', items: [
    { id: 'remove', label: 'Remove', semantic: 'delete', hidden: true, hintLabel: 'remove', confirm: 'Remove the provider?' },
    { id: 'test', label: 'Test connection', action: 'acme-providers.test', key: 't', hidden: true, hintLabel: 'test' },
  ] }),
])
```

### `prompt`

![`prompt` 节点渲染效果](/shots/prompt.svg)

*带两个标记和一段草稿的提示符，放在编辑器使用的右上标题 surface 中（宽度 64）。*

```ts
ui.prompt(options: {
  id: string
  symbol?: string                      // 默认 '> '
  symbolTone?: MayflyTone
  value?: string                       // 控件初始的草稿
  tokens?: { id: string, label: string, size?: string }[]
  recall?: { kind: 'queued' | 'history', text: string }[]
  recallLabel?: string                 // 默认 'history'
  placeholder?: string | string[]      // 阶梯，从长到短
  completions?: { items: { id: string, label: string, detail?: string, right?: string }[] }
  reset?: { rev: number, value: string }
  submitLabel?: string                 // 默认 'send'
  autofocus?: boolean
})
```

提示符是唯一不属于字段的文本控件。第一行依次是符号、标记和缓冲区；缓冲区就是终端编辑器，
所以 kill ring、撤销、粘贴折叠和输入法的行为与主编辑器一致。标记写作 `[label size ×]`，
被选中时反色。多行缓冲区的后续行位于符号之下。草稿由 core 保存在 surface 模型中，因此重新发布、
切换主题或 core 重载都不会丢失已输入的内容；节点的 `value` 只是草稿的起点。

![`prompt` 占位阶梯](/shots/prompt-placeholder.svg)

*显示放得下的最长占位变体（宽度 40）。*

缓冲区和标记都为空时，占位文字以弱化的文本色显示在光标之后。数组是从长到短的阶梯，
显示放得下的最长变体，所以每个变体都应写成完整的触发词。纯字符串会逐段丢弃末尾的 ` · ` 段。
有任何文本、标记或多行缓冲区时占位文字隐藏；极窄的行只会截断最短的变体。

![`prompt` 补全列表](/shots/prompt-completions.svg)

*打开的补全列表及其按键行（宽度 64）。*

`completions` 在缓冲区下最多显示五行，形如 `→ label — detail`，焦点行加粗，放得下时 `right`（例如命令的按键）
靠右对齐。`↑`/`↓` 移动光标，`Tab` 或 `Enter` 发送带该行 `itemId` 的 `completion-accept`，`Esc`
隐藏列表（`completion-dismiss`），直到行或文本变化。宿主通过发布新节点（通常带 `reset`）完成插入。
把提示符放进设置了 `hint: 'completions'` 的 `surface`，按键行只在列表打开时显示。

![`prompt` 历史回溯](/shots/prompt-recall.svg)

*空提示符上按两次 `↑`（宽度 64）。*

缓冲区为空或已是某条回溯内容时，`↑`/`↓` 遍历 `recall`：排队的消息在前，从新到旧；右上角显示
`↑ history 2/3`，回溯的文本成为草稿。越过最新一条再按 `↓` 会恢复之前的草稿。每一步发送观察事件
`recall-change`（`source` 为 `queued`、`history` 或 `draft`，`index` 是 `recall` 中的位置，草稿为 `-1`）。
宿主撤回已回溯的排队消息时，重新发布去掉它的 `recall`，遍历位置保持不变。

提示符获得焦点时的按键：

| 按键 | 作用 |
| --- | --- |
| 输入、`←`/`→`、`Home`/`End`、`Ctrl+K`、`Ctrl+Y` 等 | 终端编辑器自己的编辑 |
| `Enter` | 发送：`submit` 动作 |
| `Alt+Enter`、`Ctrl+J` | 插入换行 |
| 空缓冲区上的 `Backspace` | 第一次选中最后一个标记，第二次删除它（`token-remove`）；其他任何键都会取消选中 |
| 空缓冲区上的 `↑` / `↓` | 遍历 `recall` |
| 补全列表打开时的 `Tab` / `Enter` / `Esc` / `↑` / `↓` | 接受、接受、隐藏、移动 |
| `Esc`、`Ctrl+C` | 与其他控件一样离开 surface |

可打印按键总是进入缓冲区，所以 surface 上其他位置的字母快捷键在提示符有焦点时不会触发；带修饰键的快捷键仍然有效。
按键行用 `submitLabel` 命名 `Enter`，并显示 `Alt+Enter newline`，以及适用时的历史回溯按键对。

事件：`value-change`（观察事件；`formId` 为提示符 `id`，`controlId` 为 `text`）、`recall-change`（观察事件），
以及动作 `token-remove`（`tokenId`）、`completion-accept`（`itemId`）、`completion-dismiss` 和 `submit`。
`submit` 携带一个 submission，其中有一个以提示符 `id` 为地址的表单，字段为 `text` 与 `tokens`（标记 id）；
草稿随即清空，宿主像对表单一样答复，通常是带新节点（已清空的标记、更新后的 `recall`）的 `accepted`。
`reset` 对每个新的 `rev` 只替换一次草稿，宿主用它插入补全或恢复草稿。

限制：草稿、回溯消息和 reset 在每棵树中合计 100,000 个字符，不计入整棵树 20,000 字符的文本预算；
最多 50 个标记（`id`、`label`、`size` 各最多 64 个字符）、8 个占位变体（每个最多 200 个字符）、
最多 8 个字符的 `symbol`，`recallLabel` 与 `submitLabel` 最多 24 个字符。`prompt` 可用于 pane 和 overlay，
不是 status 或 editor extension 节点。

## 焦点与上下文提示

TUI 通过同一套键位语法从 canonical control 角色推导操作，并用同一套语法生成提示行，
插件不应在 surface footer 里重复写通用按键教学：

- `Tab` / `Shift-Tab` 在控制组间移动（在 tab 条上会下钻到当前页内容），记住组内
  焦点，并顺路提交文本与打开的选择器；在 form 或 action 行内逐个控件移动。
- `↑` / `↓` 在行与字段间移动，永远不改值。`←` / `→` 沿 action 行和 tab 条移动、调整
  聚焦的 select 或行内 segment、展开或折叠树节点。`Alt+←` / `Alt+→` 可在任意位置切换
  tab；向导向前切换时会校验离开的步骤。
- 移动不循环，disabled item 不可聚焦。single list 用 `Enter` 激活，multiple list
  用 `Space` 切换、`Enter` 确认，action 用 `Enter` 或 `Space`。
- Escape 每次只退一层，所有 surface 一致：先取消打开的选择器，再结束文本编辑
  （草稿保留），再结束进行中的搜索（query 保留），有 `backId` 的页面返回上一页，
  再把焦点还给 surface 的第一个控件（`Esc back`），最后关闭 surface。tab 条不是退出途中的一站。Ctrl+C 请求同样的关闭。
- 待确认时提示切换为 `Enter confirm · Esc cancel`；只读 scroll 可聚焦，支持方向键、
  Page、Home 与 End，并可用 Ctrl+E 展开到整个框。

该行只在当前 plugin pane 获得焦点或 capturing overlay 打开时显示，并且只列出当前状态下
有效的键。只要 Escape 有作用就一定显示；被动 pane 和 non-capturing overlay 不会显示伪操作。
80 列以下最多显示三个片段、80 列起最多四个，窄屏先缩成完整按键 token，再整段隐藏，
不会截断半条指令。局部计数、进度、风险和业务状态仍可放在 footer。

### 主动弹出的 overlay 的预备延迟

插件在用户没有要求时弹出的 overlay（审批、计划评审、权限请求）可能恰好落在用户正在敲的按键上。
在定义里设置 `armMs`（0 到 2000 的整数，默认 0）：overlay 首次获得焦点后的这段毫秒内，
除 Escape 以外的所有按键都会被吞掉，误触的 `1` 或 `Enter` 不会选择、授权或提交任何内容。
提示行在这段时间里显示 `… ready in a moment`（中文为“稍候即可操作”），之后 surface 恢复正常。
延迟是固定的墙钟窗口，减少动效设置不会缩短它。Escape 仍然可以关闭，因为关闭从不授权。
决策卡建议约 300 ms；用户主动打开的 surface 不要设置 `armMs`。

```ts
api.overlays.open({ id: 'acme.approve', presentation: 'editor', capturing: true, armMs: 300 }, card)
```

## 反馈与辅助节点

### `loader`

![`loader` 节点渲染效果](/shots/loader.svg)

*默认 gap variant，带 elapsed 提示与 `Esc cancel` 提示（宽度 64）。*

```ts
ui.loader({
  message?: string
  variant?: 'bloom' | 'fill' | 'gap' | 'breath'
  elapsedMs?: number
  cancelActionId?: string
  cancelLabel?: string
})
```

`variant` 默认 `gap`；早先的 `braille` 与 `tide` 仍被接受，画成 `gap`。省略 `message`
时节点只是一个字形。`elapsedMs` 是非负毫秒提示，显示为 `45s`、`2m 10s` 或 `1h 5m`。
动画归 renderer 所有，所有 surface 共用一个时钟，100 ms 一步：`bloom`（`· ✢ ✳ ✶ ✻ ✽`）、
`fill`（盲文条逐格填满再退回）、`gap`（盲文转轮）每个 tick 前进一步；`breath` 是一个 `●`，
在 `primary` tone 的六档明暗里一暗一亮地走，每 400 ms 一档。不要在 `render()` 里启动 timer。
减少动效时所有 variant 停在首帧，ASCII 字形模式下画 `- \ | /`。`cancelActionId` 是提示而不是按钮：
loader 下面一行写着 `Esc cancel`（或 `Esc` 加小写的 `cancelLabel`），`Esc` 在离开 surface 之前先为该 action
发出 `activate`，焦点在这一行时按 `Enter` 同样如此。上面的截图渲染的就是这个节点：

```ts
ui.loader({
  message: 'Waiting for model',
  elapsedMs: 1200,
  cancelActionId: 'stop',
  cancelLabel: 'Stop',
})
```

四种 variant，各取首帧：

![`loader` 的 variant](/shots/loader-variants.svg)

*`bloom`、`fill`、`gap`、`breath`（宽度 64）。*

```ts
ui.stack.column([
  ui.loader({ variant: 'bloom', message: 'Thinking' }),
  ui.loader({ variant: 'fill', message: 'Working' }),
  ui.loader({ variant: 'gap', message: 'Discovering models', elapsedMs: 12_000, cancelActionId: 'stop' }),
  ui.loader({ variant: 'breath', message: 'Waiting for authorization', elapsedMs: 45_000 }),
])
```

### `empty`

![`empty` 节点渲染效果](/shots/empty.svg)

*带 actions slot 的无数据状态（宽度 64）。*

```ts
ui.empty({
  title: string
  description?: string
  actions?: MayflyActionsNode
})
```

用于空结果或无数据状态。`actions` 必须是 `ui.actions()` 的结果。上面的截图
渲染的就是这个节点：

```ts
ui.empty({
  title: 'No sessions yet',
  description: 'Start one to see it here.',
  actions: ui.actions({
    id: 'empty-actions',
    items: [{ id: 'new', label: 'New session', intent: 'primary' }],
  }),
})
```

### `progress`

![`progress` 节点渲染效果](/shots/progress.svg)

*带 label 与计数的 determinate 进度条（宽度 64）。*

```ts
ui.progress({
  label?: string
  value: number
  max: number
  style?: 'cells' | 'rule'
  width?: number
  tone?: MayflyTone
  showCount?: boolean
  showPercent?: boolean
  transition?: { from: number, ms: number, rev: number }
})
```

`value` 必须是非负整数，`max` 必须是至少 1 的整数；超过 max 的 value 在 admission
时收窄为 max。窄宽度下 renderer 可先隐藏 label 或计数，只保留进度语义。上面的
截图渲染的就是这个节点：

```ts
ui.progress({ label: 'Tokens', value: 12_000, max: 28_000 })
```

既不写 `style` 也不写 `width` 的进度条，像上面一样用局部方块铺满整行。写了其中之一就
采用 kit 外观：`style: 'cells'`（此时的默认）用 `▰` 表示已完成、`▱` 表示剩余，共 `width` 格（10），
带 label、`n/N`（`showCount: false` 关闭）与 `showPercent`。`style: 'rule'` 画标题规则线，
`━` 表示已完成、`─` 表示剩余，共 `width` 格（24），后面不带文字。`tone` 给已完成部分上色（默认
`primary`）。`transition` 是 renderer 持有的一次性动画：其 `rev` 第一次到达时，进度条在动画时钟上
用 `ms` 毫秒从 `from` 线性退到 `value`，然后静止；减少动效或没有时钟时直接显示 `value`。
status 节点不接受 transition：

![`progress` 的样式](/shots/progress-styles.svg)

*带计数的 cells、带百分比的 cells，以及标题规则线（宽度 64）。*

```ts
ui.stack.column([
  ui.progress({ label: 'Building', value: 6, max: 10, style: 'cells', width: 10 }),
  ui.progress({ value: 9, max: 10, width: 10, showCount: false, showPercent: true }),
  ui.progress({ style: 'rule', value: 2, max: 8, width: 24 }),
])
```

### `spacer`

![`spacer` 节点渲染效果](/shots/spacer.svg)

*两个文本锚点之间的一行语义留白（宽度 48）。*

```ts
ui.spacer(options?: { size?: 1 | 2 })
```

插入语义留白，默认 size 为 1。不要用包含空格的 text 模拟布局。`ui.spacer()`
自身只产生空行，所以截图用两个 text 锚点把它夹在中间——渲染的就是这个节点：

```ts
ui.stack.column([
  ui.text('Above'),
  ui.spacer(),
  ui.text('Below'),
])
```

### `divider`

![`divider` 节点渲染效果](/shots/divider.svg)

*不带 label 的分隔线（宽度 48）。*

```ts
ui.divider(options?: { label?: string })
```

插入带可选 label 的语义分隔线；renderer 负责使用分配宽度绘制。上面的截图
渲染的就是这个节点：

```ts
ui.divider()
```

### `image`

![`image` 节点渲染效果](/shots/image.svg)

*字节尚未到达的图片，显示为它的 `alt`（宽度 48）。*

```ts
ui.image(options: { attachmentId: string, alt: string, maxRows?: number })
```

在内容中内联一张图片。wire 只携带引用，不携带字节：宿主树提供一个 loader，把
`attachmentId` 解析为编码后的字节及其媒体类型，renderer 再通过终端的图像协议绘制，
高度最多 `maxRows` 行。`alt` 是文本回退，例如 `[Image #1 84 KB]`；字节到达之前、
没有 loader 认识该 id 时，以及终端没有图像协议时都显示它。它是一行弱化文本，
按分配宽度截断。

`image` 可用于普通 pane 和 overlay，不是 status、editor extension 或
`sections.body` 节点。上面的截图渲染的就是这个节点，截图宿主没有 loader：

```ts
ui.image({ attachmentId: 'att-1', alt: '[Image #1 84 KB]', maxRows: 12 })
```

## 状态栏第 2 行的视图

`placement: 'views'` 的 pane 是一个**视图**：状态栏第 2 行里的一小段摘要，可以打开自己的面板。视图 lane 没有自己的行：
每个摘要与状态条目一起进入第 2 行；进入某个视图后，它的面板在所有视图的标签条下取代第 2 行。

```ts
export const inject = ['mayflyPanes']

export function apply(ctx: Context): void {
  const view = ctx.mayflyPanes.register({
    id: 'acme.builds',
    title: 'Builds',          // 标签
    placement: 'views',
    priority: 50,             // 越小在行和标签条中越靠前
    summary: { node: ui.richText([{ text: 'Builds ', tone: 'muted' }, { text: '2 running', tone: 'accent' }]), count: 2 },
    onEvent: { action: () => ({ kind: 'completed' }) },
  }, ui.list({ id: 'builds', role: 'browse', selectedIds: [], items: [{ id: 'main', label: 'main' }] }))

  // 更新第 2 行无需重发面板；null 让该视图离开第 2 行。
  view.setSummary({ node: ui.richText([{ text: 'Builds 1 running' }]), count: 1 })
  view.setSummary(null)
}
```

![视图在状态栏第 2 行中的 `summary` 节点](/shots/views-summary.svg)

*示例视图的摘要在状态栏第 2 行中的样子（宽度 48）。*

| 字段 | 规则 |
| --- | --- |
| `summary.node` | 非交互 status 节点（`text`、`richText`、`fields`、`progress` 或它们的 stack），与其他 status 条目同样准入；一行，无动效 |
| `summary.count` | 数字或不超过 32 个字符的字符串；标签在标题后显示（`Agents 5`） |
| `title` | 标签文字；缺省为 id |
| `size`、`narrow` | 不适用；views pane 设置任一项都会被拒绝 |
| 其他 placement 上的 `summary` | 被拒绝；只有 views pane 有 summary 和 `setSummary` |

`set(node)` 发布面板；`onEvent`、`load`、`refresh`、`loadMore` 与其他 pane 相同，面板里的动作只会到达它所在视图的
`onEvent`。没有 summary 的视图不出现在第 2 行；有 summary 但尚无面板的视图显示在行中，但不能进入。进入后的 lane
最多占终端行数的三分之一；视图多于一个时，面板自己的提示行会写出 `←/→ tabs`。

| 键 | 效果 |
| --- | --- |
| 空提示符处 `Alt+↓` 或 `F5` | 进入第一个视图 |
| `F6` / `Shift+F6` | 先进入视图，再依次进入可交互的 pane；越过两端回到提示符 |
| `←` / `→` | 切换视图（正在编辑的字段保留方向键） |
| `Esc` | 面板退出自己的各层后回到提示符 |

它们是命名动作 `ui.focus-next`、`ui.left`/`ui.right` 与 `ui.cancel`，重绑定会同时移动这些键及其提示。可运行的视图见
[`ui-gallery`](https://github.com/Ephemeral-AI-Lab/mayfly/tree/main/examples/ui-gallery) 示例。

## 模式（Patterns）

`patterns`（来自 `@ephemeral-ai/mayfly-ui`）提供四个由 builder 组合而成的模式，Mayfly 自己的面板用它们，插件也可以用同样的方式调用。
模式是纯函数：返回一棵普通的、深度冻结的节点树，只由 `ui.*` 调用组成，没有自己的 renderer，也不发布任何东西，
所以结果可以放在任何能放节点的地方（pane、overlay 的 snapshot、回复的 `node`）。它的 props 就是真实 builder 的形状：
列表项、span 和 tab 项都是上文记录的那些，模式从不读取宽度。

### `patterns.decisionPanel`

![`patterns.decisionPanel` 渲染效果](/shots/patterns-decision.svg)

*带预览、选项、备注和隐藏按键的决策卡（宽度 72）。*

```ts
patterns.decisionPanel(props: {
  id?: string                       // 各控件的前缀，默认 'decision'
  title: string
  badges?: MayflyInlineSpan[]
  preview?: MayflyUiNode[]          // 选项上方的只读上下文
  options: MayflyListItem[]
  input?: { id: string, label: string, placeholder?: string }
  instant?: boolean                 // 即使焦点在备注字段旁，数字键也立即选择
  accelerators?: Omit<MayflyActionItem, 'hidden'>[]
  escapeLabel?: 'close' | 'back' | 'cancel' | 'reject' | 'leave'   // 默认 'reject'
  chrome?: 'none' | 'lane' | 'surface' | 'overlay'                  // 默认 'overlay'
}): MayflySurfaceNode
```

返回 overlay 边框的 surface，其中依次是预览节点、获得焦点的 `choose` 列表（`<id>.options`，带编号）、
可选的单行表单（`<id>.input`）和所有项都隐藏的 actions 节点（`<id>.keys`）。第一个选项是最常见的授权并持有光标，
所以 `Enter` 直接选它；数字键按位置选择（列表持有焦点时，设置 `instant` 则在面板任何位置）；`Esc` 表示拒绝。
加速键在面板上任何位置都会运行，但备注字段持有焦点时除外，此时该键是字段的文本。选择结果以带选项 id 的
`selection-accept` 事件到达。

主动弹出时请带上预备延迟：`patterns.decisionArmMs` 为 300，卡片弹出时误敲进编辑器的 `1` 或 `Enter` 不会选择任何内容
（见上文“预备延迟”）。

```ts
patterns.decisionPanel({
  title: 'Delete branch?',
  badges: [{ text: '1 of 2 waiting', tone: 'muted' }],
  preview: [ui.text('feature/old-hero · 3 unmerged commits', { tone: 'muted' })],
  options: [
    { id: 'keep', label: 'Keep the branch' },
    { id: 'delete', label: 'Delete it', detail: 'cannot be undone' },
  ],
  input: { id: 'why', label: 'Note', placeholder: 'optional' },
  accelerators: [{ id: 'copy', label: 'Copy name', key: 'c', hintLabel: 'copy name' }],
})
```

```ts
api.overlays.open({ id: 'acme.delete', presentation: 'editor', capturing: true, armMs: patterns.decisionArmMs }, card)
```

### `patterns.railPanel`

![`patterns.railPanel` 渲染效果](/shots/patterns-rail.svg)

*工作区标签栏，右侧是当前标签的实时列表（宽度 72）。*

```ts
patterns.railPanel(props: {
  title: string
  badges?: MayflyInlineSpan[]
  rail: { id: string, activeId: string, items: MayflyTabItem[], hintLabel?: string }
  content: MayflyUiNode | Record<string, MayflyUiNode>
  railWidth?: number                // 默认 26
  escapeLabel?: 'close' | 'back' | 'cancel' | 'reject' | 'leave'
}): MayflySurfaceNode
```

左侧是竖直的 `tabs` 标签栏（`railWidth` 列，不会被压缩），右侧是内容，两者间隔两列。以标签栏项 id 为键的 record
让每个标签有自己的页面，并用 `tab` 与标签栏关联，所以切换标签不需要重新发布，每页保留自己的光标和草稿。
单个节点则是当前标签的内容，由插件根据 `tab-change` 事件重新构建。

```ts
patterns.railPanel({
  title: 'Workspaces',
  rail: { id: 'rail', activeId: 'work', items: [
    { id: 'work', label: 'work/mayfly', count: 8 },
    { id: 'site', label: 'website', count: 5 },
  ] },
  content: {
    work: ui.list({ id: 'ws.work', role: 'browse', marker: 'selection', selectedIds: [], items: [{ id: 'a', label: 'Fix login redirect', right: [{ text: '2h', tone: 'muted' }] }] }),
    site: ui.list({ id: 'ws.site', role: 'browse', marker: 'selection', selectedIds: [], items: [{ id: 'b', label: 'Docs sync', right: [{ text: '1d', tone: 'muted' }] }] }),
  },
})
```

### `patterns.splitView`

```ts
patterns.splitView(props: {
  list: MayflyUiNode
  detail: MayflyUiNode
  listWidth?: number                // 默认 58
  breakpoint?: number               // 默认 100
}): MayflyStackNode
```

一个 row：宽度达到 `breakpoint` 列时并排显示列表（`listWidth` 列）和详情，更窄时只显示列表。列表节点在互补的 `when`
条件下出现两次，所以同一个 id 服务两种布局，缩放后光标也保留。页面需要标题时，把结果放进 `stack.column` 或 surface。
用 `focus-change` 观察让详情跟随光标。本文的截图无法绘制 `when` 子节点，`ui-gallery` 示例在 pane 中挂载了该模式。

```ts
patterns.splitView({
  list: ui.list({ id: 'sv', role: 'browse', marker: 'selection', selectedIds: [], items: [
    { id: 'a', label: 'Loop', detail: 'official', right: [{ text: '1.4.0', tone: 'muted' }] },
    { id: 'b', label: 'Git Helper', detail: 'community', right: [{ text: 'update 1.3.0', tone: 'muted' }] },
  ] }),
  detail: ui.fields([
    { label: 'Name', value: [{ text: 'Loop' }] },
    { label: 'Status', value: [{ text: '✓ installed 1.4.0', tone: 'success' }] },
  ]),
})
```

### `patterns.statusPage`

![`patterns.statusPage` 渲染效果](/shots/patterns-status.svg)

*三个标签下的只读页面（宽度 72）。*

```ts
patterns.statusPage(props: {
  title: string
  badges?: MayflyInlineSpan[]
  tabs: Omit<MayflyTabsNode, 'kind'>
  rows?: MayflyField[]              // 键值行
  body?: MayflyUiNode               // 代替 rows
  pages?: Record<string, MayflyUiNode>   // 每个 tab id 一页
  footer?: MayflyUiNode
}): MayflySurfaceNode
```

overlay 边框的 surface：标签条、一个空行和页面内容。需要提供 `rows`、`body` 或 `pages` 之一，都不给会抛出 `TypeError`。
与标签栏一样，`pages` 把一个节点关联到每个标签，切换标签不需要重新发布；`rows` 和 `body` 则由插件在 `tab-change` 时重建。

```ts
patterns.statusPage({
  title: 'Status',
  tabs: { id: 'st', activeId: 'overview', items: [
    { id: 'overview', label: 'Overview' },
    { id: 'usage', label: 'Usage' },
    { id: 'account', label: 'Account', attention: true },
  ] },
  rows: [
    { label: 'Provider', value: [{ text: 'DeepSeek' }] },
    { label: 'Balance', value: [{ text: '⚠ ¥ 6.20', tone: 'warning' }, { text: ' low balance', tone: 'muted' }] },
  ],
})
```

## 事件与 snapshot 更新

Pane、overlay 和 editor extension 把 handler 放在 definition 上，而不是放进节点：

```ts
onEvent: {
  observe(event: MayflyUiObservationEvent, context: MayflyUiEventContext) {
    return { kind: 'completed' }
  },
  async action(event: MayflyUiActionEvent, context: MayflyUiEventContext) {
    return { kind: 'completed' }
  },
}
```

| 通道 | 事件 | 用途 |
| --- | --- | --- |
| `observe` | `value-change`、`selection-toggle`、`tab-change`、`focus-change`、`recall-change` | 编辑事实、异步校验与焦点移动（`focus-change` 携带 `controlId` 和 `itemId?`，每帧最多一次）；不能发布、导航或关闭 |
| `action` | `activate`、`selection-accept`、`submit`、`token-remove`、`completion-accept`、`completion-dismiss`、`dismiss` | 原生 effect 与明确结算 |

`context` 包含 `surfaceId`、当前 `source`、`revision`、唯一 `operationId`、
`AbortSignal` 与 `report(feedback)`。同字段观察 latest-wins；同 action boundary
single-flight。replacement、卸载或 abort 会撤销迟到 handler、progress 和 publisher。

Action 必须返回结构化 reply：`accepted` 携带权威 node/source；`invalid` 携带字段
错误；`conflict` 保留草稿并展示新 baseline；`failed` 可携带 partial
`acceptedFields`；`completed` 与 `cancelled` 不发布 snapshot。`feedback`、`navigate`
与成功后的 `dismiss` 是 reply 的可选结构化字段。Core 准入 reply 后调用一次性
publisher，因此插件不在 handler 中调用 `set()` 来确认本次 action。

外部 projection、service subscription 或 timer 改变领域状态时，调用 pane/overlay
handle 的 `set(node, { reason: 'data', source })` 或 editor-extension registration
的对应 `set()`。新的 instance/scope 使用 `reason: 'replace'`。调用方不能传 ack，
也没有 `eventRevision` 兼容参数。

## Surface 兼容矩阵

| Surface | 可用节点 | 交互规则 |
| --- | --- | --- |
| `panes` | 完整 `MayflyUiNode` | controls 可用，事件交给 pane `onEvent` |
| `placement: 'views'` 的 `panes` | 面板为完整 `MayflyUiNode`，摘要为 status 节点 | 进入后面板取代状态栏第 2 行；摘要始终非交互 |
| capturing overlay | 完整 `MayflyUiNode` | 获取焦点并处理 Escape 关闭 |
| non-capturing overlay | 只使用 passive 内容/layout | tabs/list/form/actions/prompt 等 controls 会使整棵渲染树降级为错误提示 |
| additive `status` | text、rich-text、fields、progress、递归 stack | 始终非交互，不接受 surface/scroll/control |
| editor extension | passive content/rich-text/progress/spacer/divider + stack/surface | 交互 action 走 extension decoration 的 `actions` 字段 |

四个 registry 都是 Fiber-owned 的直接 Cordis service，不存在第二套 manifest 或
capability host。

## 验证清单

- 在 120、80、40 列验证所有内容与 responsive branch；不要依赖某个固定坐标。
- 覆盖 disabled、busy、empty、error、loading、abort 和 capability absent fallback。
- 覆盖 consumer unload、owner reload、late event result 与 overlay dismiss。
- 运行 package validator、packed fixture 和 width scan；具体命令见
  [调试与验证](/plugins/testing)。
