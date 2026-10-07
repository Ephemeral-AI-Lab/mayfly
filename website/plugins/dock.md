# Pane 与 Overlay

## Pane

`mayflyPanes` 支持 `header`、`left`、`right`、`bottom` 四个 placement，另有 `views`，用于状态栏第 2 行的视图（见[状态栏第 2 行的视图](/plugins/ui-reference#状态栏第-2-行的视图)）。

```ts
export const inject = ['mayflyPanes']

export function apply(ctx: Context): void {
  const pane = ctx.mayflyPanes.register({
    id: 'acme.inspector',
    title: 'Inspector',
    placement: 'right',
    size: { min: 20, preferred: 30, max: 40 },
    narrow: 'bottom',
  }, { kind: 'text', content: 'healthy' })

  // 领域状态变化后调用：
  pane.set({ kind: 'text', content: 'updated' })
}
```

`narrow` 可设为 `bottom`、`overlay` 或 `hidden`。`set(null)` 会释放 lane，
直到下一次发布非 null snapshot。

`size` 对 `left`/`right` pane 计列数，对 `bottom` pane 计行数。所有 bottom pane
叠放在同一个 dock 中，dock 最多占终端高度的三分之一：从最靠近编辑器的 pane
开始，每个 pane 先得到 `size.min` 行（默认 1，即开头那一行），剩余行再轮流分配，
不超过 `size.max`。分到的行数少于渲染行数的 pane 保留开头，末行显示灰色的
`… +K more rows`，因此请把最重要的一行放在最前面。多个被动 bottom pane 都以普通
`divider` 开头时，dock 只画一条分隔线。紧凑行建议使用 `overflow: 'truncate'`，
避免一条内容占用两行 dock。

### 视图

`views` pane 没有自己的 lane：它声明一个进入状态栏第 2 行的 `summary`，并用 `setSummary()` 更新（`null` 让视图离开该行）。
`set(node)` 发布面板；用 `Alt+↓`、`F5` 或 `F6` 进入该视图后，面板取代第 2 行。`size` 与 `narrow` 不适用。

## Overlay

```ts
export const inject = ['commands', 'mayflyOverlays']

export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'health',
    description: 'Open health details',
    handler: () => {
      ctx.mayflyOverlays.close('acme.health')
      ctx.mayflyOverlays.open({
        id: 'acme.health',
        title: 'Health',
        capturing: true,
        anchor: 'center',
        width: '70%',
      }, { kind: 'text', content: 'healthy' })
      return { kind: 'success', text: 'opened health details' }
    },
  })
}
```

Capturing overlay 取得 focus，默认可由 Escape 关闭；只有显式
`dismissible: false` 才禁用。非 capturing overlay 不得包含交互控件。

Pane/overlay id 在 registry 内唯一。Snapshot 与 event callback 产生的数据仍会
经过 core admission。Fiber unload 会移除 pane，并关闭该 Fiber 打开的 overlay。
