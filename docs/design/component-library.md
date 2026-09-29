# Mayfly UI component library

This catalog maps the refinements proposed in [PR #84](https://github.com/Ephemeral-AI-Lab/mayfly/pull/84)
to their implementation. It replaces the proposal's target diagrams with the
current contracts and behavior. The executable authority is
[contracts.ts](../../packages/ui/src/contracts.ts), core admission, and the
owning tests. [Interaction model](../interaction-model.md) defines keyboard
routing and lifetimes; the [UI reference](../../website/en/plugins/ui-reference.md)
documents the complete builder API and rendered examples.

## Ownership

```text
plugin -> frozen ui.* node -> Mayfly UI service -> core validator/compiler
plugin <- structured settlement/observation <- shared keyboard grammar
```

Plugins contribute through `mayflyPanes`, `mayflyStatus`, `mayflyOverlays`,
and `mayflyEditorExtensions`. They own native service calls and exact-Agent
scope. Wire nodes carry data, never callbacks, terminal coordinates, raw keys,
ANSI, or domain objects. Core owns painting, layout, keys, and focus. Frontend
interaction state retains drafts, pending decisions, and transcript navigation
across core reload. Renderers do not reconstruct a domain store.

## Status and editor

The first row presents model, effort, mode chips, and other state. The second
row presents conversation scope, contextual keys, and switching. Each entry
uses its declared priority and band; low-priority content drops first.

```text
╭──────────────────────────────────────────── Session title ╮
│ > Ask anything · / commands · @ files · # skills · ! shell │
╰───────────────────────────────────────────────────────────╯
deepseek-chat High  PLAN                      context: 45%
Ctrl+O expand · Shift+Tab exit plan · Alt+M model · /help keys
```

The example assumes a foldable transcript and plan mode. Actual hints follow
the displayed conversation, editor focus, current draft, request state, live
keymap, and available width. Capturing panels show their own grammar hints.
Mode chips are independent: `PLAN` uses accent, `YOLO` warning, and `SHELL`
the semantic `shell` tone. A pending plan toggle shows `PLAN…`.

`/settings` → `mayfly` → **Status key hints** changes the presentation live:

| `mayfly.keyHints` | Behavior |
| --- | --- |
| `full` (default) | All applicable status cues and empty-editor teaching text |
| `minimal` | Essential interrupt/take-back, disclosure, and conversation switching cues |
| `off` | No built-in second-row entries or empty-editor teaching text |

Queue recall belongs to the queue header and appears only when the empty
normal prompt can actually recall a message. Slash completion owns its footer.
Argument hints take precedence over the empty-editor placeholder. Placeholder
variants drop whole triggers as width shrinks.

## Lists, segments, and pages

`/model` and `/effort` are browse lists with `acceptVerb: 'choose'`. Arrows
preview and Enter commits through `selection-accept`. Escape closes. They have
no separate default/cancel button row. The current model badge includes effort.

```text
╭ Select a model ───────────────────────────────────────────╮
│ → Provider/model-a [current · high]  low ‹ high › max      │
│   Provider/model-b                                       │
│ Enter choose · ←/→ thinking · Esc close                   │
╰──────────────────────────────────────────────────────────╯
```

List segments carry `inheritedId` separately from `selectedId`. Undefined means
unpinned; Delete restores inheritance and the action omits a segment override.
The segment appears inline when it fits, then uses a reserved footer row.
Crossing segmented/plain rows preserves geometry. Filtering reports matches,
long lists show position, and empty states explain the next action. Multiple
lists and multiselect fields use `[x]` / `[ ]`; current choices use `[current]`.

`tabs.orientation: 'vertical'` supports labels-left pages at wide widths. Core
stacks the labels above content below 80 columns. Arrows change the active page
locally; no domain write occurs until submission. `/settings` keeps independent
namespace forms and saves only the selected form using native revision checks.
`/sessions` previews workspace header counts without opening session logs;
**Open workspace** performs the bounded reads needed for session details.

`focus-change` is a readonly list observation with `pagePath`, `controlId`, and
`itemId`. It cannot publish, navigate, or dismiss. It is distinct from accepting
a selection and from the tab control's local page activation.

## Decisions and action rows

Unprompted approval, permission, and question requests have a 300 ms arm delay.
Only Escape works before arming. The deadline survives core reload and restarts
after a hidden registration is shown again. Grant digits focus a row; Enter
is still required. Safest choices appear first.

```text
╭ Approve bash? ────────────────────────────────────╮
│ pnpm build                                       │
│ → 1. Reject                                      │
│   2. Allow once                                  │
│   3. Allow bash for this session                  │
│ Feedback:                                        │
│ Enter choose · 1-3 focus · Esc reject             │
╰──────────────────────────────────────────────────╯
```

Approval feedback and plan revision fields stay in the decision surface;
submitting collects the choice and field values together. Escape labels can
describe `close`, `cancel`, or `reject` without changing the Escape ladder.
Shared Yes/No confirmations remain No-first. Native request withdrawal and
Agent replacement retire the request before a late result can grant it.

`actions.reveal: 'focus'` hides redundant action labels until their group is
focused. The group remains reachable through Tab/Shift+Tab. Dirty forms show
an unsaved marker in the action area and confirm ordinary dismissal. Pending
actions show elapsed time. Feedback uses severity prefixes and the existing
notification lifetimes. Subagent reply uses Enter submission.

## Transcript and motion

Ctrl+O controls recent details. Its cue reads the live binding and says expand
or collapse. F6 includes the transcript in the focus cycle; arrows/Home/End
select foldable turns, Enter toggles the selected turn, PageUp/PageDown scroll,
and Escape returns to the prompt. The cursor and individual expansion overrides
are retained per conversation generation. Disclosure status reads the last
rendered model, so drawing a hint does not force lazy history conversion.

The activity pane owns live phase, elapsed time, and the main spinner. Main
transcript rows show content and settled summaries. Standalone transcript
surfaces can opt into a running header; they do not add a second spinner.

Waiting ripple frames are `·· ·≈ ≈≈ ≈·` at 120 ms; working braille frames run
at 80 ms. A surface animates at most one primary loader. `mayfly.reducedMotion`
freezes decorative frames while elapsed information can update.
`mayfly.glyphs` accepts `auto`, `unicode`, or `ascii`; ASCII substitutes chrome,
tree furniture, spinners, and progress cells, and omits the logo. Nonempty
`NO_COLOR` suppresses palette/highlighter colors while preserving emphasis.

## Content components

Standalone `ui.code` uses the fenced-code highlighter when a language is known.
Diffs use strong addition/removal and gutter tokens, and separated hunks retain
their individual line ranges and headers. Rounded surface and overlay chrome
share geometry; paint expresses focus.

`ui.chart` renders bounded bar charts with grouped, stacked, or normalized
layout and horizontal or vertical orientation. Use semantic series labels and
tones; pair dense charts with `ui.fields` for a readable legend. `/usage` uses
this composition for estimated context categories, stacking chart and legend
on narrow screens. Zero/unknown usage retains explanatory text.

`ui.diagram(source)` renders supported Mermaid input
through the bounded rich-document renderer, with the existing text fallback
for unsupported syntax. See the [chart and diagram gallery](../../website/en/plugins/ui-reference.md#chart)
for complete data contracts and screenshots. Neither node accepts renderer
callbacks or external resources.

## PR #84 implementation map

The proposal identifiers remain stable for review. “Implemented” describes the
code in this branch; release and human acceptance remain separate.

| Items | Implemented behavior | Primary owner |
| --- | --- | --- |
| A1, A4 | Shared ripple, braille, and furniture vocabulary | `core/glyphs.ts`, `core/ui-patterns.ts` |
| A2 | Rounded surface chrome | `core/ui-patterns.ts`, `core/ui-compiler.ts` |
| A3 | Standalone running header; main activity ownership retained | `transcript/process-rows.ts`, `transcript/transcript-model.ts` |
| B1, E4 | Vertical decision cards, inline feedback, frontend arm guard | `interaction/approval-plugin.ts`, `core/ui-interaction-surface.ts` |
| B2 | Match counts, list position, empty-state guidance | `core/ui-compiler.ts`, `core/ui-patterns.ts` |
| B3 | Busy elapsed time and unsaved marker | `core/ui-compiler.ts` |
| B4 | Independent PLAN/YOLO/SHELL chips | `interaction/mode-status.ts` |
| B5 | Severity-prefixed feedback | `core/ui-compiler.ts` |
| C1, C2 | Diff hunk ranges/tokens and standalone code highlighting | `core/diff-align.ts`, `core/plugin-view.ts` |
| C3 | Chart/Mermaid reference and usage legend | UI reference, `interaction/session-info-model.ts` |
| C4 | Status priority admission and two-row placement | `transcript/status-model.ts` |
| D1, D2, D3 | NO_COLOR, reduced motion, ASCII furniture, primary loader ownership | `core/theme-palette.ts`, `core/ui-loader-animation.ts` |
| E1, E2, E3 | Inline inherited effort, button-free pickers, current-effort badge | `interaction/model-commands.ts`, shared list controls |
| F1 | Focus-revealed action groups | `core/ui-compiler.ts`, `interaction/questionnaire.ts` |
| F2 | Readonly cursor observation and responsive labels-left pages | UI contracts, settings/sessions panels |
| H1, H4 | Contextual status hints and full/minimal/off setting | `interaction/key-hints-status.ts`, `interaction/settings.ts` |
| H2, H3 | Directional, rebound disclosure cues and one key notation | `transcript/hints.ts`, live keymap |
| H5 | Key tips filtered through registered bindings | `transcript/pane-activity.ts` |
| H6 | Older-turn keyboard navigation | `core/transcript-focus.ts`, frontend navigation state |
| H7, H8 | Owner-local queue/completion hints and adaptive placeholders | `interaction/pane-queue.ts`, `interaction/editor-plus.ts` |

Conformance findings G2–G5 and G7–G19 are addressed by the mapped changes:
truthful accept/Escape verbs, stable segment geometry, current/checkbox notation,
button removal or focus reveal, contextual/rebound cues, older-turn navigation,
corrected EN/ZH documentation, split conversation scope/switch entries, reply
submission, and the shell chip. No additional node kind is required.

## Verification and acceptance

Run the repository change planner and full gate, including width scans,
frontend/core reload and late-result tests, public contract checks, screenshots,
and package checks selected by the planner. Generated application examples are
`app-model.svg`, `app-settings.svg`, and `app-approval.svg`.

Human acceptance uses a dedicated `mayfly-<tag>` profile and a built Website
preview. Exercise full/minimal/off live changes, model/effort commit and Escape,
guarded approvals with feedback, F6 on old turns, narrow resize, renderer
reload, reduced motion, ASCII, and NO_COLOR. Do not merge before acceptance.
