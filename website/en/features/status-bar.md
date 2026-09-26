# Status bar

The footer uses at most two rows. Every built-in and third-party entry
registers on the same `mayflyStatus` service with a renderer-neutral
`MayflyStatusNode`.

| Entry | Priority | Content |
| --- | --- | --- |
| agent-view | 0 (center) | When an auxiliary exists, show the active side, auxiliary kind/label, and `F7 switch · F8 close` |
| basic | 0 | current model |
| mode | 2 | plan/yolo state |
| goal | 2 | current goal as `Goal <phase> · <rounds>/<max> · <activation>` (phase-colored; hidden with no goal) |
| jobs | 3 | `⏵ N jobs` — live (running/stopping) background-job count; hidden when none |
| cwd | 5 | current working directory |
| git | 10 | branch and change summary |
| context | 20 | latest-step cache hit rate and context occupancy, e.g. `cache 82%  context: 45% (57.6k/128k)`; the `cache` segment is omitted when the provider reports no cache reads |
| title | 30 | session title |

Entries sort by priority/id within a band. The right band yields first under
width pressure. An entry declares `row` and `overflow`; lower-priority
entries hide when space runs out.

Third-party contribution:

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

Registration follows the Fiber. See [plugin status entries](/en/plugins/status).
