# Status bar

The footer has two rows: state above, contextual keys and conversation scope
below. Entries use the same renderer-neutral `mayflyStatus` service.

Open `/settings`, select `mayfly`, and change **Status key hints** (`keyHints`):

The native Save action writes the active profile configuration and updates the
hints immediately. With Harness 0.1.7 this is the profile's `cordis.patch.yml`;
legacy `settings.yaml` is a startup migration input.

| Value | Behavior |
| --- | --- |
| `full` (default) | Show contextual keys such as `Ctrl+O expand`, `Shift+Tab exit plan`, `Alt+M model`, and `/help keys` |
| `minimal` | Keep interrupt/take-back, disclosure, and conversation switching cues |
| `off` | Hide the built-in second row and empty-editor teaching text |

Changes apply immediately. Capturing panels provide their own keyboard hints.
The editor's border carries the session title; input and session modes appear
as separate bold `PLAN`, `PLAN…`, `YOLO`, and `SHELL` chips on row 1.

| Entry | Priority | Content |
| --- | --- | --- |
| scope / switch | 0 / 1 (row 2) | Conversation identity on the left; `F7 switch` and `F8 close` for BTW or `F8 detach` for subagents on the right |
| basic | 0 | current model; an explicitly selected thinking effort appends ` Effort` (e.g. `step-5-preview Max`), the provider default adds none |
| mode | 1 | Independent plan, permission, and shell mode chips |
| goal | 2 | current goal as `Goal <phase> · <rounds>/<max> · <activation>` (phase-colored; hidden with no goal) |
| schedule | 2 | reminder count (hidden with no reminders) |
| jobs | 3 | `⏵ N jobs` — live (running/stopping) background-job count; hidden when none |
| context | 4 (right) | latest-step cache hit rate and context occupancy, e.g. `cache 82%  context: 45% (57.6k/128k)`; the `cache` segment is omitted when the provider reports no cache reads |
| cwd | 5 | current working directory |
| git | 10 | branch and change summary |

Entries are admitted in priority/id order across the whole row when space is
short. Core reserves space for the highest-priority mode and switching entries. An entry takes its full width when it fits, an entry declared
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

![Status hint setting](/shots/app-settings.svg)
