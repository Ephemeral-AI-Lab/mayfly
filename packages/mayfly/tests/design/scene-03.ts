/** The surfaces of scenes 3, 4, and 12 (Fields and forms, Replies and validation, A downstream plugin), built with the real builders the way `ui-preview.mjs` builds them. */
import { ui, type MayflyFormField, type MayflyInlineSpan, type MayflyUiNode } from '../../../ui/src/index.ts'

const opt = (id: string, extra: { readonly disabled?: boolean, readonly disabledReason?: string } = {}) => ({ id, label: id, ...extra })
const S = (text: string, tone?: MayflyInlineSpan['tone']): MayflyInlineSpan => ({ text, ...(tone === undefined ? {} : { tone }) })

/** The form of scene 3, over the values `saved` holds. */
export function providerFields(): readonly MayflyFormField[] {
  return [
    { id: 'name', kind: 'input', label: 'Name', value: 'production', placeholder: 'e.g. production', required: true, group: 'Connection' },
    { id: 'url', kind: 'input', label: 'Endpoint', value: 'https://api.example.com/v1', help: 'Base URL, including the version path', pattern: '^https?://\\S+$', patternMessage: 'Must be an http(s) URL' },
    { id: 'key', kind: 'secret', label: 'API key', value: 'sk-live-0123456789', help: 'Never shown again after saving' },
    { id: 'model', kind: 'select', label: 'Model', value: 'deepseek-chat', origin: 'inherited', group: 'Behaviour', options: [opt('deepseek-chat'), opt('deepseek-reasoner'), opt('custom-model', { disabled: true, disabledReason: 'not in this plan' })] },
    { id: 'timeout', kind: 'number', label: 'Timeout', value: 30, min: 5, max: 120, step: 5, unit: 's', origin: 'inherited' },
    { id: 'stream', kind: 'toggle', label: 'Streaming', value: true },
    { id: 'channels', kind: 'multiselect', label: 'Channels', value: ['mentions', 'errors'], options: [opt('mentions'), opt('errors'), opt('digest', { disabled: true, disabledReason: 'enterprise only' })] },
    { id: 'dir', kind: 'input', label: 'Directory', value: '~/work/may', placeholder: '~/…', suggestions: ['~/work/mayfly', '~/work/website', '~/work/dsh', '~/notes'], help: 'Type a path; Tab completes' },
    { id: 'notes', kind: 'textarea', label: 'Notes', value: 'Prefer small diffs.\nAlways run the width scan.' },
  ]
}

/** Scene 3: every field kind, grouped, with its own Save under a `Finish` rule. */
export function scene3(): MayflyUiNode {
  return ui.surface({
    title: 'Edit provider', chrome: 'overlay', child: ui.stack.column([
      ui.form({ id: 'provider', fields: providerFields() }),
      ui.divider({ label: 'Finish' }),
      ui.actions({ id: 'finish', items: [{ id: 'save', label: 'Save', intent: 'primary', submit: [{ pagePath: [], formId: 'provider' }] }] }),
    ]),
  })
}

/** Scene 4: a required name and a select, saved with Enter. */
export function scene4(): MayflyUiNode {
  return ui.surface({
    title: 'Add provider', chrome: 'overlay', child: ui.stack.column([
      ui.form({ id: 'add', enterSubmits: 'save', fields: [
        { id: 'name', kind: 'input', label: 'Name', value: '', required: true, placeholder: 'e.g. production' },
        { id: 'region', kind: 'select', label: 'Region', value: 'us-east', options: [opt('us-east'), opt('eu-west')] },
      ] }),
      ui.actions({ id: 'finish', items: [{ id: 'save', label: 'Save', intent: 'primary', submit: [{ pagePath: [], formId: 'add' }] }] }),
    ]),
  })
}

/** Scene 12: a downstream plugin's panel, with a textarea that opens its box, a select, a toggle, and two actions. */
export function scene12(): MayflyUiNode {
  return ui.surface({
    title: 'Loop · schedule a prompt', chrome: 'overlay', badges: [S('running', 'success')], child: ui.stack.column([
      ui.form({ id: 'loop', fields: [
        { id: 'prompt', kind: 'textarea', label: 'Prompt', value: 'Check CI and summarize failures', required: true },
        { id: 'every', kind: 'select', label: 'Every', value: '15m', options: [opt('5m'), opt('15m'), opt('1h')] },
        { id: 'on', kind: 'toggle', label: 'Enabled', value: true },
      ] }),
      ui.actions({ id: 'ops', items: [
        { id: 'save', label: 'Save', intent: 'primary', submit: [{ pagePath: [], formId: 'loop' }] },
        { id: 'stop', label: 'Stop the loop', intent: 'danger', confirm: { title: 'Stop the loop?', detail: 'No more runs are scheduled.', tone: 'danger' } },
      ] }),
    ]),
  })
}
