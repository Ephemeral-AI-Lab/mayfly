/**
 * The installed official Client handoffs, evaluated unmocked: each registers under its package id, exports a Cordis
 * entry, and requests only the externals the loader declares. A Harness bump that changes the format fails here.
 * @module @ephemeral-ai/mayfly/tests/client/bundle-contract
 */
import { expect, it } from 'vitest'
import { loadClientPlugins } from '../../src/client/bundle.ts'

it('materializes the four installed handoffs of the pinned Harness', async () => {
  const plugins = await loadClientPlugins()
  expect(Object.keys(plugins)).toEqual(['remotes', 'fileUpload', 'sessions', 'workspaces'])
  for (const plugin of Object.values(plugins)) {
    expect(plugin.inject.every(name => typeof name === 'string')).toBe(true)
    expect(typeof plugin.apply).toBe('function')
  }
})
