/** Strict parity for the scenes of slice 1.2 (the visual language): scene 1 pages 1-5, 7 p1, 8 p3-p4, and 9 p3. */
import { describe, expect, it } from 'vitest'
import { ui } from '../../../ui/src/index.ts'
import { caption, diffReport, frameDiffs, goldenRows, paint } from './scene.ts'
import { createRealSurface, parityComponents, PROBE_PALETTE } from './parity.ts'
import { alignDiffLines, paintDiffRows } from '../../src/core/diff-align.ts'

const S = (text: string, tone?: 'muted' | 'primary' | 'accent' | 'user' | 'success' | 'warning' | 'danger', styles?: readonly ('strong' | 'italic' | 'strike')[]) => ({ text, ...(tone === undefined ? {} : { tone }), ...(styles === undefined ? {} : { styles }) })

describe('scene 7 Surfaces and scroll, page 1: chrome kinds', () => {
  it('draws overlay, surface, lane, and none', async () => {
    const rows = [
      ...paint(caption('chrome kinds: overlay, surface, lane, none · page 1/3'), 96),
      '',
      ...paint(ui.stack.column([
        caption('overlay: rounded, focus border color'),
        ui.surface({ title: 'Approve bash?', chrome: 'overlay', padding: 1, subtitle: 'optional subtitle (muted)', badges: [S('1 of 3 waiting', 'muted')], child: ui.text('Runs: pnpm build'), footer: ui.richText([S('optional custom footer', 'muted')]) }),
        caption('surface: rounded, quiet border color'),
        ui.surface({ title: 'Select a model', chrome: 'surface', padding: 1, child: ui.text('→ DeepSeek/DeepSeek-V4-Pro') }),
        caption('lane: rules only (the queue pane head)'),
        ui.surface({ title: 'Queued (2) · ↑ recall newest', chrome: 'lane', child: ui.text('Queued: also update the footer') }),
        caption('none: a bare bold title (the todo pane)'),
        ui.surface({ title: 'Todo', chrome: 'none', child: ui.text('  ✓ read the config') }),
      ]), 76),
    ]
    // The kit's wrap drops the indent of the todo row's text.
    const diffs = await frameDiffs(goldenRows('07-surfaces-and-scroll', 'initial', 0), rows, 96, [{ delta: 'Δ20', rows: [17, 17] }])
    expect(diffReport(diffs)).toBe('')
  })
})

describe('scene 1 Marks and tokens, page 1: selection and focus', () => {
  it('draws the cursor of a focused choose list, one muted [current], and a disabled row with its reason', async () => {
    const list = createRealSurface(ui.list({ id: 'm1', role: 'choose', selectedIds: [], items: [{ id: 'a', label: 'Default', badge: 'current' }, { id: 'b', label: 'Accept edits' }, { id: 'c', label: 'Full access', disabled: true, disabledReason: 'managed by policy' }] }), 100, { components: parityComponents() })
    try {
      const rows = [
        ...paint(caption('page 1/6 (Ctrl+N): selection and focus: → the cursor, ▌ the persistent selection, ▸ ▾ disclosure, ● ○ ◐ checks, [current], — reason'), 100),
        '',
        ...paint(caption('→ a cursor in a choose list (the row Enter acts on)'), 100),
        ...list.render().slice(0, 3),
      ]
      const golden = goldenRows('01-marks-and-tokens', 'pages', 0).slice(0, rows.length)
      // The kit's wrap does not reopen the caption's dim on its second row.
      const diffs = await frameDiffs(golden, rows, 100, [{ delta: 'Δ20', rows: [1, 1] }])
      expect(diffReport(diffs)).toBe('')
    } finally {
      list.dispose()
    }
  })
})

const EDIT_BEFORE = ["  const moon = state.mode === 'waiting'", '  const frame = moon', '  const now = activityNow()', '  const a = 1', '  const b = 2', '  const c = 3', '  const d = 4', "  return { kind: 'stack', direction: 'column',"].join('\n')
const EDIT_AFTER = ["  const moon = state.mode === 'waiting'", '  const frame = glyphFor(state)', '  const now = activityNow()', '  const a = 1', '  const b = 2', '  const c = 3', '  const d = 4', "  return { kind: 'stack', direction: 'column',"].join('\n')

describe('scene 8 Content', () => {
  it('page 3: highlights code by language, with its muted language name', async () => {
    const rows = [
      ...paint(caption('page 3/7 (Ctrl+N): markdown (code fences highlighted) and code (muted language name, then the lines)'), 100),
      '',
      ...paint(caption('ui.code — highlighted by language (h toggles)'), 100),
      ...paint(ui.code(["const frame = glyphFor(state)", "if (state.mode === 'waiting') {", "  return { kind: 'loader', variant: 'gap' }", '}'].join('\n'), { language: 'typescript' }), 100),
    ]
    // The kit's wrap drops the indent of the third code line.
    const diffs = await frameDiffs(goldenRows('08-content', 'pages', 2).slice(0, rows.length), rows, 100, [{ delta: 'Δ20', rows: [6, 6] }])
    expect(diffReport(diffs)).toBe('')
  })

  it('page 4: a numbered diff with −/+, bands behind the code only, and ⋯ between hunks', async () => {
    const diff = (numbered: boolean): string[] => paintDiffRows(alignDiffLines(EDIT_BEFORE, EDIT_AFTER), 100, parityComponents(), PROBE_PALETTE, { start: 41, numbered, hunkHeader: true, context: 1 })
    const page = (numbered: boolean): string[] => [
      ...paint(caption('page 4/7 (Ctrl+N): diff: two strings in, aligned rows out — numbered gutters, −/+ and color, ⋯ between hunks'), 100),
      '',
      ...paint(caption(`numbered ${numbered ? 'on' : 'off'} (d toggles); an @@ header names the hunk`), 100),
      ...diff(numbered),
    ]
    // The kit's wrap does not reopen the caption's dim on its second row.
    expect(diffReport(await frameDiffs(goldenRows('08-content', 'pages', 3), page(true), 100, [{ delta: 'Δ20', rows: [1, 1] }]))).toBe('')
    expect(diffReport(await frameDiffs(goldenRows('08-content', 'diff', 4), page(false), 100, [{ delta: 'Δ20', rows: [1, 1] }]))).toBe('')
  })
})
