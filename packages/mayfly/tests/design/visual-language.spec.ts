/** The scenes of slice 1.2 (the visual language) as grid goldens: scene 1 pages 1-6, 7 p1, 8 p3-p4, and 9 p3. */
import { describe, it } from 'vitest'
import { patterns, ui } from '../../../ui/src/index.ts'
import { PROBE_PALETTE, caption, createRealSurface, expectFrames, paint, probeComponents } from './probe.ts'
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
    await expectFrames('07-surfaces-and-scroll/page-1-padded', [{ label: 'page 1', rows, width: 96 }])
  })
})

describe('scene 1 Marks and tokens, page 1: selection and focus', () => {
  it('draws the cursor of a focused choose list, one muted [current], and a disabled row with its reason', async () => {
    const list = createRealSurface(ui.list({ id: 'm1', role: 'choose', selectedIds: [], items: [{ id: 'a', label: 'Default', badge: 'current' }, { id: 'b', label: 'Accept edits' }, { id: 'c', label: 'Full access', disabled: true, disabledReason: 'managed by policy' }] }), 100, { components: probeComponents() })
    try {
      const rows = [
        ...paint(caption('page 1/6 (Ctrl+N): selection and focus: → the cursor, ▌ the persistent selection, ▸ ▾ disclosure, ● ○ ◐ checks, [current], — reason'), 100),
        '',
        ...paint(caption('→ a cursor in a choose list (the row Enter acts on)'), 100),
        ...list.render().slice(0, 3),
      ]
      await expectFrames('01-marks-and-tokens/page-1-cursor', [{ label: 'page 1', rows, width: 100 }])
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
    await expectFrames('08-content/page-3-code', [{ label: 'page 3', rows, width: 100 }])
  })

  it('page 4: a numbered diff with −/+, bands behind the code only, and ⋯ between hunks', async () => {
    const diff = (numbered: boolean): string[] => paintDiffRows(alignDiffLines(EDIT_BEFORE, EDIT_AFTER), 100, probeComponents(), PROBE_PALETTE, { start: 41, numbered, hunkHeader: true, context: 1 })
    const page = (numbered: boolean): string[] => [
      ...paint(caption('page 4/7 (Ctrl+N): diff: two strings in, aligned rows out — numbered gutters, −/+ and color, ⋯ between hunks'), 100),
      '',
      ...paint(caption(`numbered ${numbered ? 'on' : 'off'} (d toggles); an @@ header names the hunk`), 100),
      ...diff(numbered),
    ]
    await expectFrames('08-content/page-4-diff-rows', [{ label: 'numbered', rows: page(true), width: 100 }, { label: 'unnumbered', rows: page(false), width: 100 }])
  })
})

type Tone = 'default' | 'muted' | 'primary' | 'accent' | 'user' | 'success' | 'warning' | 'danger'
const mu = (text: string) => S(text, 'muted')
const T = (text: string, tone: Tone, styles?: readonly ('strong' | 'italic' | 'strike')[]) => ({ text, ...(tone === 'default' ? {} : { tone }), ...(styles === undefined ? {} : { styles }) })
const col = (...children: Parameters<typeof ui.stack.column>[0]) => ui.stack.column(children)

/** A pages-scene frame (the caption, a blank row, then the page body, all at the scene's width) and its grid golden. */
async function expectPage(name: string, title: string, body: ReturnType<typeof ui.stack.column>, width: number): Promise<void> {
  await expectFrames(name, [{ label: name.split('/')[1]!, rows: [...paint(caption(title), width), '', ...paint(body, width)], width }])
}

describe('scene 1 Marks and tokens, pages 2 to 5', () => {
  it('page 2: state and progress glyphs, one glyph per meaning', async () => {
    const glyphs: readonly (readonly [string, Tone, string])[] = [
      ['●', 'primary', 'assistant block; a tool or step running'], ['»', 'user', 'user block'], ['✻', 'primary', 'thinking'], ['✓', 'success', 'done'], ['✗', 'danger', 'failed'], ['⊘', 'muted', 'cancelled'], ['◐', 'muted', 'declined (plan)'], ['■', 'danger', 'stopping or interrupted'], ['?', 'warning', 'waiting on the user'], ['⚠', 'warning', 'warning'], ['ℹ', 'primary', 'information'], ['✕', 'danger', 'goal blocked'], ['❚❚', 'muted', 'goal paused'], ['⎿', 'muted', 'detail connector'], ['⏵', 'primary', 'background jobs'], ['↻', 'warning', 'applies after a restart'], ['↗', 'accent', 'opens in the external editor'],
    ]
    const body = col(...glyphs.map(([glyph, tone, what]) => ui.richText([T(glyph.padEnd(3), tone, ['strong']), T(what, 'default')])), ui.spacer(), ui.richText([T('▰▰▰▰▱▱ ', 'primary'), mu('determinate progress cells   '), T('━━━━───', 'primary'), mu('  heavy and light rule')]))
    await expectPage('01-marks-and-tokens/page-2', 'page 2/6 (Ctrl+N): state and progress glyphs (one glyph, one meaning)', body, 100)
  })

  it('page 3: tones and styles', async () => {
    const tones: readonly Tone[] = ['default', 'muted', 'primary', 'accent', 'user', 'success', 'warning', 'danger']
    const sample = (tone: Tone): string => tone === 'danger' ? '✗ Plan copy failed' : tone === 'success' ? '✓ Saved to clipboard' : tone === 'warning' ? '⚠ permission picker is unavailable' : 'Sample text in this tone'
    const body = col(...tones.map(tone => ui.richText([T(tone.padEnd(9), tone), T(sample(tone), tone)])), ui.spacer(), ui.richText([T('strong', 'default', ['strong']), T('  ', 'default'), T('italic', 'default', ['italic']), T('  ', 'default'), T('struck', 'muted', ['strike'])]))
    await expectPage('01-marks-and-tokens/page-3', 'page 3/6 (Ctrl+N): tones and styles (the whole palette; a monochrome terminal keeps weight and glyphs)', body, 100)
  })

  it('page 4: one answer for five states', async () => {
    const body = col(
      ui.loader({ message: 'Loading sessions…' }),
      ui.richText([mu('empty      '), T('No plugins installed — press → to browse', 'default')]),
      ui.richText([T('✗ ', 'danger'), T('Could not reach the market', 'default'), mu('  r retry')]),
      ui.richText([T('⚠ ', 'warning'), T('offline · showing cached data from 2d ago', 'default')]),
      ui.richText([mu('— not supported by this provider')]),
      ui.spacer(),
      caption('a slow or failed secondary read (a balance, a catalog refresh) never blocks or alters the primary content'),
    )
    await expectPage('01-marks-and-tokens/page-4', 'page 4/6 (Ctrl+N): one answer for five states: every panel and every secondary read looks the same', body, 100)
  })

  it('page 5: feedback severities, glyph plus word', async () => {
    const body = col(
      ui.richText([T('✓ ', 'success'), T('Installed Git Helper · restart Mayfly to apply', 'default'), mu('   5 s visible, then it goes')]),
      ui.richText([T('ℹ ', 'primary'), T('Resumed session · 24 turns', 'default'), mu('   5 s visible')]),
      ui.richText([T('⚠ ', 'warning'), T('Balance low · ¥ 6.20 left', 'default'), mu('   stays until acted on')]),
      ui.richText([T('✗ ', 'danger'), T('Sign-in failed — try again', 'default'), mu('   stays, offers its retry key')]),
      ui.spacer(),
      caption('inline in the footer of an open surface; a toast in the activity row gap otherwise'),
    )
    await expectPage('01-marks-and-tokens/page-5', 'page 5/6 (Ctrl+N): feedback severities: glyph plus word, never color alone', body, 100)
  })
})

describe('scene 1 Marks and tokens, page 6: breakpoints', () => {
  it('draws patterns.splitView at 100 and 70 columns and the degraded list at 40', async () => {
    const panel = patterns.splitView({
      list: ui.list({ id: 'bp', role: 'browse', marker: 'selection', selectedIds: [], items: [{ id: 'a', label: 'Loop', detail: 'official · T W', right: [mu('1.4.0')] }, { id: 'b', label: 'Git Helper', detail: 'community · T W', right: [mu('update 1.3.0')] }] }),
      detail: ui.fields([{ label: 'Loop', value: [S('official · Automation')] }, { label: 'Status', value: [S('✓ installed 1.4.0', 'success')] }]),
      listWidth: 50,
    })
    const narrow = ui.list({ id: 'bp2', role: 'browse', marker: 'selection', selectedIds: [], items: [{ id: 'a', label: 'Loop', right: [S('✓', 'success')] }, { id: 'b', label: 'Git Helper', right: [S('↑', 'warning')] }] })
    const rows = [
      ...paint(caption('page 6/6 (Ctrl+N): breakpoints: one list-and-detail panel at three widths'), 100), '',
      ...paint(caption('≥ 100 columns: split view'), 100), ...paint(panel, 100), '',
      ...paint(caption('60–99 columns: one column, Enter opens the detail'), 100), ...paint(panel, 70), '',
      ...paint(caption('below 60: the name and one glyph (the list degrades; the detail opens on Enter)'), 100), ...paint(narrow, 40),
    ]
    await expectFrames('01-marks-and-tokens/page-6', [{ label: 'page 6', rows, width: 100 }])
  })
})

describe('scene 9 Feedback and progress, page 3: settled forms', () => {
  it('draws settled results statically with the retry as a key', async () => {
    const body = col(
      ui.richText([T('✓ ', 'success'), T('Discovered 14 models', 'default'), mu(' · 2.1s')]),
      ui.richText([T('✗ ', 'danger'), T('Discovery failed: 401 Unauthorized', 'default'), mu('  r retry')]),
      ui.richText([mu('⊘ Cancelled')]),
    )
    await expectPage('09-feedback-and-progress/page-3', 'page 3/4 (Ctrl+N): settled forms are static; the retry is a key', body, 96)
  })
})
