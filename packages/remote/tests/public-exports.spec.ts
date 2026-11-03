import { describe, expect, it } from 'vitest'
import * as root from '../src/index.ts'
import * as client from '../src/client.ts'
import { readFileSync } from 'node:fs'

describe('public module projections', () => {
  it('exposes the launcher/runtime and client entries with one published export set', () => {
    expect(root.createHostClient).toBeTypeOf('function')
    expect(root.runRemoteFrontend).toBeTypeOf('function')
    expect(root.RemoteApp).toBeTypeOf('function')
    expect(client.smokeHostClient).toBeTypeOf('function')
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { exports: Record<string, unknown> }
    expect(Object.keys(manifest.exports)).toEqual(['.', './client', './remote-bin', './package.json'])
    expect(root).not.toHaveProperty('MayflyHostActions')
    expect(root).not.toHaveProperty('RemoteFeaturePanel')
    expect(root).not.toHaveProperty('buildRemoteStatusFooter')
  })
})
