/**
 * Decision tests for the plugin entry, driven through the built artifact for
 * the same decorator-transform reason as service.spec.ts.
 * @module
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Plugin } from '@deepseek-ai/cordis'
import { apply, inject, name } from '../lib/index.js'

/** Real contexts created by the harness. */
const contexts: Context[] = []

afterEach((): void => { contexts.length = 0 })

/** A real context whose projection registry records registrations. */
function harness(): { ctx: Context, registered: string[], plugged: readonly string[] } {
  const ctx = new Context()
  contexts.push(ctx)
  const registered: string[] = []
  ctx.provide('sessionProjections', {
    register: async (definition: { key: string }): Promise<void> => { registered.push(definition.key) },
  })
  // The Remote service plugin is recorded through the real plugin path.
  const plugged: string[] = []
  ctx.plugin = (async (plugin: Plugin): Promise<unknown> => {
    plugged.push(String((plugin as { name?: string }).name ?? 'anonymous'))
    return {}
  }) as unknown as typeof ctx.plugin
  return { ctx, registered, plugged }
}

describe('mayfly-host plugin', () => {
  it('declares its name and the projection service dependency', () => {
    expect(name).toBe('mayfly-host')
    expect(inject).toEqual(['sessionProjections'])
  })

  it('registers every projection and the Remote service on the caller\'s Fiber', async () => {
    const { ctx, registered, plugged } = harness()
    await apply(ctx)
    // The Remote service is plugged alongside the projections.
    expect(plugged).toContain('MayflyHostService')
    expect(registered).toEqual([
      'mayflyConversation',
      'mayflyConversationFacts',
      'mayflyDeliverables',
      'mayflyJobs',
      'mayflyWorkflow',
      'mayflyRetraction',
    ])
  })
})
