# Status bar

The footer is a single row. Every built-in and third-party entry registers on
the same `mayflyStatus` service with a renderer-neutral `MayflyStatusNode`;
an entry may still declare `row: 2` to take a second row of its own.

The session name is not a footer entry — it sits at the right end of the
editor's top border. Bash mode keeps its left-edge `! shell mode` label.

| Entry | Priority | Content |
| --- | --- | --- |
| agent-view | 0 (center) | When an auxiliary exists, show the active side, auxiliary kind/label, and `F7 switch · F8 close` |
| basic | 0 | current model |
| mode | 2 | plan/yolo state |
| goal | 2 | current goal as `Goal <phase> · <rounds>/<max> · <activation>` (phase-colored; hidden with no goal) |
| schedule | 2 | reminder count (hidden with no reminders) |
| jobs | 3 | `⏵ N jobs` — live (running/stopping) background-job count; hidden when none |
| context | 4 (right) | latest-step cache hit rate and context occupancy, e.g. `cache 82%  context: 45% (57.6k/128k)`; the `cache` segment is omitted when the provider reports no cache reads |
| cwd | 5 | current working directory |
| git | 10 | branch and change summary |

Entries are admitted in priority/id order across the whole row when space is
short: an entry takes its full width when it fits, an entry declared
`overflow: 'hide'` drops out instead of truncating, and once the row is full
later entries are dropped. Admitted entries then lay out in their declared
left/center/right band.

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
