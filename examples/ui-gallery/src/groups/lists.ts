/**
 * The lists of slice 1.4, to run beside scene 5 of the design prototype: numbered choose lists, a slash filter beside
 * free accelerators, selection rails, the model picker's segment strip, a tree with tri-state checks, accordions with
 * bodies, wrapped rows, rules, and a windowed list, all from the public builders.
 *
 * @module @mayfly-example/ui-gallery/groups/lists
 */
import { ui, type MayflyInlineSpan, type MayflyTone } from '@ephemeral-ai/mayfly-ui'

const span = (text: string, tone: MayflyTone): MayflyInlineSpan => ({ text, tone })
const effort = (inheritedId: string) => ({ label: 'Thinking', inheritedId, options: ['min', 'high', 'max'].map(id => ({ id, label: id })) })

/** The gallery rows of the lists. */
export function listsGroup() {
  return [
    ui.divider({ label: 'Lists' }),
    ui.text('numbered: true — a digit chooses at once; numbered: focus — a digit only moves the cursor', { tone: 'muted' }),
    ui.list({ id: 'gallery-numbered', role: 'choose', numbered: true, selectedIds: [], items: [
      { id: 'preset', label: 'Preset endpoint', detail: 'known provider' },
      { id: 'custom', label: 'Custom endpoint', detail: 'any compatible URL' },
    ] }),
    ui.list({ id: 'gallery-focus', role: 'choose', numbered: 'focus', selectedIds: [], items: [{ id: 'reject', label: 'Reject' }, { id: 'once', label: 'Allow once' }] }),
    ui.text('filterMode: slash — / starts the filter, so bare letters stay free for accelerators', { tone: 'muted' }),
    ui.list({ id: 'gallery-slash', role: 'browse', filterable: true, filterMode: 'slash', marker: 'selection', selectedIds: [], items: [
      { id: 'loop', label: 'Loop', detail: 'official', right: [span('1.4.0', 'muted')] },
      { id: 'git', label: 'Git Helper', detail: 'community', right: [span('update 1.3.0', 'muted')] },
    ] }),
    ui.actions({ id: 'gallery-slash-keys', items: [{ id: 'install', label: 'Install', key: 'i', hidden: true }] }),
    ui.text('a segment strip on the focused row: ←/→ steps, Delete unpins, it never moves a row', { tone: 'muted' }),
    ui.list({ id: 'gallery-models', role: 'browse', filterable: true, filterMode: 'slash', acceptVerb: 'choose', selectedIds: [], items: [
      { id: 'pro', label: 'opencode-go/DeepSeek V4 Pro', detail: '977k context', group: 'opencode-go', segment: effort('high') },
      { id: 'bunny', label: 'opencode-go/space-bunny-alpha', detail: '256k context', group: 'opencode-go' },
      { id: 'flash', label: 'DeepSeek/DeepSeek-V41-Flash', badge: 'current · high', detail: '977k context', group: 'DeepSeek', segment: effort('high') },
    ] }),
    ui.text('a tree with tri-state checks and an accordion; * opens every branch, - closes them', { tone: 'muted' }),
    ui.list({ id: 'gallery-tree', role: 'choose', mode: 'multiple', tree: true, selectedIds: ['read'], items: [
      { id: 'fs', label: 'filesystem', labelSpans: [{ text: 'filesystem', styles: ['strong' as const] }], expanded: true, right: [span('✓ connected  ', 'success'), span('2 tools', 'muted')] },
      { id: 'read', label: 'read_file', parentId: 'fs', detail: 'Read a file from disk' },
      { id: 'write', label: 'write_file', parentId: 'fs', detail: 'Create or overwrite a file' },
    ] }),
    ui.list({ id: 'gallery-accordion', role: 'browse', selectedIds: [], items: [
      { id: 'a1', label: 'plugin-author', detail: 'preset', body: 'Prototype a plugin in-process,\nthen promote it to a durable external plugin.' },
      { id: 'a2', label: 'preset-author', detail: 'preset', body: ui.listBody([ui.text('Compose your own presets.'), ui.progress({ value: 2, max: 4 })]) },
      { id: 'a3', label: 'always open', bodyAlways: true, body: 'A body that is not a disclosure.' },
    ] }),
    ui.text('rows with a meter, a wrap limit, a rule, and a gap; maxRows windows the rest', { tone: 'muted' }),
    ui.list({ id: 'gallery-rows', role: 'browse', maxRows: 5, selectedIds: [], items: [
      { id: 'usage', label: 'Usage', meter: { value: 3, max: 4, tone: 'warning' } },
      { id: 'wrapped', label: 'A long row wraps under its own prefix instead of being cut off, up to its wrap limit of two lines before it says how many remain.', wrap: true, wrapMax: 2 },
      { id: 'rule', label: '', rule: 'Earlier' },
      { id: 'old1', label: 'older item one' },
      { id: 'gap', label: '', gap: true },
      { id: 'old2', label: 'older item two' },
      { id: 'old3', label: 'older item three' },
    ] }),
  ]
}
