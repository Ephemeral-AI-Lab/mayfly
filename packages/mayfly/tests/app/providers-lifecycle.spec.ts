/** Real Cordis provider overlays, renderer, acknowledged authorization and native settings/credential boundaries. @module */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SettingsDescribeValue, SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { MayflyOverlayEntry, MayflyUiActionEvent } from '@ephemeral-ai/mayfly-ui'
import { visibleWidth } from '../../src/core.ts'
import { RemoteProvidersController, type RemoteAuthorizationInteraction } from '../../src/app/features/providers.ts'
import { CordisRemoteLocalPresentation } from '../../src/app/features/presentation.ts'
import { taskFixture, tick, good } from './task-feature-fixture.ts'
import { namespace } from './configuration-fixture.ts'

const metadata = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('../../src/configuration-panels.ts', async original => ({ ...await original<object>(), loadModelsDevIndex: metadata }))
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks() })

async function fixture() {
  const f = await taskFixture()
  let settings: SettingsDescribeValue = { writable: true, hasDocument: true, namespaces: [namespace('llm-pi-ai', { value: { providers: { native: { displayName: 'Native provider', apiKeyEnv: 'NATIVE_API_KEY', models: [{ id: 'chat' }] } } } })] }
  const mutate = vi.fn(async (_ns: string, operations: readonly SettingsPathOpView[], revision: number) => {
    const current = settings.namespaces[0]!
    expect(revision).toBe(current.revision)
    const value = structuredClone(current.value) as Record<string, unknown>
    for (const operation of operations) {
      let target = value
      for (const segment of operation.path.slice(0, -1)) { target[segment] ??= {}; target = target[segment] as Record<string, unknown> }
      if (operation.op === 'set') target[operation.path.at(-1)!] = operation.value
      else delete target[operation.path.at(-1)!]
    }
    const saved = { ...current, revision: revision + 1, value: value as SettingsNamespaceView['value'] }
    settings = { ...settings, namespaces: [saved] }
    return good(saved)
  })
  const native = {
    llm: { listProviders: vi.fn(async () => good([{ id: 'native', name: 'Native provider' }])), listConfigurableProviders: vi.fn(async () => good(['native', 'oauth'].map(provider => ({ provider, displayName: provider, settingsNs: 'llm-pi-ai', settingsPath: ['providers', provider], declared: true })))), discoverModels: vi.fn(async () => good([{ id: 'discovered', contextWindow: 8192 }])) },
    settings: { describe: vi.fn(async () => good(settings)), mutate },
    credentials: { describe: vi.fn(async (refs: readonly string[]) => good(Object.fromEntries(refs.map(ref => [ref, { configured: true, writable: true }])))), set: vi.fn(async (_ref: string, _value: string) => good(undefined)), unset: vi.fn(async (_ref: string) => good(undefined)) },
  }
  Object.assign(f.client.remote, native)
  const authorize = vi.fn(async (_client: unknown, _key: string, _method: string | undefined, _interaction: RemoteAuthorizationInteraction, _signal?: AbortSignal): Promise<'authorized' | 'cancelled'> => 'authorized')
  const created = vi.fn(async (_route: string) => {})
  const copy = vi.fn(async (_text: string) => {})
  const presentation = new CordisRemoteLocalPresentation(f.options)
  const controller = new RemoteProvidersController({ ...f.options, presentation }, undefined, { authorize }, undefined, { copy }, created)
  cleanups.push(async () => { controller.dispose(); presentation.dispose(); await f.dispose() })
  const panel = (prefix: string) => f.ctx.mayflyOverlays.list().find(row => row.id.startsWith(prefix))!
  let sequence = 0
  const prepare = async (row: MayflyOverlayEntry, event: MayflyUiActionEvent) => await row.events.prepare(event, { surfaceId: row.id, source: row.source, revision: row.revision, operationId: `provider-native-${++sequence}`, signal: new AbortController().signal, report: vi.fn() })
  const act = async (row: MayflyOverlayEntry, event: MayflyUiActionEvent) => { const result = await prepare(row, event); result.publish(); return result.reply }
  return { ...f, native, controller, authorize, created, copy, panel, prepare, act }
}

describe('real provider UI/native lifecycle', () => {
  it('preserves a confirmed native profile revision after credential failure and fences the old overlay after reconnect', async () => {
    const f = await fixture()
    await f.controller.openEditor(f.client, 'native'); await tick()
    const id = `mayfly.provider.${Buffer.from('native').toString('hex')}`
    const original = f.panel(id)
    expect(JSON.stringify(original.node)).toContain('discovered')
    for (const width of [12, 40, 80, 120]) expect(f.render(original.node, width).every(row => visibleWidth(row) <= width)).toBe(true)
    f.native.credentials.set.mockRejectedValueOnce(new Error('write-only credential refused'))
    const submit = (name: boolean): MayflyUiActionEvent => ({ kind: 'submit', controlId: 'provider-actions', pagePath: [], submission: { actionId: 'save', draftRevision: 1, source: f.panel(id).source, forms: [
      ...name ? [{ formId: 'provider', draftRevision: 1, pagePath: [{ controlId: 'provider-pages', itemId: 'connection' }], fields: [{ id: 'name', value: 'Confirmed native name', change: 'set' as const }] }] : [],
      { formId: 'provider', draftRevision: 1, pagePath: [{ controlId: 'provider-pages', itemId: 'credentials' }], fields: [{ id: 'key', value: 'write-only-secret', change: 'set' }] },
    ] } })
    expect(await f.act(f.panel(id), submit(true))).toMatchObject({ kind: 'failed', acceptedFields: [{ fieldId: 'name' }], message: 'Provider settings saved, but the credential could not be saved' })
    expect(f.panel(id).source[0]?.revision).toBe(8)
    expect(JSON.stringify(f.panel(id).node)).toContain('Confirmed native name'); expect(JSON.stringify(f.panel(id).node)).not.toContain('write-only-secret')
    expect(await f.act(f.panel(id), submit(false))).toMatchObject({ kind: 'accepted' })
    expect(f.native.settings.mutate).toHaveBeenCalledOnce(); expect(f.native.credentials.set).toHaveBeenCalledTimes(2)
    const staleSubmission = submit(false)
    f.reconnect(); expect(f.ctx.mayflyOverlays.list()).toEqual([])
    expect(await f.act(original, staleSubmission)).toBeUndefined()
    expect(f.native.credentials.set).toHaveBeenCalledTimes(2)
  })

  it('sends a native authorization answer only after the actual overlay publishes its acknowledgement', async () => {
    const f = await fixture()
    const replied = vi.fn()
    f.authorize.mockImplementationOnce(async (_client, _key, _method, interaction) => {
      interaction.notice({ message: 'Native browser sign-in', url: 'https://auth.example/native', code: 'CODE-你好' })
      replied(await interaction.prompt({ kind: 'secret', message: 'Native challenge response' }))
      return 'authorized'
    })
    await f.controller.openAuthorize(f.client, 'oauth')
    const main = f.panel('mayfly.authorization.')
    const running = f.prepare(main, { kind: 'activate', controlId: 'authorization-actions', actionId: 'start', pagePath: [] })
    await tick()
    const prompt = f.ctx.mayflyOverlays.list().find(row => row.id.includes('.prompt.'))!
    expect(prompt).toBeDefined(); expect(JSON.stringify(prompt.node)).toContain('Native challenge response')
    const answer = await f.prepare(prompt, { kind: 'submit', controlId: 'authorization-prompt-actions', pagePath: [], submission: { actionId: 'submit-answer', draftRevision: 1, source: prompt.source, forms: [{ formId: 'authorization-answer', draftRevision: 1, pagePath: [], fields: [{ id: 'answer', value: 'native-one-time-answer', change: 'set' }] }] } })
    expect(answer.reply).toMatchObject({ kind: 'accepted', dismiss: true }); expect(replied).not.toHaveBeenCalled(); expect(f.native.settings.mutate).not.toHaveBeenCalled()
    answer.publish()
    const completed = await running
    expect(completed.reply).toMatchObject({ kind: 'accepted', feedback: { message: 'Authorization completed' } }); completed.publish()
    expect(replied).toHaveBeenCalledExactlyOnceWith({ type: 'answer', value: 'native-one-time-answer' }); expect(f.created).toHaveBeenCalledWith('oauth', undefined)
    expect(f.ctx.mayflyOverlays.list().some(row => row.id.includes('.prompt.'))).toBe(false)
    f.detach(); expect(f.ctx.mayflyOverlays.list()).toEqual([])
  })
})
