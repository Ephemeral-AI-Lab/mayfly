/**
 * The composition layer of Phase 8, to run beside scene 11 of the design prototype: a decision lane, a rail panel, a
 * browser, a status page, and a wizard. Each is a pure composition; the host supplies the panel or pane.
 *
 * @module @mayfly-example/ui-gallery/groups/patterns
 */
import { compose, ui } from '@ephemeral-ai/mayfly-ui'

const WORKSPACES = [
  { id: 'work', label: 'work/mayfly', count: 8 },
  { id: 'site', label: 'website', count: 5 },
  { id: 'notes', label: 'notes', count: 2 },
]

const muted = (text: string) => ({ text, tone: 'muted' as const })

/** The gallery rows of the composition layer. */
export function patternsPageGroup() {
  return [
    ui.divider({ label: 'Compositions' }),
    ui.text('decisionLane: every agent request is one lane card; digits choose, Esc rejects, and the note rides the choice', { tone: 'muted' }),
    compose.decisionLane({
      id: 'gallery-decision',
      title: 'Delete branch?',
      badges: [muted('1 of 2 waiting')],
      choices: [
        { id: 'keep', label: 'Keep the branch' },
        { id: 'delete', label: 'Delete it', detail: 'cannot be undone' },
        { id: 'archive', label: 'Archive it as a tag' },
      ],
      note: { id: 'why', label: 'Note', placeholder: 'optional' },
      keys: [{ id: 'gallery-decision-yank', label: 'Yank name', key: 'y', hintLabel: 'yank name' }],
      escapeLabel: 'reject',
    }),
    ui.text(`armMs: ${String(compose.decisionArmMs)} for an unprompted grant`, { tone: 'muted' }),

    ui.text('panel + rail: labels on the left, a page per label on the right', { tone: 'muted' }),
    compose.panel({
      title: 'Workspaces', escapeLabel: 'close',
      body: compose.rail({
        rail: { id: 'gallery-pattern-rail', activeId: 'work', items: WORKSPACES },
        pages: Object.fromEntries(WORKSPACES.map(item => [item.id, ui.list({
          id: `gallery-pattern-ws-${item.id}`, role: 'browse', marker: 'selection', selectedIds: [],
          items: [{ id: 'a', label: 'Fix login redirect', right: [muted('2h')] }, { id: 'b', label: 'Docs sync', right: [muted('1d')] }],
        })])),
      }),
    }),

    ui.text('browser: list and detail side by side from 100 columns, one page below it', { tone: 'muted' }),
    compose.panel({
      title: 'Plugins', escapeLabel: 'close',
      body: compose.browser({
        list: ui.list({
          id: 'gallery-pattern-split', role: 'browse', marker: 'selection', acceptVerb: 'none', selectedIds: [],
          items: [{ id: 'a', label: 'Loop', detail: 'official', right: [muted('1.4.0')] }, { id: 'b', label: 'Git Helper', detail: 'community', right: [muted('update 1.3.0')] }],
        }),
        detail: ui.fields([{ label: 'Name', value: [{ text: 'Loop' }] }, { label: 'Source', value: [{ text: 'official' }] }, { label: 'Status', value: [{ text: '✓ installed 1.4.0', tone: 'success' }] }]),
        listNarrow: ui.list({
          id: 'gallery-pattern-split-narrow', role: 'browse', acceptVerb: 'open', selectedIds: [],
          items: [{ id: 'a', label: 'Loop', detail: 'official' }, { id: 'b', label: 'Git Helper', detail: 'community' }],
        }),
      }),
    }),

    ui.text('wizard: a step per question, Enter takes the answer and moves on, a typed Other row, and a review page', { tone: 'muted' }),
    compose.panel({
      title: 'Questions', escapeLabel: 'cancel',
      body: compose.wizard({
        id: 'gallery-wizard',
        steps: [
          { id: 'region', label: 'Region', lists: ['pick'], body: ui.stack.column([
            ui.text('Which region should the service deploy to?', { styles: ['strong'] }),
            ui.list({
              id: 'pick', role: 'choose', numbered: true, marks: true, autofocus: true, selectedIds: [], acceptActionId: compose.wizardNext('gallery-wizard', 'region'),
              items: [{ id: 'us', label: 'us-east-1', detail: 'lowest latency' }, { id: 'eu', label: 'eu-west-1', detail: 'GDPR data residency' }, { id: 'other', label: 'Other', input: { placeholder: 'type your own answer' } }],
            }),
          ]) },
          { id: 'scopes', label: 'Scopes', lists: ['pick'], body: ui.stack.column([
            ui.text('Which scopes should the token carry?', { styles: ['strong'] }),
            ui.list({
              id: 'pick', role: 'choose', mode: 'multiple', autofocus: true, selectedIds: [], acceptActionId: compose.wizardNext('gallery-wizard', 'scopes'),
              items: [{ id: 'read', label: 'read' }, { id: 'write', label: 'write' }, { id: 'other', label: 'Other', input: { placeholder: 'type your own answer' } }],
            }),
          ]) },
        ],
        review: {
          label: 'Review', skippedLabel: '— skipped', submitLabel: 'Submit answers',
          items: [
            { stepId: 'region', label: 'Region', source: { kind: 'list', controlId: 'pick' } },
            { stepId: 'scopes', label: 'Scopes', source: { kind: 'list', controlId: 'pick' } },
          ],
        },
      }),
    }),

    ui.text('statusPage: a read-only key/value page under tabs', { tone: 'muted' }),
    compose.panel({
      title: 'Status', escapeLabel: 'close',
      body: compose.statusPage({
        tabs: { id: 'gallery-pattern-status', activeId: 'overview', items: [{ id: 'overview', label: 'Overview' }, { id: 'usage', label: 'Usage' }, { id: 'account', label: 'Account', attention: true }] },
        pages: {
          overview: ui.fields([{ label: 'Provider', value: [{ text: 'DeepSeek' }] }, { label: 'Balance', value: [{ text: '⚠ ¥ 6.20', tone: 'warning' }, muted(' low balance')] }, { label: 'Checked', value: [muted('2 min ago')] }]),
          usage: ui.text('Usage page', { tone: 'muted' }),
          account: ui.text('Account page', { tone: 'muted' }),
        },
      }),
    }),
  ]
}
