/** Native service fixtures shared by provider configuration and authorization tests.
 * @module @ephemeral-ai/mayfly/tests/interaction/provider-fixture
 */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CredentialProvider, type CredentialRef, type CredentialKey, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import * as uiProvider from '../../../ui/src/provider.ts'
import * as frontend from '../../src/frontend/index.ts'
import { providerStoreInternals } from '../../src/interaction/provider-store.ts'
import { MemorySettings } from '../../../../examples/overlay/tests/settings.ts'
import { InteractionStateService } from '../../src/interaction/runtime-state.ts'
import { DEFAULT_SETTINGS } from '../../src/interaction/settings.ts'

/** The in-memory home patch every fixture shares for provider-store writes. */
const homeFiles = new Map<string, string>()
let homeInstalled = false

/** Redirect provider-store file I/O into memory so specs never touch the real home. */
export function installProviderHome(): void {
  if (homeInstalled) return
  homeInstalled = true
  providerStoreInternals.homePatchPath = () => '/mayfly-test-home/cordis.patch.yml'
  providerStoreInternals.readTextFile = path => homeFiles.get(path)
  providerStoreInternals.writeTextFile = (path, text) => { homeFiles.set(path, text) }
  providerStoreInternals.removeFile = path => { homeFiles.delete(path) }
}

/** The in-memory home patch text, for provider-store assertions. */
export function testHomeText(): string | undefined {
  return homeFiles.get('/mayfly-test-home/cordis.patch.yml')
}

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

export async function providerFixture(ctx: Context, profiles: Record<string, unknown> = {}, llm?: unknown, options?: { readonly registerNamespace?: boolean, readonly onboarding?: boolean }) {
  installProviderHome()
  // The frontend tree owns this parent service in production; a standalone
  // fixture mounts it unless the spec already did (onboarding).
  if (ctx.get('mayflyInteractionState') === undefined) new InteractionStateService(ctx, DEFAULT_SETTINGS)
  await ctx.plugin(MemorySettings)
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(ProviderCommands)
  const namespace = options?.registerNamespace === false ? undefined : await ctx.plugin({ name: 'native-profile', inject: ['settings'], apply(owner: Context) {
    // The test double keeps the Loader-shaped registration seam the real
    // settings service no longer exposes on its public type.
    ;(owner.settings as unknown as MemorySettings).register('llm-pi-ai', z.object({ providers: z.dict(z.any()).default({}).volatile() }), { owner })
  } })
  if (Object.keys(profiles).length > 0) await ctx.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers'], value: profiles }])
  // Every production LlmRuntime lists providers; the specs' narrow doubles
  // only carry the methods under test, so the shared fixture fills the rest.
  if (llm !== undefined) ctx.provide('llm', { listProviders: () => [], listConfigurableProviders: () => [], ...(llm as object) } as never)
  // A first-run guide would open over every unrelated fixture; only the
  // onboarding spec opts in to the unconfigured shape.
  if (options?.onboarding !== true) (ctx.credentials as MemoryCredentials).values.set('DEEPSEEK_API_KEY', 'configured')
  await ctx.plugin(uiProvider)
  // Boot is explicit here: the onboarding specs select a primary Agent as the
  // app-ready signal, after they have provided the services the guide reads.
  let booted = false
  const listeners = new Set<() => void>()
  const markBooted = (): void => {
    if (booted) return
    booted = true
    for (const listener of [...listeners]) listener()
    listeners.clear()
  }
  ctx.provide('mayflySessionStart', {
    onBooted: (listener: () => void) => {
      if (booted) { listener(); return () => {} }
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    ensure: async () => null,
    markBooted,
  } as never)
  const front = await ctx.plugin(frontend)
  return { ctx, front, namespace, settings: ctx.settings as unknown as MemorySettings, credentials: ctx.credentials as MemoryCredentials, commands: ctx.commands as unknown as ProviderCommands }
}
