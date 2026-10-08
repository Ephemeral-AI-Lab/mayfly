/** The gallery's view of status row 2, registered through the public pane service.
 * @module @mayfly-example/ui-gallery/tests/views
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MayflyUiEventContext } from '../../../packages/ui/src/contracts.ts'
import { apply as applyApi } from '../../../packages/ui/src/provider.ts'
import * as gallery from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

async function boot() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin({ name: 'example-test-api', apply: applyApi })
  const fiber = await ctx.plugin(gallery)
  const entry = () => ctx.mayflyPanes.list().find(pane => pane.id === 'example.ui-gallery.view')!
  const activate = async (actionId: string) => {
    const current = entry()
    const context: MayflyUiEventContext = { surfaceId: current.id, operationId: 'view-test', source: current.source, revision: current.revision, signal: new AbortController().signal, report: vi.fn() }
    return current.definition.onEvent!.action!({ kind: 'activate', pagePath: [], controlId: actionId, actionId }, context)
  }
  return { ctx, fiber, entry, activate }
}

describe('ui gallery view', () => {
  it('registers a view with a summary beside the showcase pane', async () => {
    const { entry, ctx } = await boot()
    expect(entry().definition.placement).toBe('views')
    expect(entry().summary!.count).toBe(2)
    expect(ctx.mayflyPanes.list().map(pane => pane.id)).toContain('example.ui-gallery.showcase')
  })

  it('tracks another run by republishing the summary and the panel, up to the last run', async () => {
    const { entry, activate } = await boot()
    await expect(activate('gallery-view-track')).resolves.toMatchObject({ kind: 'completed' })
    expect(entry().summary!.count).toBe(3)
    expect(JSON.stringify(entry().node)).toContain('gallery-view-lint')
    await activate('gallery-view-track')
    expect(entry().summary!.count).toBe(3)
  })

  it('takes itself out of row 2 and comes back on the next track; other events settle quietly', async () => {
    const { entry, activate } = await boot()
    await activate('gallery-view-clear')
    expect(entry().summary).toBeNull()
    await activate('gallery-view-track')
    expect(entry().summary!.count).toBe(3)
    const current = entry()
    const quiet = await current.definition.onEvent!.action!({ kind: 'dismiss', pagePath: [] } as never, { surfaceId: current.id, operationId: 'q', source: current.source, revision: current.revision, signal: new AbortController().signal, report: vi.fn() })
    expect(quiet).toEqual({ kind: 'completed' })
  })

  it('leaves with its Fiber', async () => {
    const { ctx, fiber } = await boot()
    await fiber.dispose()
    expect(ctx.mayflyPanes.list()).toEqual([])
  })
})
