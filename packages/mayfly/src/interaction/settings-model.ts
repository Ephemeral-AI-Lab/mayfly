/** Native schema projection and path-addressed writes for settings forms.
 * @module @ephemeral-ai/mayfly/interaction/settings-model
 */
import Schema from '@deepseek-ai/schemastery'
import { createHash } from 'node:crypto'
import type { SettingsDescriptor, SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { ui, type MayflyFieldValue, type MayflyFormField, type MayflySubmittedForm, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyTranslate } from '../frontend/index.ts'

const LABELS: Readonly<Record<string, string>> = {
  'locale.preference': 'Language', 'mayfly.updateCheck': 'Update check', 'mayfly.updateChannel': 'Update channel',
  'mayfly.theme': 'Theme', 'mayfly.collapseThinking': 'Collapse thinking', 'mayfly.collapseToolCalls': 'Collapse tool calls',
  'mayfly.windowTurns': 'Transcript window (turns)', 'mayfly.recentStepsRetention': 'Recent steps kept',
  'mayfly.expandTurns': 'Ctrl-O range (turns)', 'mayfly.userFoldLines': 'User fold lines', 'mayfly.userFoldChars': 'User fold chars',
  'mayfly.editorCommand': 'External editor', 'mayfly.pasteImageBackend': 'Paste backend', 'mayfly.marketIndexUrl': 'Plugin market index',
  'shell.timeoutMs': 'Shell timeout (ms)', 'shell.maxTimeoutMs': 'Shell max timeout (ms)', 'shell.maxOutputBytes': 'Shell max output (bytes)',
  'shell.maxSpillBytes': 'Shell spill budget (bytes)', 'shell.graceMs': 'Shell grace (ms)',
  'agent-loop.maxParallelToolCalls': 'Max parallel tool calls', 'agent-default-model.reasoningEffort': 'Default reasoning effort',
  'llm-deepseek.thinking': 'DeepSeek thinking', 'web-search-deepseek.maxUses': 'Web search max uses',
  'web-search-deepseek.maxTokens': 'Web search max tokens', 'permission.defaultPreset': 'Default permission preset',
  'agent-presets.default': 'Default agent preset',
}

interface SettingBinding { readonly path: readonly string[], readonly field: MayflyFormField, readonly encoded: boolean }
export interface SettingsProjection { readonly node: MayflyUiNode, readonly bindings: ReadonlyMap<string, SettingBinding>, readonly revision: string }
export interface SettingsChoices { readonly permission?: readonly string[], readonly agentPresets?: readonly string[] }

function property(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined
}

function scalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)
}

function candidates(schema: Schema): readonly (string | number | boolean | null)[] | undefined {
  if (schema.type === 'const') return scalar(schema.value) ? [schema.value] : undefined
  if (schema.type !== 'union' || schema.list === undefined) return undefined
  const values = schema.list.map(item => item.type === 'const' && scalar(item.value) ? { value: item.value } : undefined)
  return values.every(item => item !== undefined) ? values.map(item => item!.value) : undefined
}

/** Project only declared scalar fields; unsupported containers never expose raw values or secrets. */
export function settingsProjection(descriptor: SettingsDescriptor, writable: boolean, choices: SettingsChoices, t: MayflyTranslate): SettingsProjection {
  const root = new Schema(descriptor.schema as Partial<Schema>)
  const bindings = new Map<string, SettingBinding>()
  const readonly: MayflyUiNode[] = []
  const active = new Set<Schema>()
  const visit = (schema: Schema, path: readonly string[], value: unknown, user: unknown, inherited: unknown, parentDisabled = false): void => {
    if (schema.meta.hidden) return
    const disabled = parentDisabled || schema.meta.disabled === true || !writable
    let fallback: unknown
    let resettable = true
    try { fallback = schema(inherited) } catch { fallback = inherited ?? schema.meta.default; resettable = false }
    const key = [...path].join('.')
    const label = t(LABELS[`${descriptor.ns}.${key}`] ?? key)
    if (schema.type === 'object' && schema.meta.role !== 'secret' && !active.has(schema) && path.length < 16) {
      active.add(schema)
      for (const [key, child] of Object.entries(schema.dict ?? {})) visit(child, [...path, key], property(value, key), property(user, key), property(fallback, key), disabled)
      active.delete(schema)
      return
    }
    const id = JSON.stringify(path)
    const origin = user === undefined ? 'inherited' as const : 'explicit' as const
    const base = { id, label, origin, disabled, required: schema.meta.required === true }
    let field: MayflyFormField | undefined
    let encoded = false
    const dynamicKind = descriptor.ns === 'permission' && key === 'defaultPreset' ? 'permission' : descriptor.ns === 'agent-presets' && key === 'default' ? 'agentPresets' : undefined
    const dynamic = dynamicKind === undefined ? undefined : choices[dynamicKind] ?? []
    const options = dynamic ?? candidates(schema)
    if (schema.meta.role === 'secret') {
      if (schema.type === 'string') field = { kind: 'secret', id, label, disabled, value: '', resetValue: '', placeholder: t(descriptor.secrets?.some(secret => secret.set && JSON.stringify(secret.path) === id) ? 'Configured; leave unchanged' : 'Not configured') }
    } else if (options !== undefined) {
      encoded = true
      field = { ...base, disabled: disabled || dynamicKind !== undefined && choices[dynamicKind] === undefined, kind: 'select', value: value === undefined ? null : JSON.stringify(value), options: options.map(value => ({ id: JSON.stringify(value), label: String(value) })), ...resettable ? { resetValue: fallback === undefined ? null : JSON.stringify(fallback) } : {} }
    } else if (schema.type === 'array' && schema.inner !== undefined && candidates(schema.inner) !== undefined) {
      encoded = true
      field = { ...base, kind: 'multiselect', value: Array.isArray(value) ? value.map(value => JSON.stringify(value)) : [], options: candidates(schema.inner)!.map(value => ({ id: JSON.stringify(value), label: String(value) })), ...resettable ? { resetValue: (fallback as unknown[]).map(value => JSON.stringify(value)) } : {}, ...schema.meta.min === undefined ? {} : { minSelected: schema.meta.min }, ...schema.meta.max === undefined ? {} : { maxSelected: schema.meta.max } }
    } else if (schema.type === 'string') {
      field = { ...base, kind: schema.meta.role === 'textarea' ? 'textarea' : 'input', value: typeof value === 'string' ? value : '', ...resettable ? { resetValue: typeof fallback === 'string' ? fallback : '' } : {}, ...schema.meta.min === undefined ? {} : { minLength: schema.meta.min }, ...schema.meta.max === undefined ? {} : { maxLength: schema.meta.max } }
    } else if (schema.type === 'number') {
      field = { ...base, kind: 'number', value: typeof value === 'number' ? value : null, ...resettable ? { resetValue: typeof fallback === 'number' ? fallback : null } : {}, ...schema.meta.min === undefined ? {} : { min: schema.meta.min }, ...schema.meta.max === undefined ? {} : { max: schema.meta.max }, ...schema.meta.step === undefined ? {} : { step: schema.meta.step } }
    } else if (schema.type === 'boolean') {
      if (schema.meta.required !== true && fallback === undefined) {
        encoded = true
        field = { ...base, kind: 'select', value: value === undefined ? null : JSON.stringify(value), options: [{ id: 'true', label: t('On') }, { id: 'false', label: t('Off') }], resetValue: null }
      } else field = { ...base, kind: 'toggle', value: value === true, ...resettable ? { resetValue: fallback === true } : {} }
    }
    if (field === undefined) {
      readonly.push(ui.fields([{ label: label || String(descriptor.ns), value: [{ text: t('Managed in settings file'), tone: 'muted' }] }]))
      return
    }
    bindings.set(id, { path, field, encoded })
  }
  visit(root, [], descriptor.value, descriptor.user, descriptor.base)
  // A raw section revision does not cover a new schema or composition base.
  const revision = createHash('sha256').update(JSON.stringify([...bindings.values()].map(({ field }) => [
    field.id, field.kind, field.value, field.origin, field.disabled, field.required, field.resetValue,
    'options' in field ? field.options.map(option => option.id) : undefined,
    field.kind === 'number' ? [field.min, field.max, field.step] : field.kind === 'multiselect' ? [field.minSelected, field.maxSelected] : 'minLength' in field || 'maxLength' in field ? [field.minLength, field.maxLength] : undefined,
  ]))).digest('hex')
  return { bindings, revision, node: ui.stack.column([
    ...descriptor.applies === 'restart' ? [ui.text(t('restart to apply'), { tone: 'muted' })] : [],
    ui.form({ id: 'settings-form', fields: [...bindings.values()].map(binding => binding.field) }),
    ...readonly,
    ui.actions({ id: 'settings-actions', items: [
      { id: 'save', label: t('Save'), submit: [{ pagePath: [], formId: 'settings-form' }], disabled: !writable || bindings.size === 0 },
      { id: 'refresh', label: t('Refresh') },
      { id: 'cancel', label: t('Cancel'), dismiss: true },
    ] }),
  ]) }
}

export function settingsOperations(projection: SettingsProjection, form: MayflySubmittedForm): SettingsPathOp[] {
  const operations: SettingsPathOp[] = []
  for (const field of form.fields) {
    if (field.change === 'unchanged') continue
    const binding = projection.bindings.get(field.id)
    if (binding === undefined || binding.field.disabled) throw new Error('The setting is no longer editable')
    if (field.change === 'reset') {
      if (binding.field.resetValue === undefined) throw new Error('The setting cannot be reset')
      operations.push({ op: 'unset', path: [...binding.path] })
      continue
    }
    const raw: MayflyFieldValue | undefined = field.value
    if (raw === undefined) throw new Error('The submitted value is missing')
    const value: unknown = binding.encoded ? Array.isArray(raw) ? raw.map(item => JSON.parse(item)) : raw === null ? null : JSON.parse(String(raw)) : raw
    operations.push({ op: 'set', path: [...binding.path], value })
  }
  return operations
}
