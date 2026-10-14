# Status bar

The footer is a single row. Every built-in and third-party entry registers on
the same `mayflyStatus` service with a renderer-neutral `MayflyStatusNode`;
an entry may still declare `row: 2` to take a second row of its own.

The session name is not a footer entry — it sits at the right end of the
editor's top border. Bash mode keeps its left-edge `! shell mode` label.

| Entry | Priority | Content |
| --- | --- | --- |
| conversation-view | 1 | While more than one conversation is open, a chip names the displayed one (` main `, ` btw `, ` subagent `); the `F7`/`F8` keys are in the notification pane |
| basic | 0 | current `provider/model`; an explicitly selected thinking effort appends ` Effort` (e.g. `deepseek/step-5-preview Max`), the provider default adds none; it is cut by the width, not dropped |
| mode | 2 | plan/yolo state |
| schedule | 2 | reminder count (hidden with no reminders) |
| jobs | 3 (row 2) | `⏵ N jobs` — live (running/stopping) background-job count; hidden when none |
| context | 4 (right) | latest-step cache hit rate and context occupancy, e.g. `cache 82%  context: 45% (57.6k/128k)`; the `cache` segment is omitted when the provider reports no cache reads |
| cwd | 5 | current working directory |
| git | 10 | branch and change summary |

The status area is two rows. Row 1 (above) carries facts. Row 2 carries the **items** — jobs, goal, and todo — each as `<mark> <name> <n/m> <timer>` (`● todo 2/12 4m 12s`, `● goal 2/8 1m 59s`, `⏵ 1 job`) in one fifth of the row, cut with `…`; an item with nothing to show is absent, and with none row 2 is absent too, so the footer is one line by default. `Alt+↓` opens an item's detail panel under row 2, with a heavy line under the item.

The goal's mark is its state: `●` active and armed, `○` active but disarmed (after a resume or fork only a resume continues it: `/goal resume` or the panel's Resume button), `⏸` paused, `✕` blocked, and `✓ goal 8/8 12m` for a few seconds once it is complete. The goal's panel shows the objective and a blocked goal's code and reason, with the `/goal` subcommands on single letters named in its hint row (`r` resume, `p` pause, `e` edit, which puts `/goal edit …` in the prompt, and `c` clear, after a confirmation), and a blocked goal also raises a notice, and every goal change and every autonomous round is a row in the conversation (`✓ Goal complete · 2 rounds · 1m 59s`, `── goal round 3 ──`).

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
