/**
 * The tabs of slice 1.5, to run beside scene 6 of the design prototype: a strip with counts and an attention mark, and a
 * vertical rail with group headings, right-aligned counts, a clipped label, and live content beside it. `↑/↓` on the
 * rail change the page at once, `→` or Enter enter it, and the first `←` a control does not use comes back to the rail.
 *
 * @module @mayfly-example/ui-gallery/groups/tabs
 */
import { ui } from '@ephemeral-ai/mayfly-ui'

const STRIP = [
  { id: 'overview', label: 'Overview' }, { id: 'usage', label: 'Usage', count: 3 }, { id: 'connections', label: 'Connections', attention: true },
  { id: 'skills', label: 'Skills', count: '12/40' },
]

const RAIL = [
  { id: 'general', label: 'General', group: 'Session' }, { id: 'model', label: 'Model', group: 'Session' }, { id: 'permissions', label: 'Permissions', count: 2, group: 'Session' },
  { id: 'providers', label: 'Providers', attention: true, group: 'Integrations' },
  { id: 'workspace', label: '/home/ubuntu/dev/mayfly/packages/mayfly', clip: 'start' as const, group: 'Integrations' },
]

/** The gallery rows of the tabs. */
export function tabsGroup() {
  return [
    ui.divider({ label: 'Tabs, rails, and focus levels' }),
    ui.text('a strip: counts muted, ! for attention; ←/→ move when focused, Alt+←/→ (F2/F3) switch from anywhere', { tone: 'muted' }),
    ui.tabs({ id: 'gallery-strip', activeId: 'usage', hintLabel: 'pages', items: STRIP }),
    ...STRIP.map(item => ui.child(ui.text(`${item.label} page`, { tone: 'muted' }), { tab: { controlId: 'gallery-strip', itemId: item.id } })),
    ui.text('a rail: ↑/↓ change the page live, → or Enter enter it, ← comes back; below 60 columns it is the strip', { tone: 'muted' }),
    ui.stack.row([
      ui.child(ui.tabs({ id: 'gallery-rail', orientation: 'vertical', activeId: 'model', items: RAIL }), { basis: 26, shrink: 0 }),
      ...RAIL.map(item => ui.child(
        ui.form({ id: `gallery-rail-${item.id}`, fields: [
          { id: 'level', kind: 'select', label: 'Level', value: 'low', options: ['low', 'medium', 'high'].map(id => ({ id, label: id })) },
          { id: 'on', kind: 'toggle', label: 'Enabled', value: true },
        ] }),
        { grow: 1, tab: { controlId: 'gallery-rail', itemId: item.id } },
      )),
    ], { gap: 2 }),
  ]
}
