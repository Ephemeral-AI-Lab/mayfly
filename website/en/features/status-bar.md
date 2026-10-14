# Status bar

The footer is a single row. Every built-in and third-party entry registers on
the same `mayflyStatus` service with a renderer-neutral `MayflyStatusNode`.
A node may be a shed node (`ui.shed(full, narrower)`) that carries narrower forms.

The session name is not a footer entry — it sits at the right end of the
editor's top border. Bash mode keeps its left-edge `! shell mode` label.

| Entry | Priority | Content |
| --- | --- | --- |
| basic | 0 | current `provider/model`; an explicitly selected thinking effort appends ` Effort` (e.g. `deepseek/step-5-preview Max`), the provider default adds none; it gives up the provider, then the thinking level |
| conversation-view, focus | 1 | While more than one conversation is open, a chip names the displayed one (` main `, ` btw `, ` subagent `); the `F7`/`F8` keys are in the notification pane. While focus is off the prompt, a chip names where it is (` conversation `, ` view `, ` search `) |
| mode | 2 | plan/yolo state, both shown when both are on |
| schedule | 2 | reminder count (hidden with no reminders) |
| context | 6 (right) | latest-step cache hit rate and context occupancy, e.g. `cache 82%  context: 45% (57.6k/128k)`; the `cache` segment is omitted when the provider reports no cache reads; it gives up the cache figure, then the meter |
| cwd | 7 | current working directory; it gives up its depth, down to the last segment |
| git | 10 | branch and change summary; it is the first of the facts to go |
| jobs | 11 | `⏵ N jobs` — live (running/stopping) background-job count; hidden when none |
| goal | 12 | `● goal 2/8 1m 59s` — the mark is the state; hidden with no goal |
| todo | 13 | `● todo 2/12 4m 12s`; hidden with no list |

The facts come first and the items last (jobs, goal, todo, after the directory and git).

The row gives up detail in a set order when it is crowded, before it drops anything: the time of an item, the provider, the
thinking level, the git facts, the directory's depth, the cache figure, the context meter, and last the model. Items are
views: a short summary in the row (`<mark> <name> <n/m> <timer>`), and with `Alt+↓` a heavy line under the item and its
detail panel under the row. An item with nothing to show is absent, so the footer is one line.

The goal's mark is its state: `●` active and armed, `○` active but disarmed (after a resume or fork only a resume continues it: `/goal resume` or `r` in the panel), `⏸` paused, `✕` blocked, and `✓ goal 8/8 12m` for a few seconds once it is complete. The goal's panel shows the objective and a blocked goal's code and reason, with the `/goal` subcommands on single letters named in its hint row (`r` resume, `p` pause, `e` edit, which puts `/goal edit …` in the prompt, and `c` clear, after a confirmation), and a blocked goal also raises a notice. Every goal change and every autonomous round is a row in the conversation (`✓ Goal complete · 2 rounds · 1m 59s`, `── goal round 3 ──`).

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
