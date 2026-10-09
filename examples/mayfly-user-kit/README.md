# Mayfly example user kit

A publish-shaped, renderer-neutral component kit shared by the header and
right-inspector examples. It imports neither Cordis nor a renderer.

```ts
import { summaryMetric } from '@mayfly-example/user-kit'

const node = summaryMetric.render({ label: 'Context', value: '42%', detail: '12k / 28k' })
```

`approvalCard` is the plugin-side proof of `patterns.decisionPanel`: a grant-first
approval whose overlay sets `armMs: APPROVAL_ARM_MS` so a stray key grants nothing.

```ts
import { approvalCard, APPROVAL_ARM_MS } from '@mayfly-example/user-kit'

const card = approvalCard.render({ title: 'Run command?', command: 'pnpm build', detail: 'in ~/work/mayfly' })
// ctx.mayflyOverlays.open({ id: 'acme.approve', presentation: 'editor', capturing: true, armMs: APPROVAL_ARM_MS }, card)
```

Consumers register their own `mayflyPanes` or `mayflyOverlays` contributions;
installing this kit alone cannot change the UI.
