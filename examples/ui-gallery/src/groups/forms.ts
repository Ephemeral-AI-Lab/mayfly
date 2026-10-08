/**
 * The forms of slice 1.6, to run beside scenes 3, 4, and 12 of the design prototype: group headings, a help line, the
 * `•` mark and the origin notes, a saved secret, a number that steps, a textarea that opens its box, completions on
 * Tab, a pattern, a form that Enter submits from a select, and a single-field form that draws no button.
 *
 * @module @mayfly-example/ui-gallery/groups/forms
 */
import { ui } from '@ephemeral-ai/mayfly-ui'

const option = (id: string, extra: { readonly disabled?: boolean, readonly disabledReason?: string } = {}) => ({ id, label: id, ...extra })

/** The gallery rows of the forms. */
export function formsGroup() {
  return [
    ui.divider({ label: 'Forms' }),
    ui.text('group headings, a help line under the focused field, • for an edited field, (inherited) and (override), a saved secret, a number that steps with ←/→, and a textarea box', { tone: 'muted' }),
    ui.form({
      id: 'gallery-forms-provider',
      fields: [
        { kind: 'input', id: 'gallery-forms-name', label: 'Name', value: 'production', required: true, group: 'Connection' },
        { kind: 'input', id: 'gallery-forms-url', label: 'Endpoint', value: 'https://api.example.com/v1', help: 'Base URL, including the version path', pattern: '^https?://\\S+$', patternMessage: 'Must be an http(s) URL' },
        { kind: 'secret', id: 'gallery-forms-key', label: 'API key', value: 'sk-live-0123456789', help: 'Never shown again after saving' },
        { kind: 'select', id: 'gallery-forms-model', label: 'Model', value: 'deepseek-chat', origin: 'inherited', group: 'Behaviour', options: [option('deepseek-chat'), option('deepseek-reasoner'), option('custom-model', { disabled: true, disabledReason: 'not in this plan' })] },
        { kind: 'number', id: 'gallery-forms-timeout', label: 'Timeout', value: 45, resetValue: 30, min: 5, max: 120, step: 5, unit: 's' },
        { kind: 'toggle', id: 'gallery-forms-stream', label: 'Streaming', value: true },
        { kind: 'multiselect', id: 'gallery-forms-channels', label: 'Channels', value: ['mentions', 'errors'], options: [option('mentions'), option('errors'), option('digest', { disabled: true, disabledReason: 'enterprise only' })] },
        { kind: 'input', id: 'gallery-forms-dir', label: 'Directory', value: '~/work/may', placeholder: '~/…', suggestions: ['~/work/mayfly', '~/work/website', '~/notes'], help: 'Type a path; Tab completes' },
        { kind: 'textarea', id: 'gallery-forms-notes', label: 'Notes', value: 'Prefer small diffs.\nAlways run the width scan.' },
      ],
      submitActionId: 'gallery-forms-save',
    }),
    ui.text('enterSubmits: Enter submits from a select or a toggle too, and Space opens the picker', { tone: 'muted' }),
    ui.form({
      id: 'gallery-forms-region',
      enterSubmits: 'gallery-forms-region-save',
      fields: [
        { kind: 'input', id: 'gallery-forms-region-name', label: 'Name', value: '', required: true, placeholder: 'e.g. production' },
        { kind: 'select', id: 'gallery-forms-region-region', label: 'Region', value: 'us-east', options: [option('us-east'), option('eu-west')] },
      ],
    }),
    ui.actions({ id: 'gallery-forms-region-bar', items: [{ id: 'gallery-forms-region-save', label: 'Save', intent: 'primary', submit: [{ pagePath: [], formId: 'gallery-forms-region' }] }] }),
    ui.text('a single-field form draws no button: Enter submits it', { tone: 'muted' }),
    ui.form({
      id: 'gallery-forms-single',
      submitActionId: 'gallery-forms-single-save',
      fields: [{ kind: 'input', id: 'gallery-forms-single-name', label: 'Rename', value: 'production' }],
    }),
  ]
}
