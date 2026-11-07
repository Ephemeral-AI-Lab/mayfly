import { describe, expect, it, vi } from 'vitest'
import type { HostClient } from '../../src/client/types.ts'
import { hasMayflyHostFeature, unavailableCapability } from '../../src/app/features/capabilities.ts'

/** One successful Host capability read advertising exactly the given features. */
function capabilities(features: readonly string[]): unknown {
  return { ok: true, value: { protocolVersion: 1, hostVersion: '0.1.4', requiredDshVersion: '0.1.0', features } }
}

/** One failed Host capability read carrying the safe Host code and message. */
function failed(code: string, message: string): unknown {
  return { ok: false, error: { code, message } }
}

function fixture(result: () => Promise<unknown> = async () => capabilities(['mcpCatalog'])) {
  const probe = vi.fn(async () => await result())
  const client = { remote: { mayflyHost: { capabilities: probe } } } as unknown as HostClient
  return { client, probe }
}

describe('hasMayflyHostFeature', () => {
  it('reports an advertised feature and a merely absent one', async () => {
    const { client } = fixture(async () => capabilities(['mcpCatalog', 'toolCatalog']))
    await expect(hasMayflyHostFeature(client, 'mcpCatalog')).resolves.toBe(true)
    await expect(hasMayflyHostFeature(client, 'mcpResources')).resolves.toBe(false)
  })

  it('probes the exact client it was handed, never a shared one', async () => {
    const first = fixture(async () => capabilities(['mcpCatalog']))
    const second = fixture(async () => capabilities([]))

    await expect(hasMayflyHostFeature(first.client, 'mcpCatalog')).resolves.toBe(true)
    await expect(hasMayflyHostFeature(second.client, 'mcpCatalog')).resolves.toBe(false)
    expect(first.probe).toHaveBeenCalledOnce()
    expect(second.probe).toHaveBeenCalledOnce()
  })

  it('throws the Host error of a failed probe instead of answering "no feature"', async () => {
    const { client } = fixture(async () => failed('mayflyHost/capability-unavailable', 'Host does not compose Mayfly'))
    const probe = hasMayflyHostFeature(client, 'mcpCatalog')

    // Degrading to `false` here would be a confident wrong answer: an unreachable
    // capability probe is not evidence that the Host lacks the feature.
    await expect(probe).rejects.toBeDefined()
    const error = (await probe.catch((reason: unknown) => reason)) as { code: string, message: string }
    expect(error.message).toBe('Host does not compose Mayfly')
    await expect(probe).rejects.not.toBe(false)
  })

  it('propagates a transport rejection unchanged', async () => {
    const transport = new Error('socket closed')
    const { client } = fixture(async () => { throw transport })
    await expect(hasMayflyHostFeature(client, 'mcpCatalog')).rejects.toBe(transport)
  })

  it('refuses an already-aborted signal without asking the Host', async () => {
    const { client, probe } = fixture()
    const controller = new AbortController()
    controller.abort()

    await expect(hasMayflyHostFeature(client, 'mcpCatalog', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(probe).not.toHaveBeenCalled()
  })

  it('drops a capability answer that lands after its signal was aborted', async () => {
    let release!: (value: unknown) => void
    const pending = new Promise(resolve => { release = resolve })
    const { client, probe } = fixture(async () => await pending)
    const controller = new AbortController()

    const read = hasMayflyHostFeature(client, 'mcpCatalog', controller.signal)
    expect(probe).toHaveBeenCalledOnce()
    controller.abort()
    release(capabilities(['mcpCatalog']))

    // The late answer is discarded, not published as `true` for a dead generation.
    await expect(read).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('does not cache the probe, so the caller owns single-flight and generation fencing', async () => {
    const { client, probe } = fixture()
    await hasMayflyHostFeature(client, 'mcpCatalog')
    await hasMayflyHostFeature(client, 'mcpCatalog')

    expect(probe).toHaveBeenCalledTimes(2)
  })
})

describe('unavailableCapability', () => {
  it('names the missing feature and the remedy in one line', () => {
    const message = unavailableCapability('mcpResources')

    expect(message).toBe('mcpResources is unavailable on this Host; upgrade or recompose the Host to enable it')
    expect(message).not.toContain('\n')
  })

  it('differs per feature, so a panel cannot show the wrong capability name', () => {
    expect(unavailableCapability('mcpCatalog')).not.toBe(unavailableCapability('toolCatalog'))
    expect(unavailableCapability('toolCatalog')).toContain('toolCatalog')
  })
})
