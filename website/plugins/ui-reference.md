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
- 所有数值布局字段都是非负 safe integer。`minSize` 不能大于 `maxSize`，viewport
  的最小值不能大于对应最大值。
- tabs/list/form 的 control id、form field id、action item id，以及 form/loader 的
  submit/cancel id 在同一棵交互树中不能产生冲突。Tab/list item id 至少在所属
  节点内唯一；作为 control 的 id 不能为空。
- `tone` 是语义颜色，不是色号：
  `default | muted | accent | success | warning | danger`。
- `emphasis` 是 `normal | strong`；省略时按普通文本处理。

下面的“默认”描述 `0.1.0-alpha.4` 当前 Mayfly TUI。wire contract 只承诺字段语义，
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
ui.text(content: string, options?: { tone?: MayflyTone })
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

### `richText`

![`richText` 节点渲染效果](/shots/richText.svg)

*muted 前缀接 strong accent 模型名（宽度 64）。*

```ts
ui.richText(spans: readonly MayflyInlineSpan[])

type MayflyInlineSpan = {
  text: string
  tone?: MayflyTone
  emphasis?: 'normal' | 'strong'
}
```

在同一段文本中组合 tone 与强调，适合“标签 + 高亮值”这类行内混排。renderer
负责换行，插件不要拼 ANSI。上面的截图渲染的就是这个节点：

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
ui.code(value: string, options?: { language?: string })
```

表达代码或预格式化文本，例如补丁片段、命令输出或配置内容。`language` 是
renderer hint，不保证语法高亮。上面的截图渲染的就是这个节点：

```ts
ui.code([
  'export function estimateTokens(text: string): number {',
  '  // Rough heuristic: four characters per token.',
  '  return Math.ceil(text.length / 4)',
  '}',
].join('\n'), { language: 'ts' })
```

### `diff`

![`diff` 节点渲染效果](/shots/diff.svg)

*多行 before/after：上下文行原样保留，改动行以 `-`/`+` 标出（宽度 64）。*

```ts
ui.diff(before: string, after: string)
```

表达同一内容修改前后的语义对比，例如待确认的编辑。插件提供原始文本，不手工
添加 diff 颜色。上面的截图渲染的就是这个节点：

```ts
ui.diff(
  ['export function connect() {', '  const retries = 3', '  return open(retries)', '}'].join('\n'),
  ['export function connect() {', '  const retries = 5', '  return open(retries)', '}'].join('\n'),
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
  title?: string,
  yLabel?: string,
  height?: number, // 4..20
  categories: readonly string[],
  series: [{ id: string, label?: string, tone?: MayflyTone, values: readonly (number | null)[] }],
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
})
```

`surface` 把标题、徽标、正文和 footer 组合成一个语义容器。

| 字段 | 含义 |
| --- | --- |
| `title` | 主标题 |
| `subtitle` | 标题后的弱化说明行 |
| `badges` | 使用 span tone/emphasis 的徽标行 |
| `chrome` | 边框意图；默认 `none` |
| `padding` | 内容侧留白级别；默认 `0` |
| `child` | 必填正文 |
| `footer` | 可选尾部节点，位于正文与底边之间 |

`chrome: 'overlay'` 只是视觉意图，不会创建 overlay；真正的浮层仍通过
`api.overlays.open()` 打开。若 registration 的根节点就是这种 surface，core 会把
它与 registration title 合并成一个外框。普通 overlay 和
`presentation: 'editor'` 都遵守 `maxHeight`，未声明时最多占终端高度的三分之一；
内容较少时按自然高度显示，不会为了填满上限而拉伸。
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

### `scroll`

![`scroll` 节点渲染效果](/shots/scroll.svg)

*16 行内容放进 8 行 viewport、向下滚动 3 行后的呈现，`scrollbar: true` 的滚动条可见（宽度 56）。*

```ts
ui.scroll(node: MayflyUiNode, options?: {
  id?: string
  follow?: 'none' | 'start' | 'end'
  scrollbar?: boolean
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
  items: readonly {
    id: string
    label: string
    disabled?: boolean
    count?: number
    backId?: string
  }[]
})
```

- `activeId` 必须对应一个 item，是 registration 初始或 data snapshot 的 baseline；
  当前活动页由 Mayfly instance 保留。
- `disabled` item 会显示但不能激活。
- `count` 是非负 safe integer 计数提示，renderer 可在窄宽度隐藏它。
- `mode: 'wizard'` 按已验证 form revision 标记完成步骤；编辑或 conflict 会使标记失效。
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

### `list`

![`list` 节点渲染效果](/shots/list.svg)

*single 模式下选中第一项（宽度 64）。*

```ts
ui.list({
  id: string
  mode?: 'single' | 'multiple'
  role: 'browse' | 'choose'
  selectedIds: readonly string[]
  items: readonly MayflyListItem[]
  filter?: string
  filterable?: boolean
  tree?: boolean
  minSelected?: number
  maxSelected?: number
  acceptActionId?: string
  empty?: MayflyUiNode
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
}
```

`role: 'browse'` 用于打开或检查条目，`role: 'choose'` 用于提交选择。`mode` 默认为
`single`。single mode 最多有一个 `selectedIds`；所有 selected id
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

`filterable: true` 启用共享搜索；`filter` 只提供初始 query。Mayfly 在已给出的 items
上维护匹配和焦点，不触发网络读取。`tree: true` 配合 `parentId` 提供共享展开状态。
大型 items 只校验和绘制当前窗口。items 为空时渲染 `empty`。

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

*常用 field 的默认状态：secret 值被遮蔽，select 显示当前值，toggle 显示开关（宽度 64）。*

```ts
ui.form({
  id: string
  fields: readonly MayflyFormField[]
  submitActionId?: string
  cancelActionId?: string
})
```

Form field 是以下判别联合：

| `kind` | 必填字段 | 可选字段 | `value-change` value |
| --- | --- | --- | --- |
| `input` | `id`、`label`、`value: string` | `placeholder`、`error`、`disabled` | `string` |
| `textarea` | 同 input | 同 input | `string` |
| `secret` | 同 input | 同 input；renderer 遮蔽 value | `string` |
| `number` | `id`、`label`、`value: number \| null` | `min`、`max`、`step`、`unit` | 编辑时为 `string` draft |
| `select` | `id`、`label`、`value: string \| null`、`options: MayflyListItem[]` | `error`、`disabled` | `string \| null` |
| `multiselect` | `id`、`label`、`value: string[]`、`options` | `minSelected`、`maxSelected` | `string[]` |
| `toggle` | `id`、`label`、`value: boolean` | `error`、`disabled` | `boolean` |

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
  submitActionId: 'Create profile',
  cancelActionId: 'Cancel',
})
```

Mayfly frontend instance 保留文本 draft，并向 `onEvent.observe` 发出带 field
revision 的 `value-change`，用于可选的异步校验；插件不应把每次输入回声为 snapshot。
权威 data snapshot 改变时，model 协调未修改值、草稿和冲突。文本字段聚焦后保持
导航态，直接输入或 Enter 才进入编辑；input 编辑态的 Enter 进入下一组，textarea
的 Enter 或 Alt+Enter 插入换行。

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
  submitActionId: 'Create profile',
})
```

Select 的 Enter 打开共享 Choice picker；Left/Right 移动语义焦点，Enter 接受单选，
Space 切换多选。Escape 放弃 picker 并停在当前字段；Tab 同样放弃尚未确认的 picker
调整，但继续移到下一语义组。picker draft 在 renderer 重建期间保留。

下面的 form 在 Theme 字段按下 Enter 进入调整态，再按一次 Right 把候选切到
Light——`‹ Light ›` 就是调整态的呈现：

![`form` 的 select 调整态](/shots/form-select.svg)

*调整态：`‹ Light ›` 是共享 picker 的语义焦点，Enter 后写入 field draft（宽度 64）。*

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
  submitActionId: 'Create profile',
})
```

`error` 在字段下方显示校验信息；`disabled` 字段不进入焦点导航，但仍保留在
提交表单中。`required`、长度、数值与选择约束在 action 开始前统一校验；
`origin` 与 `resetValue` 产生共享 override/reset 工具：

![`form` 的 error 与 disabled 状态](/shots/form-validation.svg)

*Name 带 `error` 校验提示；Email 为 `disabled`，跳过焦点导航（宽度 64）。*

```ts
ui.form({
  id: 'profile-form',
  fields: [
    { kind: 'input', id: 'name', label: 'Name', value: '', error: 'Name is required' },
    { kind: 'input', id: 'email', label: 'Email', value: 'ada@example.com', disabled: true },
  ],
  submitActionId: 'Create profile',
})
```

`submitActionId` 增加提交 control。提交使用声明 action 的 `submit` 地址聚合一个或
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

`cancelActionId` 增加共享关闭 control；dirty form 会先进入默认 No 的丢弃确认。

### `actions`

![`actions` 节点渲染效果](/shots/actions.svg)

*primary、secondary 与带 confirm 的 danger 三种 intent（宽度 64）。*

```ts
ui.actions({
  id: string
  items: readonly {
    id: string
    label: string
    intent?: 'primary' | 'secondary' | 'danger'
    disabled?: boolean
    disabledReason?: string
    busy?: boolean
    confirm?: string
    submit?: readonly MayflyFormAddress[]
    read?: readonly MayflyFormAddress[]
    selections?: readonly MayflySelectionAddress[]
    defaultFocus?: boolean
    dismiss?: boolean
    navigate?: MayflyPagePath
  }[]
})
```

激活可用 item 时向 `onEvent.action` 发出包含 `actionId`、`controlId` 与 `pagePath`
的 `activate`。`disabled` 和
`busy` item 不可激活；`busy` 同时表达进行中呈现。带 `confirm` 的 action 需要在
共享 default-No decision 中明确选择 Yes，Escape/No 返回原 surface。`intent` 只表达
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

## 焦点与上下文提示

TUI 会直接从 canonical control 角色推导操作，插件不应在
surface footer 里重复写通用按键教学：

- 焦点按外层 tabs → 内层 tabs → 内容语义组 → 编辑态逐层下钻。
- tab 条用不循环的 `←` / `→` 移动，`Enter` 下钻；`Tab` / `Shift-Tab`
  在 tab 条上无动作，只在内容层循环语义组并记住组内焦点。
- 内容方向移动不循环；disabled item 不可聚焦。single list 用 `Enter`
  激活，multiple list 用 `Space` 切换、`Enter` 确认，action 用 `Enter` 或 `Space`。
- text/select 进入编辑或调整态后用 `Enter` 确认，非法值保持原字段；`Tab` 保留文本
  draft，但放弃尚未确认的 select 调整并移到下一语义组；Escape 按编辑态 → 内容 →
  内层 tabs → 外层 tabs → 关闭逐层返回。
- 待确认 action 的提示切换为 `Enter confirm · Esc cancel`；只读 scroll 可聚焦，
  支持方向键、Page、Home 与 End。

该行只在当前 plugin pane 获得焦点或 capturing overlay 打开时显示。
可关闭 surface 才会提示 Escape；被动 pane 和 non-capturing overlay 不会显示伪操作。
最多显示三个语义片段，窄屏先缩成完整按键 token，再整段隐藏，不会截断半条指令。
局部计数、进度、风险和业务状态仍可放在 footer。

## 反馈与辅助节点

### `loader`

![`loader` 节点渲染效果](/shots/loader.svg)

*默认 braille variant，带 elapsed 提示与 cancel control（宽度 64）。*

```ts
ui.loader({
  message: string
  variant?: 'braille' | 'tide'
  elapsedMs?: number
  cancelActionId?: string
})
```

`variant` 默认 `braille`。`elapsedMs` 是非负毫秒提示；动画计时仍由 owner 的
生命周期管理，不应由 `render()` 启动 timer。提供 `cancelActionId` 时增加一个
control，并发出 `activate` 事件。上面的截图渲染的就是这个节点：

```ts
ui.loader({
  message: 'Waiting for model',
  elapsedMs: 1200,
  cancelActionId: 'Stop',
})
```

`tide` variant 用波浪字符代替 braille 点阵：

![`loader` 的 tide variant](/shots/loader-tide.svg)

*tide variant（宽度 64）。*

```ts
ui.loader({
  message: 'Syncing dependencies',
  variant: 'tide',
  elapsedMs: 4200,
})
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
ui.progress({ label?: string, value: number, max: number })
```

`value` 必须是非负整数，`max` 必须是至少 1 的整数；超过 max 的 value 在 admission
时收窄为 max。窄宽度下 renderer 可先隐藏 label 或计数，只保留进度语义。上面的
截图渲染的就是这个节点：

```ts
ui.progress({ label: 'Tokens', value: 12_000, max: 28_000 })
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
| `observe` | `value-change`、`selection-toggle`、`tab-change` | 编辑事实与异步校验；不能发布、导航或关闭 |
| `action` | `activate`、`selection-accept`、`submit`、`dismiss` | 原生 effect 与明确结算 |

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
| capturing overlay | 完整 `MayflyUiNode` | 获取焦点并处理 Escape 关闭 |
| non-capturing overlay | 只使用 passive 内容/layout | tabs/list/form/actions 等 controls 会使整棵渲染树降级为错误提示 |
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
