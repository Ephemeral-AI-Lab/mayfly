/**
 * Redacted settings-schema projection and revisioned path operations. Secret
 * values never enter settings mutations.
 * @module @ephemeral-ai/mayfly/remote/features/settings-model
 */

import Schema from '@deepseek-ai/schemastery'
import { createHash } from 'node:crypto'
import type {
  SettingsNamespaceView,
  SettingsPathOpView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { MayflyTranslate } from '@ephemeral-ai/mayfly-ui'
import type { RemotePanelField } from './panel.ts'

const LABELS: Readonly<Record<string, string>> = {
  'locale.preference': 'Language', 'mayfly.language': 'Language', 'mayfly.theme': 'Theme', 'mayfly.startup': 'On start',
  'mayfly.transcriptView': 'Work details', 'mayfly.windowTurns': 'Transcript window (turns)',
  'mayfly.expandTurns': 'Ctrl+O range (turns)', 'mayfly.userFoldLines': 'User fold lines', 'mayfly.userFoldChars': 'User fold chars',
  'mayfly.editorCommand': 'External editor', 'mayfly.glyphs': 'Glyphs', 'mayfly.monochrome': 'Monochrome',
  'mayfly.reducedMotion': 'Reduced motion', 'mayfly.quietHints': 'Quiet hints', 'mayfly.viewHistory': 'View history',
  'permission.defaultPreset': 'Default permission preset',
  'agent-preset-registry.default': 'Default agent preset', 'agent-preset-registry.selectedDefault': 'Default agent preset',
}

interface SettingBinding {
  readonly path: readonly string[]
  readonly encoded: 'json' | 'number' | undefined
  readonly secret: boolean
}

/** Dynamic choices supplied by their official owning Remotes. */
export interface RemoteSettingsChoices {
  readonly permission?: readonly string[]
  readonly agentPresets?: readonly string[]
}

/** Plain panel fields, path bindings, and projected-field revision. */
export interface RemoteSettingsProjection {
  readonly fields: readonly RemotePanelField[]
  readonly bindings: ReadonlyMap<string, SettingBinding>
  readonly readonly: readonly string[]
  readonly revision: string
}

/** One changed form value at the panel/controller boundary. */
export interface RemoteSettingChange {
  readonly id: string
  readonly change: 'set' | 'reset'
  readonly value?: string
}

function scalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)
}

function property(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' && Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined
}

function candidates(schema: Schema): readonly (string | number | boolean | null)[] | undefined {
  if (schema.type === 'const') return scalar(schema.value) ? [schema.value] : undefined
  if (schema.type !== 'union' || schema.list === undefined) return undefined
  const values = schema.list.filter(item => item.type !== 'transform').map(item => item.type === 'const' && scalar(item.value) ? { value: item.value } : undefined)
  return values.every(item => item !== undefined) ? values.map(item => item!.value) : undefined
}

function optionEntries(options: readonly (string | number | boolean | null)[], stored: readonly unknown[]): readonly { readonly id: string, readonly label: string }[] {
  const entries = options.map(value => ({ id: JSON.stringify(value), label: String(value) }))
  const seen = new Set(entries.map(entry => entry.id))
  for (const value of stored) {
    if (!scalar(value)) continue
    const id = JSON.stringify(value)
    if (seen.has(id)) continue
    seen.add(id)
    entries.push({ id, label: String(value) })
  }
  return entries
}

/** Project declared scalar fields from the official redacted namespace view. */
export function remoteSettingsProjection(
  descriptor: SettingsNamespaceView,
  writable: boolean,
  choices: RemoteSettingsChoices,
  t: MayflyTranslate,
): RemoteSettingsProjection {
  const root = new Schema(descriptor.schema as Partial<Schema>)
  const bindings = new Map<string, SettingBinding>()
  const fields: RemotePanelField[] = []
  const readonly: string[] = []
  const active = new Set<Schema>()
  const visit = (schema: Schema, path: readonly string[], value: unknown, inherited: unknown, parentDisabled = false): void => {
    if (schema.meta.hidden) return
    const disabled = parentDisabled || schema.meta.disabled === true || !writable
    let fallback: unknown
    try { fallback = schema(inherited) } catch { fallback = inherited ?? schema.meta.default }
    const key = path.join('.')
    const label = t(LABELS[`${descriptor.ns}.${key}`] ?? key)
    if (schema.type === 'object' && schema.meta.role !== 'secret' && !active.has(schema) && path.length < 16) {
      active.add(schema)
      for (const [childKey, child] of Object.entries(schema.dict ?? {})) visit(child, [...path, childKey], property(value, childKey), property(fallback, childKey), disabled)
      active.delete(schema)
      return
    }
    const id = JSON.stringify(path)
    const dynamicKind = descriptor.ns === 'permission' && key === 'defaultPreset' ? 'permission'
      : descriptor.ns === 'agent-preset-registry' && (key === 'default' || key === 'selectedDefault') ? 'agentPresets' : undefined
    const dynamic = dynamicKind === undefined ? undefined : choices[dynamicKind]
    const options = dynamic ?? candidates(schema)
    const secret = schema.meta.role === 'secret'
    let field: RemotePanelField | undefined
    let encoded: SettingBinding['encoded']
    if (secret) {
      const configured = descriptor.secrets.some((secret: SettingsNamespaceView['secrets'][number]) => secret.set && JSON.stringify(secret.path) === id)
      field = { id, label: `${label} (${t('Credentials')})`, kind: 'secret', disabled: true, placeholder: t(configured ? 'Configured; leave unchanged' : 'Not configured') }
    } else if (options !== undefined) {
      encoded = 'json'
      field = {
        id, label, kind: 'select', disabled: disabled || dynamicKind !== undefined && dynamic === undefined,
        value: value === undefined || !scalar(value) ? '' : JSON.stringify(value),
        options: optionEntries(options, value === undefined ? [] : [value]),
      }
    } else if (schema.type === 'boolean') {
      field = { id, label, kind: 'toggle', value: typeof value === 'boolean' ? String(value) : 'false', disabled }
    } else if (schema.type === 'string' || schema.type === 'number') {
      encoded = schema.type === 'number' ? 'number' : undefined
      field = { id, label, kind: 'input', value: typeof value === 'string' || typeof value === 'number' ? String(value) : '', disabled }
    } else if (schema.type === 'array') {
      encoded = 'json'
      field = { id, label: `${label} (JSON)`, kind: 'input', value: value === undefined ? '[]' : JSON.stringify(value), disabled }
    }
    if (field === undefined) { readonly.push(`${label}: ${t('Managed in settings file')}`); return }
    fields.push(field)
    bindings.set(id, { path, encoded, secret })
  }
  visit(root, [], descriptor.value, descriptor.base)
  const revision = createHash('sha256').update(JSON.stringify(fields.map(field => [
    field.id, field.kind, field.value, field.disabled, field.options?.map(option => option.id),
  ]))).digest('hex')
  return { fields, bindings, readonly, revision }
}

/** Convert changed fields into path operations; setting a secret value is refused. */
export function remoteSettingsOperations(
  projection: RemoteSettingsProjection,
  changes: readonly RemoteSettingChange[],
): SettingsPathOpView[] {
  const operations: SettingsPathOpView[] = []
  for (const change of changes) {
    const binding = projection.bindings.get(change.id)
    const field = projection.fields.find(candidate => candidate.id === change.id)
    if (binding === undefined || field === undefined || field.disabled === true) throw new Error('The setting is no longer editable')
    if (change.change === 'reset') { operations.push({ op: 'unset', path: [...binding.path] }); continue }
    if (binding.secret) throw new Error('Use the provider credential controls for secret values')
    const raw = change.value
    if (raw === undefined) throw new Error('The submitted value is missing')
    const value = binding.encoded === 'json' ? JSON.parse(raw)
      : binding.encoded === 'number' ? Number(raw)
        : field.kind === 'toggle' ? raw === 'true' : raw
    if (binding.encoded === 'number' && !Number.isFinite(value)) throw new Error('The setting requires a finite number')
    operations.push({ op: 'set', path: [...binding.path], value })
  }
  return operations
}

/** Whether a path names a redacted secret slot. */
export function remoteSettingsSecretPath(descriptor: SettingsNamespaceView, path: readonly string[]): boolean {
  const key = JSON.stringify(path)
  return descriptor.secrets.some((secret: SettingsNamespaceView['secrets'][number]) => JSON.stringify(secret.path) === key)
}

/** Strip schema-declared secret values from update/replace input. */
export function remoteSettingsWithoutSecrets(schemaValue: unknown, value: unknown): unknown {
  const walk = (schema: unknown, current: unknown): unknown => {
    const role = property(property(schema, 'meta'), 'role')
    if (role === 'secret') return undefined
    const type = property(schema, 'type')
    if (type === 'object' && current !== null && typeof current === 'object' && !Array.isArray(current)) {
      const result: Record<string, unknown> = {}
      const dict = property(schema, 'dict')
      for (const [key, entry] of Object.entries(current)) {
        const childSchema = dict !== null && typeof dict === 'object' ? Reflect.get(dict, key) : undefined
        const stripped = walk(childSchema, entry)
        if (stripped !== undefined) result[key] = stripped
      }
      return result
    }
    if ((type === 'array' || type === 'dict') && current !== null && typeof current === 'object') {
      const inner = property(schema, 'inner')
      if (Array.isArray(current)) return current.map(entry => walk(inner, entry))
      return Object.fromEntries(Object.entries(current).flatMap(([key, entry]) => {
        const stripped = walk(inner, entry)
        return stripped === undefined ? [] : [[key, stripped]]
      }))
    }
    if (type === 'union' || type === 'intersect') {
      const list = property(schema, 'list')
      return Array.isArray(list) ? list.reduce((value, child) => walk(child, value), current) : current
    }
    if (type === 'transform') return walk(property(schema, 'inner'), current)
    return current
  }
  return walk(schemaValue, value)
}
