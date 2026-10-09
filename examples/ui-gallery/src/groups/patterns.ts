/**
 * The four patterns of slice 1.8b, to run beside scene 11 of the design prototype: a decision panel, a rail panel, a
 * split view, and a status page, each called with the props the scene passes. The gallery is a pane, so the decision
 * panel is drawn as a card; a plugin that opens it as an overlay passes `armMs: patterns.decisionArmMs`.
 *
 * @module @mayfly-example/ui-gallery/groups/patterns
 */
import { patterns, ui } from '@ephemeral-ai/mayfly-ui'

const WORKSPACES = [
  { id: 'work', label: 'work/mayfly', count: 8 },
  { id: 'site', label: 'website', count: 5 },
  { id: 'notes', label: 'notes', count: 2 },
]

const muted = (text: string) => ({ text, tone: 'muted' as const })

/** The gallery rows of the patterns. */
export function patternsPageGroup() {
  return [
    ui.divider({ label: 'Patterns' }),
    ui.text('decisionPanel: the first choice is focused, digits choose, Esc rejects; open it with armMs so a stray key grants nothing', { tone: 'muted' }),
    patterns.decisionPanel({
      id: 'gallery-decision',
      title: 'Delete branch?',
      badges: [muted('1 of 2 waiting')],
      chrome: 'surface',
      preview: [ui.text('feature/old-hero · 3 unmerged commits', { tone: 'muted' }), ui.richText([{ text: '⚠ the commits are not on any other branch', tone: 'warning' }])],
      options: [{ id: 'keep', label: 'Keep the branch' }, { id: 'delete', label: 'Delete it', detail: 'cannot be undone' }, { id: 'archive', label: 'Archive it as a tag' }],
      input: { id: 'why', label: 'Note', placeholder: 'optional' },
      accelerators: [{ id: 'gallery-decision-yank', label: 'Yank name', key: 'y', hintLabel: 'yank name' }],
    }),
    ui.text('railPanel: labels on the left, a page per label on the right', { tone: 'muted' }),
    patterns.railPanel({
      title: 'Workspaces',
      rail: { id: 'gallery-pattern-rail', activeId: 'work', items: WORKSPACES },
      content: Object.fromEntries(WORKSPACES.map(item => [item.id, ui.list({
        id: `gallery-pattern-ws-${item.id}`, role: 'browse', marker: 'selection', selectedIds: [],
        items: [{ id: 'a', label: 'Fix login redirect', right: [muted('2h')] }, { id: 'b', label: 'Docs sync', right: [muted('1d')] }],
      })])),
    }),
    ui.text('splitView: list and detail side by side from 100 columns, the list alone below', { tone: 'muted' }),
    patterns.splitView({
      list: ui.list({
        id: 'gallery-pattern-split', role: 'browse', marker: 'selection', selectedIds: [],
        items: [{ id: 'a', label: 'Loop', detail: 'official', right: [muted('1.4.0')] }, { id: 'b', label: 'Git Helper', detail: 'community', right: [muted('update 1.3.0')] }],
      }),
      detail: ui.fields([{ label: 'Name', value: [{ text: 'Loop' }] }, { label: 'Source', value: [{ text: 'official' }] }, { label: 'Status', value: [{ text: '✓ installed 1.4.0', tone: 'success' }] }]),
    }),
    ui.text('statusPage: a read-only key/value page under tabs', { tone: 'muted' }),
    patterns.statusPage({
      title: 'Status',
      tabs: { id: 'gallery-pattern-status', activeId: 'overview', items: [{ id: 'overview', label: 'Overview' }, { id: 'usage', label: 'Usage' }, { id: 'account', label: 'Account', attention: true }] },
      pages: {
        overview: ui.fields([{ label: 'Provider', value: [{ text: 'DeepSeek' }] }, { label: 'Balance', value: [{ text: '⚠ ¥ 6.20', tone: 'warning' }, muted(' low balance')] }, { label: 'Checked', value: [muted('2 min ago')] }]),
        usage: ui.text('Usage page', { tone: 'muted' }),
        account: ui.text('Account page', { tone: 'muted' }),
      },
    }),
  ]
}
