/** Native service fixtures shared by provider configuration and authorization tests.
 * @module @ephemeral-ai/mayfly/tests/interaction/provider-fixture
 */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CredentialProvider, type CredentialRef, type CredentialKey, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import * as uiProvider from '../../../ui/src/provider.ts'
import * as frontend from '../../src/frontend/index.ts'
import { MemorySettings } from '../../../../examples/overlay/tests/settings.ts'

export class MemoryCredentials extends CredentialProvider {
  readonly values = new Map<string, string>([['CUSTOM_KEY', 'stored-secret']])
  readonly records = new Map<CredentialKey, CredentialRecord>()
  writes = 0
  failWrite = false
  async resolve(ref: CredentialRef) { const value = this.values.get(String(ref)); return value === undefined ? undefined : { value, source: 'memory' } }
  async describe(ref: CredentialRef) { return { configured: this.values.has(String(ref)), writable: true, source: 'memory' } }
  async set(ref: CredentialRef, value: string): Promise<void> {
    if (this.failWrite) throw new Error('unavailable')
    this.values.set(String(ref), value); this.writes += 1; this.ctx.emit('credentials/reference-updated', ref)
  }
  async unset(ref: CredentialRef): Promise<void> { this.values.delete(String(ref)); this.ctx.emit('credentials/reference-updated', ref) }
  async readRecord(key: CredentialKey) { return this.records.get(key) }
  async describeRecord(key: CredentialKey) { const record = this.records.get(key); return { configured: record !== undefined, writable: true, ...(record === undefined ? {} : { kind: record.kind }) } }
  async listRecords() { return [...this.records].map(([key, value]) => ({ key, kind: value.kind })) }
  async modifyRecord(key: CredentialKey, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) {
    const record = await mutate(this.records.get(key))
    if (record === undefined) this.records.delete(key)
    else this.records.set(key, record)
    this.ctx.emit('credentials/record-updated', key)
    return record
  }
  async deleteRecord(key: CredentialKey): Promise<void> { this.records.delete(key); this.ctx.emit('credentials/record-updated', key) }
}

export class ProviderCommands extends Service {
  readonly entries = new Map<string, { readonly handler: (request: never) => unknown }>()
  constructor(ctx: Context) { super(ctx, 'commands') }
  register(definition: { readonly name: string, readonly handler: (request: never) => unknown }) {
    this.entries.set(definition.name, definition)
    return this.ctx.effect(() => () => { this.entries.delete(definition.name) })
  }
}

export async function providerFixture(ctx: Context, profiles: Record<string, unknown> = {}, llm?: unknown) {
  await ctx.plugin(MemorySettings)
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(ProviderCommands)
  const namespace = await ctx.plugin({ name: 'native-profile', inject: ['settings'], apply(owner: Context) {
    owner.settings.register('llm-pi-ai', z.object({ providers: z.dict(z.any()).default({}) }))
  } })
  if (Object.keys(profiles).length > 0) await ctx.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers'], value: profiles }])
  if (llm !== undefined) ctx.provide('llm', llm as never)
  await ctx.plugin(uiProvider)
  const front = await ctx.plugin(frontend)
  return { ctx, front, namespace, settings: ctx.settings as MemorySettings, credentials: ctx.credentials as MemoryCredentials, commands: ctx.commands as unknown as ProviderCommands }
}
