/**
 * Decision tests for the capability handshake: which features a composition
 * advertises, and when the optional transport-health feature appears.
 * @module
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { mayflyHostCapabilities, mayflyHostFeatures } from '../../src/remote/capabilities.ts'
import { mcpCatalogFace } from '../../src/remote/mcp-catalog-face.ts'

/** A context whose `mcpResources` carries (or omits) a callable `listServers`. */
function ctx(withListing: boolean | 'malformed'): Context {
  const service = withListing === true
    ? { listServers: (): readonly unknown[] => [] }
    : withListing === 'malformed'
      ? { listServers: 'not a function' }
      : {}
  // The face is probed through ctx.get, never as a property.
  return { get: (name: string): unknown => name === 'mcpResources' ? service : undefined } as unknown as Context
}

describe('mayflyHostFeatures', () => {
  it('advertises the base features without the optional runtime', () => {
    const features = mayflyHostFeatures(ctx(false))
    expect(features).toContain('mayflyConversation')
    expect(features).toContain('mcpCatalog')
    expect(features).not.toContain('mcpTransportHealth')
  })

  it('adds transport health only while the native face answers', () => {
    expect(mayflyHostFeatures(ctx(true))).toContain('mcpTransportHealth')
    // A service whose listing is not callable is as good as absent.
    expect(mayflyHostFeatures(ctx('malformed'))).not.toContain('mcpTransportHealth')
  })

  it('keeps the feature order stable across reads', () => {
    // A client diffs capability lists; an unstable order would churn.
    expect([...mayflyHostFeatures(ctx(true))]).toEqual(mayflyHostFeatures(ctx(true)))
  })
})

describe('mayflyHostCapabilities', () => {
  it('freezes the value a client caches across a reconnect', () => {
    const capabilities = mayflyHostCapabilities(ctx(false))
    expect(Object.isFrozen(capabilities)).toBe(true)
    expect(Object.isFrozen(capabilities.features)).toBe(true)
  })

  it('reports one protocol version and the Host build', () => {
    const capabilities = mayflyHostCapabilities(ctx(false))
    expect(capabilities.protocolVersion).toBe(1)
    expect(capabilities.hostVersion).toMatch(/^\d+\.\d+\.\d+/u)
    expect(capabilities.requiredDshVersion).toMatch(/^\d+\.\d+\.\d+/u)
  })
})

describe('mcpCatalogFace', () => {
  it('returns undefined when the service or its listing is absent', () => {
    expect(mcpCatalogFace(ctx(false))).toBeUndefined()
    // A context whose service map has no entry at all answers undefined too.
    expect(mcpCatalogFace({ get: (): undefined => undefined } as unknown as Context)).toBeUndefined()
    expect(mcpCatalogFace(ctx('malformed'))).toBeUndefined()
  })

  it('returns the callable listing untouched', () => {
    const face = mcpCatalogFace(ctx(true))
    expect(face?.listServers).toBeTypeOf('function')
  })
})
