/** The public ./client projection exposes the shared contract and headless entry. */
import { describe, expect, it } from 'vitest'
import * as client from '../../src/client.ts'

describe('./client public API', () => {
  it('exports the consumer entries and validates Host keys', () => {
    expect(client.createHostClient).toBeTypeOf('function')
    expect(client.NodeConnectionTransport).toBeTypeOf('function')
    expect(client.smokeHostClient).toBeTypeOf('function')
    expect(client.HostKey('configured-host')).toBe('configured-host')
    expect(() => client.HostKey('  ')).toThrow('Host key must not be empty')
  })
})
