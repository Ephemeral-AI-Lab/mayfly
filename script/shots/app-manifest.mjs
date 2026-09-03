#!/usr/bin/env node
/**
 * The app-level shot scenarios: real Cordis boots scripted and rendered by
 * `packages/mayfly/tests/app-shots.spec.ts` (scene runners live in
 * `packages/mayfly/tests/app-shots/scenes.ts`). This manifest carries only
 * the frame metadata — `{ id, cols, rows }` — shared by the spec (which
 * paints the SVG) and `sync.mjs` (which schedules the spec). 80×24 is the
 * canonical app frame; the SVGs land in `website/public/shots/` next to the
 * component gallery.
 *
 * @module script/shots/app-manifest
 */

export const APP_SCENARIOS = [
  // README hero: a real finished turn — thinking card, tool cards, the
  // editor dock, and the status bar.
  { id: 'app-conversation', cols: 80, rows: 24 },
  // `/trace` over the scripted log with the selected event's raw detail open.
  { id: 'app-trace', cols: 80, rows: 24 },
  // One step spawning three subagents; the dock pane shows done/running/waiting.
  { id: 'app-agents', cols: 80, rows: 24 },
  // The bare-`/permission` preset picker with sandbox/approval combinations.
  { id: 'app-permission', cols: 80, rows: 24 },
  // The `/sessions` lineage picker: current chain revealed, side branches collapsed.
  { id: 'app-sessions', cols: 80, rows: 24 },
]
