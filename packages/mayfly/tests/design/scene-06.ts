/**
 * The four pages of scene 6 (Tabs, wizards, rails) and the rail panel of scene 11, built with the real builders the
 * way `ui-preview.mjs` builds them. The page content follows the active tab through `tab` pages, which is what the
 * prototype's `tab-change` handler does by rebuilding the node.
 */
import { ui, type MayflyFormField, type MayflyListItem, type MayflyTabItem, type MayflyUiNode } from '../../../ui/src/index.ts'

export const TAB_ITEMS: readonly MayflyTabItem[] = [
  { id: 'overview', label: 'Overview' }, { id: 'usage', label: 'Usage', count: 3 }, { id: 'conn', label: 'Connections', attention: true },
  { id: 'skills', label: 'Skills', count: 12 }, { id: 'about', label: 'About' },
]

const muted = (text: string): MayflyUiNode => ui.text(text, { tone: 'muted' })
const page = (controlId: string, itemId: string, node: MayflyUiNode) => ui.child(node, { tab: { controlId, itemId } })
const option = (id: string): MayflyListItem => ({ id, label: id })

const STEPS: readonly MayflyTabItem[] = [{ id: 'kind', label: 'Kind' }, { id: 'conn', label: 'Connection' }, { id: 'models', label: 'Models' }, { id: 'review', label: 'Review' }]

export const RAIL_ITEMS: readonly MayflyTabItem[] = [
  { id: 'general', label: 'General', group: 'Session' }, { id: 'model', label: 'Model', group: 'Session' },
  { id: 'perm', label: 'Permissions', count: 2, group: 'Session' }, { id: 'providers', label: 'Providers', attention: true, group: 'Integrations' },
  { id: 'mcp', label: 'MCP', count: 4, group: 'Integrations' },
]

const RAIL_FIELDS: Readonly<Record<string, readonly MayflyFormField[]>> = {
  general: [{ id: 'lang', kind: 'select', label: 'Language', value: 'English', options: [option('English'), option('简体中文')] }, { id: 'n', kind: 'toggle', label: 'Notifications', value: true }],
  model: [
    { id: 'model', kind: 'select', label: 'Model', value: 'deepseek-chat', origin: 'inherited', options: [option('deepseek-chat'), option('deepseek-reasoner')] },
    { id: 'effort', kind: 'select', label: 'Effort', value: 'medium', origin: 'inherited', options: [option('low'), option('medium'), option('high')] },
  ],
  perm: [{ id: 'preset', kind: 'select', label: 'Preset', value: 'Default', options: [option('Default'), option('Accept edits')] }],
  providers: [{ id: 'p', kind: 'select', label: 'Provider', value: 'DeepSeek', options: [option('DeepSeek'), option('Local')] }],
  mcp: [{ id: 'auto', kind: 'toggle', label: 'Auto-connect', value: true }],
}

/** The settings panel of page 3: a rail of labels at 24 columns and the live content of each label beside it. */
export function railSettings(items: readonly MayflyTabItem[] = RAIL_ITEMS, activeId = 'model'): MayflyUiNode {
  return ui.surface({
    title: 'Settings', chrome: 'overlay',
    child: ui.stack.row([
      ui.child(ui.tabs({ id: 'rail', orientation: 'vertical', items, activeId }), { basis: 24 }),
      ...items.map(item => ui.child(
        ui.stack.column([ui.text(item.label, { styles: ['strong'], tone: 'primary' }), ui.spacer(), ui.form({ id: `settings.${item.id}`, fields: RAIL_FIELDS[item.id] ?? [] })]),
        { grow: 1, tab: { controlId: 'rail', itemId: item.id } },
      )),
    ], { gap: 2 }),
  })
}

/** The page of scene 6; `tab` is the strip's active tab. */
export function pageNode(index: number, tab = 'usage'): MayflyUiNode {
  switch (index) {
    case 0: return ui.surface({
      title: 'Status', chrome: 'overlay',
      child: ui.stack.column([ui.tabs({ id: 'strip', items: TAB_ITEMS, activeId: tab }), ui.spacer(), ...TAB_ITEMS.map(item => page('strip', item.id, muted(`${item.label} page content`)))]),
    })
    case 1: return ui.surface({
      title: 'Add provider', chrome: 'overlay', badges: [{ text: 'step 1 of 4', tone: 'muted' }],
      child: ui.stack.column([
        ui.tabs({ id: 'wizard', mode: 'wizard', items: STEPS, activeId: 'kind' }), ui.spacer(),
        ...STEPS.map(step => page('wizard', step.id, step.id === 'conn'
          ? ui.form({ id: 'conn', fields: [{ id: 'name', kind: 'input', label: 'Name', value: '', required: true }, { id: 'url', kind: 'input', label: 'Endpoint', value: 'https://api.example.com/v1' }] })
          : muted(`${step.label}: nothing to validate on this step`))),
      ]),
    })
    case 2: return railSettings()
    default: return ui.surface({ title: 'Narrow strip', chrome: 'overlay', child: ui.tabs({ id: 'narrow', items: TAB_ITEMS, activeId: tab }) })
  }
}
