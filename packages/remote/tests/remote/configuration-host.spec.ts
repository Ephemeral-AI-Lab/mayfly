/** Native configuration DTOs preserve confirmed receipts and exact Host lifetimes. @module */
import { describe, expect, it, vi } from 'vitest'
import type { MayflyAuthorizationFrame } from '@ephemeral-ai/mayfly-host/types'
import type { HostClient } from '../../src/client/types.ts'
import { RemoteConfigurationHost } from '../../src/remote/features/configuration-host.ts'
import { configurationFixture, deferred } from './configuration-fixture.ts'

const ok = (value: unknown) => ({ ok: true, value })
const route = { provider: 'deepseek', model: 'pro' }
const features = ['modelCatalogDetails', 'defaultModel', 'permissionCatalogDetails', 'settingsDocument', 'providerBalance', 'authorization']

function fixture() {
  const base = configurationFixture(vi.fn(), { session: false })
  const frames: MayflyAuthorizationFrame[] = []
  const stream = {
    async *[Symbol.asyncIterator]() { yield* frames },
    send: vi.fn(), dispose: vi.fn(),
  }
  const native = {
    capabilities: vi.fn(async (): Promise<unknown> => ok({ features })),
    modelCatalogDetails: vi.fn(async (): Promise<unknown> => ok({ items: [{ provider: 'deepseek', id: 'pro', contextWindow: 131072, efforts: ['high', 'low'], defaultEffort: 'high' }] })),
    defaultModel: vi.fn(async (): Promise<unknown> => ok(route)),
    permissionCatalogDetails: vi.fn(async (): Promise<unknown> => ok({ yolo: true, specs: { safe: { sandbox: 'read-only', approval: 'ask' } } })),
    readSettingsDocument: vi.fn(async (): Promise<unknown> => ok({ content: 'theme: dark\n', revision: 'original' })),
    writeSettingsDocument: vi.fn(async (): Promise<unknown> => ok({ content: 'theme: light\n', revision: 'confirmed' })),
    providerBalance: vi.fn(async (): Promise<unknown> => ok({ available: true, balance: '5' })),
    authorize: vi.fn(() => stream),
  }
  Object.assign(base.client.remote, { mayflyHost: native })
  const confirmed = vi.fn()
  const host = new RemoteConfigurationHost(base.hosts, confirmed)
  const interaction = { notice: vi.fn(), prompt: vi.fn(async (_prompt: unknown): Promise<{ type: 'answer', value: string } | undefined> => ({ type: 'answer', value: 'approved' })) }
  return { ...base, host, native, confirmed, frames, stream, interaction }
}

describe('Remote configuration native DTO adapters', () => {
  it('reads native merged metadata without inventing data for unknown models', async () => {
    const f = fixture()
    const detail = (await f.host.load(f.client))!
    expect(detail.contextWindow('deepseek', 'pro')).toBe(131072)
    expect(detail.efforts('deepseek', 'pro')).toEqual(['high', 'low'])
    expect(detail.defaultEffort('deepseek', 'pro')).toBe('high')
    expect(detail.contextWindow('deepseek', 'unknown')).toBeUndefined()
    expect(detail.efforts('other', 'pro')).toBeUndefined()
    expect(detail.defaultEffort('other', 'pro')).toBeUndefined()
    expect(f.native.modelCatalogDetails).toHaveBeenCalledExactlyOnceWith({}, expect.any(AbortSignal))
    f.dispose()
  })

  it('publishes only a native-confirmed default selection, with explicit effort preserved', async () => {
    const f = fixture()
    expect(await f.host.read(f.client)).toEqual(route)
    expect(f.confirmed).not.toHaveBeenCalled()
    f.native.defaultModel.mockResolvedValueOnce(ok({ ...route, model: 'canonical', reasoningEffort: 'high' }))
    expect(await f.host.select(f.client, route)).toEqual({ ...route, model: 'canonical', reasoningEffort: 'high' })
    expect(f.confirmed).toHaveBeenCalledExactlyOnceWith(f.client, { ...route, model: 'canonical', reasoningEffort: 'high' })
    expect(f.native.defaultModel).toHaveBeenLastCalledWith({ operation: 'select', ...route }, expect.any(AbortSignal))
    await new RemoteConfigurationHost(f.hosts).select(f.client, { ...route, reasoningEffort: 'low' as never })
    expect(f.native.defaultModel).toHaveBeenLastCalledWith({ operation: 'select', ...route, reasoningEffort: 'low' }, expect.any(AbortSignal))
    f.dispose()
  })

  it('maps native resolved permission facts, retaining an unknown row as unknown', async () => {
    const f = fixture()
    const current = (await f.host.resolve(f.client, 'safe'))!
    expect(current.yolo).toBe(true)
    expect(current.spec('safe')).toEqual({ sandbox: 'read-only', approval: 'ask' })
    expect(current.detail('safe')).toBe('sandbox read-only · approval ask')
    expect(current.spec('unknown')).toBeUndefined()
    expect(current.detail('unknown')).toBeUndefined()
    expect(f.native.permissionCatalogDetails).toHaveBeenLastCalledWith({ currentPreset: 'safe' }, expect.any(AbortSignal))
    await f.host.resolve(f.client)
    expect(f.native.permissionCatalogDetails).toHaveBeenLastCalledWith({}, expect.any(AbortSignal))
    f.dispose()
  })

  it('uses the original document revision and returns native document and balance receipts', async () => {
    const f = fixture()
    expect(await f.host.readDocument(f.client)).toEqual({ content: 'theme: dark\n', revision: 'original' })
    expect(await f.host.writeDocument(f.client, 'theme: light\n', 'original')).toEqual({ content: 'theme: light\n', revision: 'confirmed' })
    expect(f.native.writeSettingsDocument).toHaveBeenCalledExactlyOnceWith({ content: 'theme: light\n', expectedRevision: 'original' }, expect.any(AbortSignal))
    expect(await f.host.balance(f.client)).toEqual({ available: true, balance: '5' })
    f.dispose()
  })

  it('refuses detached Hosts without making a native call', async () => {
    const f = fixture()
    f.detach()
    expect(await f.host.load(f.client)).toBeUndefined()
    expect(await f.host.resolve(f.client)).toBeUndefined()
    expect(await f.host.balance(f.client)).toBeUndefined()
    expect(await f.host.authorize(f.client, 'key', undefined, f.interaction)).toBe('cancelled')
    for (const read of [() => f.host.read(f.client), () => f.host.select(f.client, route), () => f.host.readDocument(f.client), () => f.host.writeDocument(f.client, '', 'revision')]) {
      await expect(read()).rejects.toThrow('Host is no longer attached')
    }
    expect(f.native.capabilities).not.toHaveBeenCalled()
    f.dispose()
  })

  it('distinguishes absent optional features from failed required writes', async () => {
    const f = fixture()
    f.native.capabilities.mockImplementation(async () => ok({ features: [] }))
    expect(await f.host.load(f.client)).toBeUndefined()
    expect(await f.host.resolve(f.client)).toBeUndefined()
    expect(await f.host.balance(f.client)).toBeUndefined()
    for (const [feature, read] of [
      ['defaultModel', () => f.host.read(f.client)], ['defaultModel', () => f.host.select(f.client, route)],
      ['settingsDocument', () => f.host.readDocument(f.client)], ['settingsDocument', () => f.host.writeDocument(f.client, '', 'revision')],
      ['authorization', () => f.host.authorize(f.client, 'key', undefined, f.interaction)],
    ] as const) await expect(read()).rejects.toThrow(`${feature} is unavailable on this Host`)
    expect(f.native.defaultModel).not.toHaveBeenCalled()
    expect(f.native.authorize).not.toHaveBeenCalled()
    f.dispose()
  })

  it.each(['load', 'resolve', 'balance'] as const)('keeps optional %s data unknown after a native rejection', async method => {
    const f = fixture()
    f.native.capabilities.mockRejectedValue(new Error('connection ended'))
    expect(await f.host[method](f.client)).toBeUndefined()
    f.dispose()
  })

  it.each(['load', 'resolve', 'balance', 'read', 'select', 'readDocument', 'writeDocument'] as const)('drops a %s answer after the exact Host reconnects', async method => {
    const f = fixture()
    const answer = deferred<unknown>()
    const call = {
      load: ['modelCatalogDetails', () => f.host.load(f.client), { items: [] }],
      resolve: ['permissionCatalogDetails', () => f.host.resolve(f.client), { specs: {} }],
      balance: ['providerBalance', () => f.host.balance(f.client), {}],
      read: ['defaultModel', () => f.host.read(f.client), route],
      select: ['defaultModel', () => f.host.select(f.client, route), route],
      readDocument: ['readSettingsDocument', () => f.host.readDocument(f.client), {}],
      writeDocument: ['writeSettingsDocument', () => f.host.writeDocument(f.client, '', 'original'), {}],
    } as const
    const [name, start, value] = call[method]
    f.native[name].mockReturnValueOnce(answer.promise)
    const reading = start()
    const observed = reading.then(value => ({ value }), error => ({ error: error as Error }))
    await vi.waitFor(() => { expect(f.native[name]).toHaveBeenCalledOnce() })
    f.reconnect()
    answer.resolve(ok(value))
    const result = await observed
    if (method === 'load' || method === 'resolve' || method === 'balance') expect(result).toEqual({ value: undefined })
    else expect(result).toMatchObject({ error: { message: 'Host is no longer attached' } })
    expect(f.confirmed).not.toHaveBeenCalled()
    f.dispose()
  })

  it('drops confirmed writes after caller cancellation or active Host replacement', async () => {
    for (const invalidate of ['abort', 'replace'] as const) {
      const f = fixture()
      const answer = deferred<unknown>()
      const lifetime = new AbortController()
      f.native.defaultModel.mockReturnValueOnce(answer.promise)
      const changing = f.host.select(f.client, route, lifetime.signal)
      const observed = changing.catch((error: unknown) => error)
      await vi.waitFor(() => { expect(f.native.defaultModel).toHaveBeenCalledOnce() })
      if (invalidate === 'abort') lifetime.abort()
      else f.active({ ...f.client } as HostClient)
      answer.resolve(ok(route))
      expect(await observed).toMatchObject({ message: 'Host is no longer attached' })
      expect(f.confirmed).not.toHaveBeenCalled()
      f.dispose()
    }
  })

  it.each(['read', 'select', 'authorize'] as const)('never starts %s after a stale capability probe', async method => {
    const f = fixture()
    const capabilities = deferred<unknown>()
    f.native.capabilities.mockReturnValueOnce(capabilities.promise)
    const reading = method === 'read' ? f.host.read(f.client)
      : method === 'select' ? f.host.select(f.client, route)
        : f.host.authorize(f.client, 'account', undefined, f.interaction)
    const observed = reading.catch((error: unknown) => error)
    f.reconnect()
    capabilities.resolve(ok({ features }))
    expect(await observed).toMatchObject({ message: 'Host is no longer attached' })
    expect(f.native.defaultModel).not.toHaveBeenCalled()
    expect(f.native.authorize).not.toHaveBeenCalled()
    f.dispose()
  })

  it('forwards acknowledged native authorization answers with exact operation and prompt IDs', async () => {
    const f = fixture()
    const prompts = [
      { kind: 'select' as const, message: 'Choose account', options: [{ id: 'team', label: 'Team', description: 'Shared account' }] },
      { kind: 'text' as const, message: 'Paste code', placeholder: 'code' },
      { kind: 'secret' as const, message: 'Paste key' },
    ]
    f.frames.push({ type: 'started', operationId: 'operation' }, { type: 'notice', operationId: 'operation', notice: { kind: 'text', text: 'Opening account' } as never },
      ...prompts.map((prompt, index) => ({ type: 'prompt' as const, operationId: 'operation', promptId: String(index), prompt })),
      { type: 'prompt-ended', operationId: 'operation', promptId: '0' }, { type: 'settled', operationId: 'operation', status: 'authorized' })
    expect(await f.host.authorize(f.client, 'account', 'oauth', f.interaction)).toBe('authorized')
    expect(f.native.authorize).toHaveBeenCalledExactlyOnceWith({ key: 'account', method: 'oauth' }, expect.any(AbortSignal))
    expect(f.interaction.notice).toHaveBeenCalledExactlyOnceWith({ kind: 'text', text: 'Opening account' })
    expect(f.interaction.prompt.mock.calls.map(([prompt]) => prompt)).toEqual(prompts)
    expect(f.stream.send.mock.calls.map(([answer]) => answer)).toEqual(prompts.map((_prompt, index) => ({ type: 'answer', operationId: 'operation', promptId: String(index), value: 'approved' })))
    expect(f.stream.dispose).toHaveBeenCalledOnce()
    f.dispose()
  })

  it('declines a dismissed authorization prompt, without inventing a settled outcome', async () => {
    const f = fixture()
    f.interaction.prompt.mockResolvedValueOnce(undefined)
    f.frames.push({ type: 'prompt', operationId: 'op', promptId: 'prompt', prompt: { kind: 'text', message: 'Code' } })
    expect(await f.host.authorize(f.client, 'account', undefined, f.interaction)).toBe('cancelled')
    expect(f.native.authorize).toHaveBeenCalledWith({ key: 'account' }, expect.any(AbortSignal))
    expect(f.stream.send).toHaveBeenCalledExactlyOnceWith({ type: 'decline', operationId: 'op', promptId: 'prompt' })
    expect(f.stream.dispose).toHaveBeenCalledOnce()
    f.dispose()
  })

  it('does not present notice or prompt frames that arrive after reconnect', async () => {
    const f = fixture()
    const lifetime = deferred<void>()
    f.stream[Symbol.asyncIterator] = async function* () {
      await lifetime.promise
      yield { type: 'notice', operationId: 'op', notice: { kind: 'text', text: 'Late secret instructions' } as never }
      yield { type: 'prompt', operationId: 'op', promptId: 'prompt', prompt: { kind: 'secret', message: 'Late secret prompt' } }
    }
    const authorizing = f.host.authorize(f.client, 'account', undefined, f.interaction)
    await vi.waitFor(() => { expect(f.native.authorize).toHaveBeenCalledOnce() })
    f.reconnect()
    lifetime.resolve()
    expect(await authorizing).toBe('cancelled')
    expect(f.interaction.notice).not.toHaveBeenCalled()
    expect(f.interaction.prompt).not.toHaveBeenCalled()
    expect(f.stream.send).toHaveBeenCalledExactlyOnceWith({ type: 'decline', operationId: 'op', promptId: 'prompt' })
    f.dispose()
  })

  it('declines an acknowledged answer that settles after its exact Host generation changes', async () => {
    const f = fixture()
    const answer = deferred<{ type: 'answer', value: string }>()
    f.interaction.prompt.mockReturnValueOnce(answer.promise)
    f.frames.push({ type: 'prompt', operationId: 'op', promptId: 'prompt', prompt: { kind: 'secret', message: 'Code' } })
    const authorizing = f.host.authorize(f.client, 'account', undefined, f.interaction)
    await vi.waitFor(() => { expect(f.interaction.prompt).toHaveBeenCalledOnce() })
    f.reconnect()
    answer.resolve({ type: 'answer', value: 'stale secret' })
    expect(await authorizing).toBe('cancelled')
    expect(f.stream.send).toHaveBeenCalledExactlyOnceWith({ type: 'decline', operationId: 'op', promptId: 'prompt' })
    expect(JSON.stringify(f.stream.send.mock.calls)).not.toContain('stale secret')
    f.dispose()
  })

  it('always disposes a failed native authorization stream', async () => {
    const f = fixture()
    f.stream[Symbol.asyncIterator] = async function* () {
      yield await Promise.reject<MayflyAuthorizationFrame>(new Error('authorization ended'))
    }
    await expect(f.host.authorize(f.client, 'account', undefined, f.interaction)).rejects.toThrow('authorization ended')
    expect(f.stream.dispose).toHaveBeenCalledOnce()
    f.dispose()
  })
})
