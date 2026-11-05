/** Secret redaction at programmatic preference write boundaries.
 * @module @ephemeral-ai/mayfly/app/features/settings-model
 */
import Schema from '@deepseek-ai/schemastery'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'

function property(value: unknown, key: string): unknown {
  return value !== null && (typeof value === 'object' || typeof value === 'function') && Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined
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
  return walk(new Schema(schemaValue as Partial<Schema>), value)
}
