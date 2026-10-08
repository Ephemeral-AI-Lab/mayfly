/**
 * The accepted differences between the prototype and the implementation (docs/design/implementation-roadmap.md
 * section 2.3). A parity comparison may waive cells only by citing one of these ids; anything else is a defect, and
 * a new row needs the reviewer's approval before the slice that introduces it merges.
 */

export interface DesignDelta {
  readonly id: string
  /** The prototype scenes the difference appears in. */
  readonly scenes: readonly number[]
  readonly summary: string
  /** The decision or spec section that makes the difference intentional. */
  readonly reason: string
}

export const DESIGN_DELTAS: readonly DesignDelta[] = [
  { id: 'Δ1', scenes: [21], summary: 'Variant B only, digits choose, a 300 ms arm delay; the stray-key demo becomes a replay test', reason: 'D4' },
  { id: 'Δ2', scenes: [21, 18], summary: 'Plan card: Approve and start, Keep planning…, Reject; Esc declines', reason: 'D3' },
  { id: 'Δ3', scenes: [21, 29], summary: 'The native permission presets with their configured names and descriptions', reason: 'D3' },
  { id: 'Δ4', scenes: [24], summary: 'No x delete and no u undo · 8s', reason: 'D5' },
  { id: 'Δ5', scenes: [16], summary: 'The toast has no Ctrl+J view', reason: 'D6' },
  { id: 'Δ6', scenes: [25], summary: 'Native namespaces, a draft per namespace, Ctrl+S saves', reason: 'D12' },
  { id: 'Δ7', scenes: [26], summary: 'Money estimates are ≈ $ priced from models.dev, hidden without a price', reason: 'D13' },
  { id: 'Δ8', scenes: [30], summary: 'The editor completion lists replace the Commands and Files overlays', reason: 'D8, D9' },
  { id: 'Δ9', scenes: [30], summary: 'No restore-scope strip on a checkpoint; rewind branches the conversation', reason: 'D10' },
  { id: 'Δ10', scenes: [19], summary: 'Prompt style A (the turn rule) only', reason: 'spec 5.6' },
  { id: 'Δ11', scenes: [15], summary: 'Real paste and @ mention flows replace the Ctrl+K and Ctrl+V demo tokens', reason: 'demo keys' },
  { id: 'Δ12', scenes: [18], summary: 'Real clipboard and $EDITOR replace the c and Ctrl+G reports', reason: 'demo keys' },
  { id: 'Δ13', scenes: [13, 18], summary: 'Row 2 renders only while a view or a row-2 entry has something to show', reason: 'spec 5.1' },
  { id: 'Δ14', scenes: [20], summary: 'The after-percentage is a ~ estimate until the next request reports usage', reason: 'no native after-value' },
  { id: 'Δ15', scenes: [21, 18], summary: '⚠ deletes files comes from a documented heuristic on the command text', reason: 'no native signal' },
  { id: 'Δ16', scenes: [26, 28], summary: 'A balance only with the DeepSeek account sign-in; otherwise the row is hidden', reason: 'roadmap 2.2 row 8' },
  { id: 'Δ17', scenes: [1], summary: 'The caption mentions ▌ as the selection mark; the mark is the muted bold →', reason: 'stale caption, spec 2.2' },
  { id: 'Δ18', scenes: Array.from({ length: 32 }, (_, index) => index + 1), summary: 'The kit hint words, including pick on a focused select', reason: 'the kit is the oracle' },
  { id: 'Δ19', scenes: [24], summary: 'n acts on the current workspace; other rows carry unavailableActions.new', reason: 'process cwd' },
  {
    id: 'Δ20',
    scenes: Array.from({ length: 32 }, (_, index) => index + 1),
    summary: "The kit's word wrap drops a line's leading spaces and does not reopen the style on a wrapped continuation; the renderer keeps both",
    reason: 'prototype wrap artifact; approved by the reviewer',
  },
  {
    id: 'Δ21',
    scenes: [8],
    summary: "Markdown is drawn by the shipped markdown component (blank rows between blocks, fenced code kept with its fences, the md* palette tokens), not by the kit's five-rule drawing",
    reason: 'the transcript keeps the streamed markdown component (roadmap Phase 6); proposed in slice 1.3',
  },
  {
    id: 'Δ22',
    scenes: [8],
    summary: "The `h` key swaps the code block's highlighting for one flat user tone; the code node has no such switch and always highlights",
    reason: 'demo key; proposed in slice 1.3',
  },
  {
    id: 'Δ23',
    scenes: [8],
    summary: "Line, point, vertical bar, sparkline, and stacked or grouped horizontal bar charts and the diagram are drawn by their libraries (simple-ascii-chart, beautiful-mermaid), not by the kit's hand-written glyph rows; the heatmap is the kit's",
    reason: 'the kit stands in for a chart library it does not specify; proposed in slice 1.3',
  },
  {
    id: 'Δ24',
    scenes: [7],
    summary: 'Up from a followed tail scrolls one row from the tail; the kit scrolls from a stale offset and jumps to the top',
    reason: 'prototype scroll artifact; proposed in slice 1.3',
  },
  {
    id: 'Δ25',
    scenes: [10],
    summary: "A flex row of framed surfaces: the kit measures a surface structurally and gives the grow remainder to the last growing child, and clips later boxes with `…` columns below 60; the layout engine measures a surface by painting it and shares the remainder by its own rule",
    reason: 'the row layout is pi-tui\'s stack layout (existing behavior); proposed in slice 1.3',
  },
  {
    id: 'Δ26',
    scenes: [10],
    summary: "The `h` key changes only the caption in the kit: the `minHeight: 20` child of the ladder stays drawn; the renderer hides it below 20 rows",
    reason: 'prototype artifact (its viewport height is not read); proposed in slice 1.3',
  },
  {
    id: 'Δ27',
    scenes: [3, 4, 12],
    summary: "`▌` in an edited field marks the terminal cursor (spec 4.3); the renderer draws no glyph, it parks the hardware cursor there",
    reason: 'the spec calls the glyph the terminal cursor; proposed in slice 1.6',
  },
  {
    id: 'Δ28',
    scenes: [4, 12],
    summary: "Core adds the `unsaved changes` badge to the head of every surface whose form is dirty; the prototype adds it in scene 3 only",
    reason: 'roadmap slice 1.6; proposed in slice 1.6',
  },
]
