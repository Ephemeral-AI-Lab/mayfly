# Mayfly 示例用户 Kit

这是由 header 与 right-inspector 示例共用的可发布形态、renderer-neutral
组件库。它不导入 Cordis 或具体 renderer。

```ts
import { summaryMetric } from '@mayfly-example/user-kit'

const node = summaryMetric.render({ label: 'Context', value: '42%', detail: '12k / 28k' })
```

`approvalCard` 是 `patterns.decisionPanel` 在插件侧的验证：授权优先的审批卡，
其 overlay 设置 `armMs: APPROVAL_ARM_MS`，误触的按键不会授权任何内容。

```ts
import { approvalCard, APPROVAL_ARM_MS } from '@mayfly-example/user-kit'

const card = approvalCard.render({ title: 'Run command?', command: 'pnpm build', detail: 'in ~/work/mayfly' })
// ctx.mayflyOverlays.open({ id: 'acme.approve', presentation: 'editor', capturing: true, armMs: APPROVAL_ARM_MS }, card)
```

消费插件自行向 `mayflyPanes` 或 `mayflyOverlays` 注册贡献；单独安装本 Kit
不会改变界面。
