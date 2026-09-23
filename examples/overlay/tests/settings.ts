/** In-memory `SettingsForms` surface for external-consumer tests.
 * @module @mayfly-example/overlay/tests/settings
 */
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { redactSecrets, SettingsConflictError, type SettingsDescriptor, type SettingsNamespace, type SettingsPathOp } from '@deepseek-ai/dsh-settings'

/** The volatile-cell shape the Loader wraps `.volatile()` schema fields in. */
const isVolatile = (value: unknown): value is { get(): unknown } =>
  value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function'

/** Unwrap volatile cells so descriptors expose plain form values like the native service. */
const plain = (value: unknown): unknown =>
  isVolatile(value) ? plain(value.get())
    : Array.isArray(value) ? value.map(plain)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, plain(child)]))
      : value

/** The native service's form-schema rewrite: volatile markers and secret defaults never reach form clients. */
function plainSchema(schema: Schema): Schema {
  const result = new Schema(schema.toJSON() as never)
  const walk = (node: Schema): void => {
    delete node.meta.volatile
    if (node.meta.role === 'secret') {
      delete node.meta.default
      delete node.meta.required
    } else if (node.meta.default !== undefined) node.meta.default = redactSecrets(node as never, node.meta.default).value
    for (const child of Object.values(node.dict ?? {})) walk(child)
    if (node.inner !== undefined) walk(node.inner)
    for (const child of node.list ?? []) walk(child)
  }
  walk(result)
  return result
}

/** The native projection: only fields beneath a volatile marker are form-editable. */
function volatileForm(schema: Schema): Schema | undefined {
  if (schema.meta.volatile === true) return plainSchema(schema)
  if (schema.type === 'object') {
    const dict = Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
      const field = volatileForm(child)
      return field === undefined ? [] : [[key, field]]
    }))
    return Object.keys(dict).length === 0 ? undefined : Schema.object(dict)
  }
}

/** Whether a field path lies beneath a declared volatile node (the native write check). */
function isVolatilePath(schema: Schema, path: readonly string[]): boolean {
  if (schema.meta.volatile === true) return true
  const [key, ...rest] = path
  const child = key === undefined ? undefined : schema.dict?.[key]
  return child !== undefined && isVolatilePath(child, rest)
}

/** Deep-merge ordinary objects; every other value replaces. */
const merge = (base: unknown, layer: unknown): unknown =>
  base !== null && layer !== null && typeof base === 'object' && typeof layer === 'object' && !Array.isArray(base) && !Array.isArray(layer)
    ? Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(layer)])].map(key => [
        key,
        Object.hasOwn(layer, key) ? merge((base as Record<string, unknown>)[key], (layer as Record<string, unknown>)[key]) : (base as Record<string, unknown>)[key],
      ]))
    : layer

/** Detach JSON-shaped input the way the native service does: writes never alias caller objects. */
const clone = (value: unknown): unknown =>
  value !== null && typeof value === 'object'
    ? Array.isArray(value) ? value.map(clone)
      : Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, clone(child)]))
    : value

/** Read a dotted path out of a raw section. */
const member = (node: unknown, key: string): unknown =>
  node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined

interface MemoryEntry {
  schema: Schema
  base: Record<string, unknown>
  user: Record<string, unknown>
  revision: number
}

/**
 * A `settings` service double keyed like the native one: `register()` stands
 * in for a profile patch row (the stored constructor document is that row's
 * user section), `describe()` projects resolved values, and the path-op
 * writes bump revisions and emit `settings/document-updated`.
 */
export class MemorySettings extends Service {
  readonly writable = true
  readonly documentPath = ''
  private readonly document: Record<string, unknown>
  private readonly entries = new Map<string, MemoryEntry>()
  /** Removals the native sweep reports on the next describe(), not eagerly at unload. */
  private readonly removed = new Map<string, number>()
  writes = 0

  constructor(ctx: Context, document?: Record<string, unknown>) {
    super(ctx, 'settings')
    this.document = document ?? {}
  }

  /** Seed the namespace a patch row would own; `base` is its composition layer and `owner` unloads it like the row's Fiber. */
  register(ns: string, schema: Schema, options: { readonly base?: Record<string, unknown>, readonly owner?: Context } = {}): void {
    if (this.entries.has(ns)) throw new Error(`settings namespace "${ns}" already registered`)
    const stored = this.document[ns]
    const entry: MemoryEntry = {
      schema,
      base: clone(options.base ?? {}) as Record<string, unknown>,
      user: stored !== null && typeof stored === 'object' ? clone(stored) as Record<string, unknown> : {},
      revision: 0,
    }
    this.entries.set(ns, entry)
    this.removed.delete(ns)
    this.ctx.emit('settings/document-updated', ns as SettingsNamespace, 0)
    options.owner?.effect(() => () => {
      if (!this.entries.delete(ns)) return
      entry.revision += 1
      this.removed.set(ns, entry.revision)
    })
  }

  private entry(ns: string): MemoryEntry {
    const entry = this.entries.get(ns)
    if (entry === undefined) throw new Error(`No configurable plugin entry "${ns}"`)
    if (volatileForm(entry.schema) === undefined) throw new Error(`Plugin entry "${ns}" has no volatile fields`)
    return entry
  }

  private resolved(entry: MemoryEntry): unknown {
    return plain(entry.schema(merge(entry.base, entry.user)))
  }

  /** The resolved section value (schema defaults → base → user), for test reads. */
  get(ns: string): unknown {
    return this.resolved(this.entry(ns))
  }

  describe(options?: { redactSecrets?: boolean }): SettingsDescriptor[] {
    for (const [ns, revision] of this.removed) {
      this.removed.delete(ns)
      this.ctx.emit('settings/document-updated', ns as SettingsNamespace, revision)
    }
    return [...this.entries.entries()].flatMap(([ns, entry]) => {
      const form = volatileForm(entry.schema)
      // The native service enumerates only entries with live-editable fields.
      if (form === undefined) return []
      const value = this.resolved(entry)
      const base = plain(entry.schema(entry.base))
      const redacted = redactSecrets(form as never, value)
      return [{
        ns: ns as SettingsNamespace,
        autoGenerate: true,
        schema: form.toJSON(),
        revision: entry.revision,
        applies: 'live' as const,
        value: options?.redactSecrets === true ? redacted.value : value,
        base,
        user: { ...entry.user },
        ...(options?.redactSecrets === true ? { secrets: redacted.secrets } : {}),
      }]
    })
  }

  private check(entry: MemoryEntry, ns: string, expected?: number): void {
    if (expected !== undefined && entry.revision !== expected) throw new SettingsConflictError(ns as SettingsNamespace, expected, entry.revision)
  }

  private commit(ns: string, entry: MemoryEntry, user: Record<string, unknown>): void {
    entry.user = user
    entry.revision += 1
    this.writes += 1
    this.ctx.emit('settings/document-updated', ns as SettingsNamespace, entry.revision)
  }

  async update(ns: string, patch: object, expectedRevision?: number): Promise<void> {
    const entry = this.entry(ns)
    this.check(entry, ns, expectedRevision)
    this.commit(ns, entry, merge(entry.user, clone(patch)) as Record<string, unknown>)
  }

  async replace(ns: string, section: object, expectedRevision?: number): Promise<void> {
    const entry = this.entry(ns)
    this.check(entry, ns, expectedRevision)
    this.commit(ns, entry, clone(section) as Record<string, unknown>)
  }

  async mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void> {
    const entry = this.entry(ns)
    this.check(entry, ns, expectedRevision)
    const user = clone(entry.user) as Record<string, unknown>
    const ensure = (path: readonly string[]): Record<string, unknown> => {
      let node = user
      for (const segment of path) {
        const child = member(node, segment)
        if (child !== null && typeof child === 'object') node = child as Record<string, unknown>
        else node = (node[segment] = {}) as Record<string, unknown>
      }
      return node
    }
    for (const op of ops) {
      if (op.path.length > 0 && !isVolatilePath(entry.schema, op.path)) throw new Error(`Config field "${op.path.join('.')}" is not volatile`)
      const key = op.path.at(-1)!
      if (op.op === 'set') {
        ensure(op.path.slice(0, -1))[key] = clone(op.value)
      } else {
        // The native service restores the inherited layer when one exists.
        const inherited = op.path.reduce<unknown>((node, pathKey) => member(node, pathKey), entry.base)
        if (inherited === undefined) {
          const parent = op.path.slice(0, -1).reduce<unknown>((node, pathKey) => member(node, pathKey), user)
          if (parent !== null && typeof parent === 'object') delete (parent as Record<string, unknown>)[key]
        } else ensure(op.path.slice(0, -1))[key] = inherited
      }
    }
    this.commit(ns, entry, user)
  }

  async prepareDocument(): Promise<string> {
    return this.documentPath
  }

  configure(): () => void {
    return () => {}
  }
}
