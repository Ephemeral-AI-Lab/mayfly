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
]
