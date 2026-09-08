/** Native schema coverage for inheritance, optional values, and opaque containers.
 * @module @ephemeral-ai/mayfly/tests/interaction/settings-model
 */
import Schema from '@deepseek-ai/schemastery'
import { describe, expect, it } from 'vitest'
import type { SettingsDescriptor } from '@deepseek-ai/dsh-settings'
import { settingsOperations, settingsProjection } from '../../src/interaction/settings-model.ts'
import { settingsField } from './settings-fixture.ts'

const project = (schema: Schema, value: unknown = {}, options: Partial<SettingsDescriptor> = {}) => settingsProjection({ ns: 'test' as never, revision: 0, applies: 'live', schema: schema.toJSON(), value, ...options }, true, {}, key => key)

describe('native settings projections', () => {
  it('handles optional and required fields, readonly parents, enums, and collection bounds', () => {
    const schema = Schema.object({
      optional: Schema.boolean(), number: Schema.number(), text: Schema.string(), required: Schema.string().required(),
      readonly: Schema.object({ child: Schema.string() }).disabled(),
      choice: Schema.union([1, 2]), many: Schema.array(Schema.union(['a', 'b'])).min(1).max(2),
      hidden: Schema.string().hidden(), readonlyValue: Schema.any(),
    })
    const projection = project(schema, { required: 'set', choice: 2, readonlyValue: { private: 'opaque-value' } })
    const fields = [...projection.bindings.values()].map(binding => binding.field)
    expect(fields.find(field => field.id === settingsField('optional').fieldId)).toMatchObject({ kind: 'select', value: null, resetValue: null })
    expect(project(schema, { optional: true, required: 'set' }).bindings.get(settingsField('optional').fieldId)!.field).toMatchObject({ kind: 'select', value: 'true' })
    expect(fields.find(field => field.id === settingsField('required').fieldId)).not.toHaveProperty('resetValue')
    expect(fields.find(field => field.id === settingsField('readonly', 'child').fieldId)).toMatchObject({ disabled: true })
    expect(fields.find(field => field.id === settingsField('many').fieldId)).toMatchObject({ kind: 'multiselect', minSelected: 1, maxSelected: 2 })
    expect(JSON.stringify(projection.node)).not.toMatch(/opaque-value|hidden/)
  })

  it('never projects secrets hidden inside unsupported schema containers or secret defaults', () => {
    const schema = Schema.object({
      secret: Schema.string().role('secret').default('sensitive-default'),
      union: Schema.union([Schema.object({ key: Schema.string().role('secret') }), Schema.string()]),
      secretObject: Schema.object({ value: Schema.string() }).role('secret'),
    })
    const projection = project(schema, { secret: 'stored-secret', union: { key: 'nested-secret' }, secretObject: { value: 'private-object' } })
    expect(JSON.stringify(projection.node)).not.toMatch(/sensitive-default|stored-secret|nested-secret|private-object/)
    expect(projection.bindings.get(settingsField('secret').fieldId)!.field).toMatchObject({ kind: 'secret', value: '' })
  })

  it('preserves dynamic select field kinds when the native choice service is absent', () => {
    const schema = Schema.object({ defaultPreset: Schema.string().default('safe') })
    const descriptor: SettingsDescriptor = { ns: 'permission' as never, revision: 0, applies: 'restart', schema: schema.toJSON(), value: { defaultPreset: 'safe' } }
    const absent = settingsProjection(descriptor, true, {}, key => key)
    const present = settingsProjection(descriptor, true, { permission: ['safe', 'full'] }, key => key)
    expect(absent.bindings.get(settingsField('defaultPreset').fieldId)!.field).toMatchObject({ kind: 'select', disabled: true })
    expect(present.bindings.get(settingsField('defaultPreset').fieldId)!.field).toMatchObject({ kind: 'select', disabled: false })
    expect(JSON.stringify(present.node)).toContain('restart to apply')
  })

  it('rejects undeclared or disabled writes and decodes typed enum values', () => {
    const projection = project(Schema.object({ choice: Schema.union([1, 2]), readonly: Schema.string().disabled(), required: Schema.number().required() }), { choice: 1, required: 2 })
    const form = { pagePath: [], formId: 'settings-form', draftRevision: 0 }
    const id = settingsField('choice').fieldId
    expect(settingsOperations(projection, { ...form, fields: [{ id, change: 'set', value: '2' }] })).toEqual([{ op: 'set', path: ['choice'], value: 2 }])
    expect(settingsOperations(projection, { ...form, fields: [{ id, change: 'set', value: null }] })).toEqual([{ op: 'set', path: ['choice'], value: null }])
    for (const fields of [
      [{ id: 'missing', change: 'set' as const, value: 'x' }],
      [{ id: settingsField('readonly').fieldId, change: 'set' as const, value: 'x' }],
      [{ id: settingsField('required').fieldId, change: 'reset' as const }],
      [{ id, change: 'set' as const }],
    ]) expect(() => settingsOperations(projection, { ...form, fields })).toThrow()
  })

  it('projects consts, agent preset choices, textarea bounds, reset arrays, and opaque roots', () => {
    const schema = Schema.object({
      literal: Schema.const('fixed'),
      text: Schema.string().role('textarea').min(1).max(5),
      many: Schema.array(Schema.union(['a', 'b'])).default(['a']),
      requiredFlag: Schema.boolean().required(),
    })
    const projection = settingsProjection({
      ns: 'agent-presets' as never, revision: 0, applies: 'live', schema: schema.toJSON(),
      value: { literal: 'fixed', text: 'body', many: ['b'], requiredFlag: true },
      base: { many: ['a'] },
    }, true, { agentPresets: ['one', 'two'] }, key => key)
    expect(projection.bindings.get(settingsField('literal').fieldId)!.field).toMatchObject({ kind: 'select', options: [{ id: '"fixed"' }] })
    expect(projection.bindings.get(settingsField('text').fieldId)!.field).toMatchObject({ kind: 'textarea', minLength: 1, maxLength: 5 })
    expect(projection.bindings.get(settingsField('many').fieldId)!.field).toMatchObject({ kind: 'multiselect', resetValue: ['"a"'] })
    expect(projection.bindings.get(settingsField('requiredFlag').fieldId)!.field).toMatchObject({ kind: 'toggle' })

    const presets = settingsProjection({
      ns: 'agent-presets' as never, revision: 0, applies: 'live',
      schema: Schema.object({ default: Schema.string().default('one') }).toJSON(), value: { default: 'one' },
    }, true, { agentPresets: ['one', 'two'] }, key => key)
    expect(presets.bindings.get(settingsField('default').fieldId)!.field).toMatchObject({ kind: 'select', disabled: false })

    const opaqueConst = new Schema({ type: 'const', value: { private: true } } as never)
    expect(project(Schema.object({ opaque: opaqueConst })).bindings.has(settingsField('opaque').fieldId)).toBe(false)
    const emptyObject = new Schema({ type: 'object' } as never)
    expect(project(emptyObject).bindings.size).toBe(0)
    const root = project(Schema.any())
    expect(JSON.stringify(root.node)).toContain('test')
  })

  it('projects explicit origins, configured secrets, scalar reset values, and non-resettable fields', () => {
    const schema = Schema.object({
      secret: Schema.string().role('secret'),
      text: Schema.string(),
      count: Schema.number().min(1).max(9).step(2),
      many: Schema.array(Schema.union(['a', 'b'])),
      requiredChoice: Schema.union(['one', 'two']).required(),
      optionalFlag: Schema.boolean(),
      requiredFlag: Schema.boolean().required(),
    })
    const descriptor: SettingsDescriptor = {
      ns: 'test' as never, revision: 0, applies: 'live', schema: schema.toJSON(),
      value: { secret: 'hidden', text: 'value', count: 3, many: ['b'], requiredChoice: 'one', optionalFlag: true, requiredFlag: true },
      user: { text: 'value' },
      base: { text: 'base', count: 5, optionalFlag: Symbol('invalid'), requiredFlag: true },
      secrets: [{ path: ['secret'], set: true }],
    }
    const projection = settingsProjection(descriptor, true, {}, key => key)
    expect(projection.bindings.get(settingsField('secret').fieldId)!.field).toMatchObject({ placeholder: 'Configured; leave unchanged' })
    expect(projection.bindings.get(settingsField('text').fieldId)!.field).toMatchObject({ origin: 'explicit', resetValue: 'base' })
    expect(projection.bindings.get(settingsField('count').fieldId)!.field).toMatchObject({ resetValue: 5, min: 1, max: 9, step: 2 })
    expect(projection.bindings.get(settingsField('many').fieldId)!.field).toMatchObject({ resetValue: [] })
    expect(projection.bindings.get(settingsField('requiredChoice').fieldId)!.field).not.toHaveProperty('resetValue')
    expect(projection.bindings.get(settingsField('optionalFlag').fieldId)!.field).not.toHaveProperty('resetValue')
    expect(projection.bindings.get(settingsField('requiredFlag').fieldId)!.field).toMatchObject({ resetValue: true })

    const notConfigured = settingsProjection({ ...descriptor, secrets: [{ path: ['secret'], set: false }, { path: ['other'], set: true }] }, true, {}, key => key)
    expect(notConfigured.bindings.get(settingsField('secret').fieldId)!.field).toMatchObject({ placeholder: 'Not configured' })
  })

  it('emits unchanged, reset, encoded array, and raw settings operations', () => {
    const projection = project(Schema.object({
      text: Schema.string().default('base'),
      many: Schema.array(Schema.union(['a', 'b'])).default(['a']),
      count: Schema.number(),
    }), { text: 'value', many: ['a'], count: 2 })
    const form = { pagePath: [], formId: 'settings-form', draftRevision: 0, fields: [
      { id: settingsField('text').fieldId, change: 'unchanged' as const, value: 'value' },
      { id: settingsField('text').fieldId, change: 'reset' as const },
      { id: settingsField('many').fieldId, change: 'set' as const, value: ['"a"', '"b"'] },
      { id: settingsField('count').fieldId, change: 'set' as const, value: 4 },
    ] }
    expect(settingsOperations(projection, form)).toEqual([
      { op: 'unset', path: ['text'] },
      { op: 'set', path: ['many'], value: ['a', 'b'] },
      { op: 'set', path: ['count'], value: 4 },
    ])
  })
})
