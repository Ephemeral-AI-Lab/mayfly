# The Compose layer

`@ephemeral-ai/mayfly-ui` exposes one composition layer for every visible Surface: `compose`. It replaces the former
`patterns` recipes and the hand-built overlay shells in Mayfly's command panels.

## Names

| Name | Host | Chrome | Use |
| --- | --- | --- | --- |
| `compose.panel` | `presentation:'editor'` | `overlay` | One command panel: title, subtitle, body, footer, explicit `escapeLabel` |
| `compose.decisionLane` | `presentation:'editor'` | `lane` | Agent requests: approval, plan review, questions, permission |
| `compose.decisionStrip` | current Panel or Views panel | lane surface replacing the body | User-triggered Yes/No; hidden `y`/`n`, `Esc no` |
| `compose.tabs` | inside a panel | none | Horizontal tab strip over arbitrary pages (plugin, stats, provider) |
| `compose.wizard` | inside a panel or lane | none | Step strip, pages, review page; no surface |
| `compose.rail` | inside a panel | none | Vertical rail and one page per label |
| `compose.browser` | inside a panel | none | Wide list + detail; narrow one page at a time |
| `compose.completionPalette` | editor overlay | none | Rows-only completion palette; the host owns filter/keys |
| `compose.statusPage` | inside a panel | none | Tabs and read-only pages |
| `FloatingOverlay` | `presentation:'overlay'` | any | Reserved; product panels use the editor slot |
| `ViewsLane` | status row | lane container | The four status-row views |

`lane` and `overlay` are **chrome**, not hosts. A lane decision occupies the editor slot and replaces the prompt; it is
not a floating overlay. A `DecisionStrip` is a lane surface that replaces the current surface's body, not a nested box.

## Core rules

- The surface node's `title` is authoritative; an overlay definition title is a fallback only.
- All agent requests use `compose.decisionLane`; a user-triggered confirm uses `compose.decisionStrip` with hidden
  `y`/`n` and `Esc no`.
- The Questions DecisionLane sets `coverStatus: true`: it takes the whole editor slot and hides the status row. Every
  other decision lane keeps the status row so the context stays visible.
- Shipped panels are keys-only: no visible Save/Cancel/Sign in/Close buttons. Multi-field forms save with the last
  field's `Enter` and `Ctrl+S`; textarea keeps `Enter` for a newline. `Esc` closes; a dirty form asks first.
- A picker uses `list` choose/segment; a form uses `select`/`multiselect`/`toggle`; a toggle carries `null` for
  unset and `origin`/`resetValue` for inherited values.
- `current: true` is the only current marker: primary label plus `✓`.
- Detail panels are one `compose.panel` each: `compose.rail` for sessions/settings; `compose.browser` for list/detail. Both draw a
  full-height `│` column rule between the panes by default (`separator: false` turns it off).
  no second `.detail`/`.preview`/`.output` overlay.
- A completion palette is rows-only; the editor host owns the filter, focus, and keys.

## Migration order

1. `compose` and core semantics (title, `Esc no`, decision strip, last-field submit, nullable toggle).
2. Decision lanes: approval, plan, questions, permission, shared confirm.
3. Panel + keys-only for pickers, updates, and account panels.
4. Forms/provider/settings rail.
5. Browser/rail detail panels.
6. Completion palette, current markers, deletion of `patterns` and manual shells.

Each round keeps one scenario and one owner acceptance; tests and goldens follow the owner's final effect. The Website
text is updated without a build until the release.

## Live demo

The review scene `composeDemo` plays the merge-panels replay and opens the new panels in order: the `/settings` rail,
the `/plugin` browser, `/tools`, `/jobs`, the shared stop confirmation in the views, `/agents`, `/help`, `/model`,
`/stats`, the settings rail at 70 and 40 columns, and the question DecisionLane answering `1`.

```sh
pnpm run scenario composeDemo
# or headless, into .artifacts/frames/composeDemo-120x40/
pnpm run frame composeDemo
```

It is a live review scene, not a golden (`demo: true` keeps it out of `GOLDEN_SCENARIOS`).
