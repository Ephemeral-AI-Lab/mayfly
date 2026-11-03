/** The seven pages of scene 5 (Lists), built with the real builders the way `ui-preview.mjs` builds them. */
import { ui, type MayflyInlineSpan, type MayflyListItem, type MayflyUiNode } from '../../../ui/src/index.ts'
import { feedbackSpans } from '../../src/core/ui-interaction-notifications.ts'

const S = (text: string, tone?: MayflyInlineSpan['tone'], styles?: MayflyInlineSpan['styles']): MayflyInlineSpan => ({ text, ...(tone === undefined ? {} : { tone }), ...(styles === undefined ? {} : { styles }) })
const mu = (text: string): MayflyInlineSpan => S(text, 'muted')
const caption = (text: string): MayflyUiNode => ui.text(text, { tone: 'muted' })

const SKILLS: readonly MayflyListItem[] = [
  { id: 'review-pr', label: 'review-pr', detail: 'Review a pull request', badge: 'enabled', group: 'Project' },
  { id: 'release-notes', label: 'release-notes', detail: 'Draft release notes', group: 'Project' },
  { id: 'pdf-export', label: 'pdf-export', detail: 'PDF export', disabled: true, disabledReason: 'retired', group: 'Project' },
  { id: 'plugin-author', label: 'plugin-author', detail: 'Prototype a plugin in-process', group: 'Preset' },
  { id: 'preset-author', label: 'preset-author', detail: 'Compose your own presets', group: 'Preset' },
]
const effort = (ids: readonly string[], inheritedId?: string) => ({ label: 'Thinking', options: ids.map(id => ({ id, label: id })), ...(inheritedId === undefined ? {} : { inheritedId }) })
const MODELS: readonly MayflyListItem[] = [
  { id: 'op-pro', label: 'opencode-go/DeepSeek V4 Pro', detail: '977k context', group: 'opencode-go', segment: effort(['min', 'high', 'max'], 'high') },
  { id: 'op-bunny', label: 'opencode-go/space-bunny-alpha', detail: '256k context', group: 'opencode-go' },
  { id: 'ds-flash', label: 'DeepSeek/DeepSeek-V41-Flash', badge: 'current · high', detail: '977k context', group: 'DeepSeek', segment: effort(['min', 'high', 'max'], 'high') },
  { id: 'cu', label: 'custom/some-model', detail: '128k context', group: 'custom', segment: effort(['low', 'medium', 'high']) },
]

/** The surface of one page, as `ui-preview.mjs` builds it, with the host's feedback in its footer. */
export function pageNode(page: number, feedback?: string): MayflyUiNode {
  const footer = feedback === undefined ? {} : { footer: ui.richText([...feedbackSpans('success', feedback)]) }
  const surface = (title: string, child: MayflyUiNode): MayflyUiNode => ui.surface({ title, chrome: 'overlay', ...footer, child })
  switch (page) {
    case 0: return surface('Numbered choose lists', ui.stack.column([
      caption('numbered: true — a digit chooses at once (preferences, questions)'),
      ui.list({ id: 'instant', role: 'choose', numbered: true, selectedIds: [], items: [{ id: 'preset', label: 'Preset endpoint', detail: 'known provider' }, { id: 'custom', label: 'Custom endpoint', detail: 'any compatible URL' }, { id: 'oauth', label: 'OAuth provider', detail: 'browser sign-in' }] }),
      ui.spacer(),
      caption("numbered: 'focus' — a digit only moves the cursor (anything that grants)"),
      ui.list({ id: 'focus', role: 'choose', numbered: 'focus', selectedIds: [], items: [{ id: 'reject', label: 'Reject' }, { id: 'once', label: 'Allow once' }, { id: 'session', label: 'Allow for this session' }] }),
    ]))
    case 1: return surface('Skills', ui.list({ id: 'skills', role: 'browse', filterable: true, selectedIds: [], items: SKILLS, empty: ui.empty({ title: 'No skills match', description: 'Esc ends the search · Ctrl+U clears it' }) }))
    case 2: return surface('Channels', ui.list({ id: 'channels', role: 'choose', mode: 'multiple', selectedIds: ['mentions'], items: [{ id: 'mentions', label: 'mentions' }, { id: 'errors', label: 'errors' }, { id: 'digest', label: 'digest', disabled: true, disabledReason: 'enterprise only' }] }))
    case 3: return surface('Plugins', ui.stack.column([
      ui.list({ id: 'plugins', role: 'browse', filterable: true, filterMode: 'slash', marker: 'selection', selectedIds: [], items: [{ id: 'loop', label: 'Loop', detail: 'official', right: [mu('1.4.0')] }, { id: 'git', label: 'Git Helper', detail: 'community', right: [mu('update 1.3.0')] }] }),
      ui.actions({ id: 'keys', items: [
        { id: 'install', label: 'Install', key: 'i', hidden: true },
        { id: 'remove', semantic: 'delete', label: 'Remove', hidden: true, confirm: { title: 'Remove plugin?', detail: 'Removal applies after restarting Mayfly.', tone: 'danger' } },
        { id: 'refresh', semantic: 'refresh', label: 'Refresh', hidden: true },
      ] }),
    ]))
    case 4: return surface('Providers', ui.stack.column([
      ui.list({ id: 'providers', role: 'browse', acceptVerb: 'edit', selectedIds: [], items: [
        { id: 'ds', label: 'DeepSeek', detail: 'built-in', unavailableActions: { delete: 'built-in providers cannot be deleted' } },
        { id: 'local', label: 'Local', detail: 'custom' },
        { id: 'staging', label: 'Staging', detail: 'asks before it is chosen', confirm: { title: 'Use Staging?', detail: 'It is not your default provider.' } },
      ] }),
      ui.actions({ id: 'bar', items: [{ id: 'delete', semantic: 'delete', label: 'Delete', hintLabel: 'delete', hidden: true, selections: [{ pagePath: [], controlId: 'providers' }], confirm: { title: 'Delete this provider?', tone: 'danger' } }] }),
    ]))
    case 5: return surface('Select a model', ui.list({ id: 'models', role: 'browse', filterable: true, acceptVerb: 'choose', selectedIds: [], items: MODELS }))
    default: return surface('Tree and accordion', ui.stack.column([
      ui.list({ id: 'tree', role: 'choose', mode: 'multiple', tree: true, selectedIds: ['rd', 'wr', 'ls'], items: [
        { id: 'fs', label: 'filesystem', labelSpans: [S('filesystem', 'default', ['strong'])], expanded: true, right: [S('✓ connected · 120ms  ', 'success'), mu('4 tools')] },
        { id: 'rd', label: 'read_file', parentId: 'fs', detail: 'Read a file from disk' },
        { id: 'wr', label: 'write_file', parentId: 'fs', detail: 'Create or overwrite a file' },
        { id: 'dl', label: 'delete_file', parentId: 'fs', detail: 'Remove a file', right: [S('⚠ dangerous', 'warning')] },
        { id: 'ls', label: 'list_dir', parentId: 'fs', detail: 'List a directory' },
        { id: 'gh', label: 'github', labelSpans: [S('github', 'default', ['strong'])], right: [S('✓ connected · 340ms  ', 'success'), mu('12 tools')] },
        { id: 'gh1', label: 'create_issue', parentId: 'gh' },
        { id: 'gh2', label: 'list_prs', parentId: 'gh' },
      ] }),
      ui.spacer(),
      ui.list({ id: 'accordion', role: 'browse', selectedIds: [], items: [
        { id: 'a1', label: 'plugin-author', detail: 'preset', body: 'Prototype a plugin in-process,\nthen promote it to a durable external plugin.' },
        { id: 'a2', label: 'preset-author', detail: 'preset', body: 'Compose your own presets from the\nbuilt-in services and panels.' },
      ] }),
    ]))
  }
}
