/** Real presenter cache integration without a running terminal. @module tests/host-composition */
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { HostKey } from '../../src/client/types.ts'
import type { HostClient, SessionRef } from '../../src/client/types.ts'
import type { ConversationProjection } from '../../src/conversation.ts'
import { RemoteToolPresentationCache } from '../../src/hosts/tool-presentations.ts'

const setup = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('../../src/client/host-client.ts', () => ({ createHostClient: setup.create }))
vi.mock('@ephemeral-ai/mayfly-host/remote', () => ({ TYPERT_REMOTE: {} }))

import { attachMayflyHostClient, resolveMayflyToolPresentation } from '../../src/app/host-composition.ts'

const manifest = JSON.parse(readFileSync(new URL('../../../remote/package.json', import.meta.url), 'utf8')) as { version: string, dependencies: Record<string, string> }
const release = manifest.version
const harness = manifest.dependencies['@deepseek-ai/dsh-agent']!

function host(version = release) {
  const presentTools = vi.fn(async () => ({ ok: true, value: { presentations: { session: { call: { updatedSeq: 1 } } } } }))
  const detach = vi.fn(async () => {})
  const client = {
    key: HostKey('host'), detach,
    remote: {
      $mount: vi.fn(async () => {}),
      mayflyHost: {
        capabilities: vi.fn(async () => ({ ok: true, value: {
          protocolVersion: 1, hostVersion: version, requiredDshVersion: harness,
          features: ['mayflyConversation', 'presentTools'],
        } })),
        presentTools,
      },
    },
  } as unknown as HostClient
  return { client, presentTools, detach }
}

describe('validated Host presenter lifetime', () => {
  it.each([
    ['capability refusal', { ok: false, error: { code: 'missing', message: 'not composed' } }, 'capabilities request failed: not composed'],
    ['protocol mismatch', { ok: true, value: { protocolVersion: 2, hostVersion: release, requiredDshVersion: harness, features: ['mayflyConversation', 'presentTools'] } }, 'protocol 2 (required 1)'],
    ['Harness mismatch', { ok: true, value: { protocolVersion: 1, hostVersion: release, requiredDshVersion: '0.2.1-rc.2', features: ['mayflyConversation', 'presentTools'] } }, 'dsh version 0.2.1-rc.2'],
    ['missing presentation', { ok: true, value: { protocolVersion: 1, hostVersion: release, requiredDshVersion: harness, features: [] } }, 'missing features: mayflyConversation, presentTools'],
  ])('releases the Client after %s', async (_label, result, message) => {
    const { client, detach } = host()
    vi.mocked(client.remote.mayflyHost.capabilities).mockResolvedValueOnce(result as never)
    setup.create.mockResolvedValueOnce(client)
    await expect(attachMayflyHostClient(client.key, 'http://127.0.0.1/')).rejects.toThrow(message)
    expect(detach).toHaveBeenCalledOnce()
  })

  it('fills an unchanged tool once even when cache publication rebuilds the conversation', async () => {
    const { client, presentTools } = host()
    setup.create.mockResolvedValueOnce(client)
    await attachMayflyHostClient(client.key, 'http://127.0.0.1/?token=secret')
    const ref = { host: client.key, sessionId: 'session' } as SessionRef
    const projection = { entries: [{ kind: 'tool', callId: 'call', name: 'read', arguments: '{}', updatedSeq: 1 }] } as unknown as ConversationProjection
    const cache = new RemoteToolPresentationCache(selected => resolveMayflyToolPresentation(() => [client], selected))
    const rebuild = vi.fn(() => { cache.source(ref, projection) })
    const off = cache.subscribe(rebuild)
    cache.source(ref, projection)
    await vi.waitFor(() => { expect(rebuild).toHaveBeenCalledOnce() })
    for (let index = 0; index < 6; index += 1) {
      cache.source(ref, projection)
      await Promise.resolve()
    }
    expect(presentTools).toHaveBeenCalledOnce()
    expect(resolveMayflyToolPresentation(() => [client], ref)).toBe(resolveMayflyToolPresentation(() => [client], ref))
    off()
    await cache.dispose()
  })

  it('uses a new presenter when a Host Client is replaced and refuses unvalidated clients', async () => {
    const first = host()
    const second = host()
    setup.create.mockResolvedValueOnce(first.client).mockResolvedValueOnce(second.client)
    await attachMayflyHostClient(first.client.key, 'http://127.0.0.1/')
    await attachMayflyHostClient(second.client.key, 'http://127.0.0.1/')
    const ref = { host: first.client.key, sessionId: 'session' } as SessionRef
    expect(resolveMayflyToolPresentation(() => [first.client], ref).present).not.toBe(resolveMayflyToolPresentation(() => [second.client], ref).present)
    expect(() => resolveMayflyToolPresentation(() => [], ref)).toThrow('not attached')
    expect(() => resolveMayflyToolPresentation(() => [host().client], ref)).toThrow('no validated capabilities')
  })

  it('detaches an incompatible Host before exposing it to the application', async () => {
    const { client, detach } = host('incompatible')
    setup.create.mockResolvedValueOnce(client)
    await expect(attachMayflyHostClient(client.key, 'http://127.0.0.1/')).rejects.toThrow('Unsupported Mayfly Host')
    expect(detach).toHaveBeenCalledOnce()
  })
})
