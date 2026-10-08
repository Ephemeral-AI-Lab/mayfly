/**
 * Content, layout, and motion demos (roadmap slice 1.3): ellipsis for paths, numbered code and diffs with options, the
 * one-cell heatmap, loader variants and the two motion spans, the progress styles, a priority-admitted row, and a
 * surface with a right-aligned title. The pane's own scroll holds this page, so a scroll region (`height`, `fit`,
 * `pill`) is shown by the reference and the screenshots rather than nested here.
 *
 * @module @mayfly-example/ui-gallery/groups/content-layout
 */
import { ui } from '@ephemeral-ai/mayfly-ui'

const path = '~/work/mayfly/packages/mayfly/src/core/ui-compiler.ts'

/** Content, layout, and motion demos for the pane. */
export function contentLayoutGroup() {
  const levels = [
    { value: 0, label: 'none', tone: 'muted' as const },
    { value: 1, label: 'some', tone: 'success' as const },
    { value: 2, label: 'more', tone: 'success' as const },
    { value: 3, label: 'most', tone: 'success' as const },
  ]
  return [
    ui.divider({ label: 'Content, layout, and motion' }),
    ui.text(path, { overflow: 'middle', tone: 'muted' }),
    ui.text(path, { overflow: 'start', styles: ['strong'] }),
    ui.code('const frame = glyphFor(state)\nreturn frame', { language: 'ts', numbered: true }),
    ui.diff('const a = 1\nconst b = 2\nconst c = 3', 'const a = 1\nconst b = 4\nconst c = 3', { start: 41, hunkHeader: true, context: 1 }),
    ui.chart({
      chart: 'heatmap', cell: 1, title: 'Commits', columns: ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'], columnLabels: ['Jan', '', '', 'Feb', '', ''],
      rows: ['Mon', 'Fri'], values: [[0, 1, 2, 3, 2, 1], [1, 0, 0, 2, 3, 3]], levels,
    }),
    ui.loader({ variant: 'bloom', message: 'Thinking' }),
    ui.loader({ variant: 'fill', message: 'Working' }),
    ui.loader({ variant: 'gap', message: 'Discovering models', elapsedMs: 12_000, cancelActionId: 'gallery-cancel' }),
    ui.loader({ variant: 'breath', message: 'Waiting for authorization', elapsedMs: 45_000 }),
    ui.richText([{ text: 'Running commands', motion: 'shimmer' }, { text: ' · 12s', tone: 'muted' }]),
    ui.richText([{ text: '', motion: 'loader', variant: 'gap' }, { text: ' one animated cell, one channel per row', tone: 'muted' }]),
    ui.progress({ label: 'Building', value: 6, max: 10, style: 'cells', width: 10 }),
    ui.progress({ value: 9, max: 10, width: 10, showCount: false, showPercent: true }),
    ui.progress({ style: 'rule', value: 2, max: 8, width: 24 }),
    ui.stack.row([
      ui.child(ui.richText([{ text: 'deepseek-chat High' }]), { priority: 0 }),
      ui.child(ui.richText([{ text: 'PLAN', tone: 'primary', styles: ['strong'] }]), { priority: 1 }),
      ui.child(ui.richText([{ text: 'cache 34%', tone: 'muted' }]), { priority: 4, band: 'right', overflow: 'hide' }),
      ui.child(ui.richText([{ text: path, tone: 'muted' }]), { priority: 5, overflow: 'truncate' }),
    ], { gap: 2 }),
    ui.surface({ title: path, titleAlign: 'right', chrome: 'surface', border: 'warning', badges: [{ text: 'dirty', tone: 'warning' }], child: ui.text('A right-aligned title keeps the end of a path.') }),
  ]
}
