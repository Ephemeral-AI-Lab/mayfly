# Mayfly example user kit

A publish-shaped, renderer-neutral component kit shared by the header and
right-inspector examples. It imports neither Cordis nor a renderer.

```ts
import { summaryMetric } from '@mayfly-example/user-kit'

const node = summaryMetric.render({ label: 'Context', value: '42%', detail: '12k / 28k' })
```

Consumers register their own `mayflyPanes` or `mayflyOverlays` contributions;
installing this kit alone cannot change the UI.
