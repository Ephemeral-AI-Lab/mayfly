/**
 * The four pages of scene 11 (Patterns, roadmap slice 1.8b): each is `patterns.*` called with the props the prototype's
 * `ui-preview.mjs` passes, adapted to the real builders (roadmap section 3.1: list items take `selectedIds`, spans
 * replace plain right-hand text, a rail's content is a page per label).
 */
import { patterns, ui, type MayflyInlineSpan, type MayflyUiNode } from '../../../ui/src/index.ts'

const S = (text: string, tone?: MayflyInlineSpan['tone']): MayflyInlineSpan => ({ text, ...tone === undefined ? {} : { tone } })
const mu = (text: string): MayflyInlineSpan => S(text, 'muted')

const WORKSPACES = [{ id: 'work', label: 'work/mayfly', count: 8 }, { id: 'site', label: 'website', count: 5 }, { id: 'notes', label: 'notes', count: 2 }] as const

/** The width the prototype draws a page at: the split view needs the wide layout. */
export const pageWidth = (page: number): number => page === 2 ? 100 : 80

/** Page 1: a branch deletion, with the grant-first list, a note field, and a hidden `c` accelerator. */
export function decisionNode(): MayflyUiNode {
  return patterns.decisionPanel({
    id: 'decision',
    title: 'Delete branch?',
    badges: [mu('1 of 2 waiting')],
    preview: [ui.text('feature/old-hero · 3 unmerged commits', { tone: 'muted' }), ui.richText([S('⚠ ', 'warning'), S('the commits are not on any other branch', 'warning')])],
    options: [{ id: 'keep', label: 'Keep the branch' }, { id: 'delete', label: 'Delete it', detail: 'cannot be undone' }, { id: 'archive', label: 'Archive it as a tag' }],
    input: { id: 'why', label: 'Note', placeholder: 'optional' },
    accelerators: [{ id: 'copy', label: 'Copy name', key: 'c', hintLabel: 'copy name' }],
  })
}

/** Page 2: the workspaces rail with a live list per label. */
export function railNode(rail = 'work'): MayflyUiNode {
  return patterns.railPanel({
    title: 'Workspaces',
    rail: { id: 'rail', activeId: rail, items: WORKSPACES },
    content: Object.fromEntries(WORKSPACES.map(item => [item.id, ui.list({
      id: `ws.${item.id}`, role: 'browse', marker: 'selection', selectedIds: [],
      items: [{ id: 'a', label: 'Fix login redirect', right: [mu('2h')] }, { id: 'b', label: 'Docs sync', right: [mu('1d')] }],
    })])),
  })
}

/** Page 3: a plugin list and its detail, side by side at 100 columns. */
export function splitNode(): MayflyUiNode {
  return ui.stack.column([patterns.splitView({
    list: ui.list({
      id: 'sv', role: 'browse', marker: 'selection', selectedIds: [],
      items: [{ id: 'a', label: 'Loop', detail: 'official', right: [mu('1.4.0')] }, { id: 'b', label: 'Git Helper', detail: 'community', right: [mu('update 1.3.0')] }],
    }),
    detail: ui.fields([{ label: 'Name', value: [S('Loop')] }, { label: 'Source', value: [S('official')] }, { label: 'Status', value: [S('✓ installed 1.4.0', 'success')] }]),
  })])
}

/** Page 4: a read-only status page under three tabs. */
export function statusNode(tab = 'overview'): MayflyUiNode {
  return patterns.statusPage({
    title: 'Status',
    tabs: { id: 'st', activeId: tab, items: [{ id: 'overview', label: 'Overview' }, { id: 'usage', label: 'Usage' }, { id: 'account', label: 'Account', attention: true }] },
    rows: [{ label: 'Provider', value: [S('DeepSeek')] }, { label: 'Balance', value: [S('⚠ ¥ 6.20', 'warning'), mu(' low balance')] }, { label: 'Checked', value: [mu('2 min ago · r refresh')] }],
  })
}

export function pageNode(page: number): MayflyUiNode {
  return [decisionNode, railNode, splitNode, statusNode][page]!()
}
