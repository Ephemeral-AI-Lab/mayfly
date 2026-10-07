/**
 * The visual language (slice 1.2), to run beside scenes 1, 7, 8, and 9 of the design prototype: chrome kinds, marks,
 * the state glyphs, feedback severities, highlighted code, and a numbered diff, all from the public builders.
 *
 * @module @mayfly-example/ui-gallery/groups/1-2
 */
import { ui, type MayflyInlineSpan, type MayflyTone } from '@ephemeral-ai/mayfly-ui'

const span = (text: string, tone?: MayflyTone, strong = false): MayflyInlineSpan => ({ text, ...(tone === undefined ? {} : { tone }), ...(strong ? { styles: ['strong'] as const } : {}) })

const BEFORE = ['const moon = state.mode === \'waiting\'', 'const frame = moon', 'const now = activityNow()', 'const a = 1', 'const b = 2'].join('\n')
const AFTER = ['const moon = state.mode === \'waiting\'', 'const frame = glyphFor(state)', 'const now = activityNow()', 'const a = 1', 'const b = 2'].join('\n')

/** The gallery rows of the visual language. */
export function visualLanguageGroup() {
  return [
    ui.divider({ label: 'Visual language' }),
    ui.surface({ title: 'Approve bash?', chrome: 'overlay', padding: 1, subtitle: 'overlay: the focus border color', badges: [span('1 of 3 waiting', 'muted')], child: ui.text('Runs: pnpm build') }),
    ui.surface({ title: 'Select a model', chrome: 'surface', child: ui.text('surface: the quiet border color') }),
    ui.surface({ title: 'Queued (2)', chrome: 'lane', child: ui.text('lane: rules only') }),
    ui.surface({ title: 'Todo', chrome: 'none', child: ui.text('none: a bold title') }),
    ui.list({
      id: 'gallery-marks', role: 'choose', selectedIds: [],
      items: [
        { id: 'default', label: 'Default', badge: 'current' },
        { id: 'edits', label: 'Accept edits' },
        { id: 'full', label: 'Full access', disabled: true, disabledReason: 'managed by policy' },
      ],
    }),
    ui.list({
      id: 'gallery-checks', role: 'choose', mode: 'multiple', selectedIds: ['read'],
      items: [{ id: 'read', label: 'read_file' }, { id: 'write', label: 'write_file' }],
    }),
    ui.richText([span('● ', 'primary', true), span('running  '), span('✓ ', 'success', true), span('done  '), span('✗ ', 'danger', true), span('failed  '), span('⊘ ', 'muted', true), span('cancelled  '), span('? ', 'warning', true), span('waiting')]),
    ui.richText([span('✓ ', 'success'), span('Installed Git Helper')]),
    ui.richText([span('ℹ ', 'primary'), span('Resumed session · 24 turns')]),
    ui.richText([span('⚠ ', 'warning'), span('Balance low', 'warning')]),
    ui.richText([span('✗ ', 'danger'), span('Sign-in failed', 'danger'), span('  r retry', 'muted')]),
    ui.code(['const frame = glyphFor(state)', "if (state.mode === 'waiting') {", "  return { kind: 'loader', variant: 'gap' }", '}'].join('\n'), { language: 'typescript' }),
    ui.diff(BEFORE, AFTER),
  ]
}
