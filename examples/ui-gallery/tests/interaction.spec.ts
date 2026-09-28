/** Structured action settlement for the static gallery pane.
 * @module @mayfly-example/ui-gallery/tests/interaction
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MayflyUiEventContext } from '../../../packages/ui/src/contracts.ts'
import { apply as applyApi } from '../../../packages/ui/src/provider.ts'
import * as gallery from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

describe('ui gallery pane actions', () => {
  it('settles every demo action with a structured reply', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin({ name: 'example-test-api', apply: applyApi })
    await ctx.plugin(gallery)
    const entry = ctx.mayflyPanes.list().find(pane => pane.id === 'example.ui-gallery.showcase')!
    const action = entry.definition.onEvent!.action!
    const context: MayflyUiEventContext = {
      surfaceId: entry.id, operationId: 'gallery-test', source: entry.source, revision: entry.revision,
      signal: new AbortController().signal, report: vi.fn(),
    }
    // The demo form acknowledges a freshly rendered snapshot...
    const submitted = await action({
      kind: 'submit', pagePath: [], controlId: 'gallery-form',
      submission: { actionId: 'gallery-form-submit', draftRevision: 1, forms: [], source: [] },
    }, context)
    expect(submitted).toMatchObject({ kind: 'accepted' })
    expect((submitted as { node: unknown }).node).toBeDefined()
    // ...and every other activation completes with the demo note.
    const activated = await action({ kind: 'activate', pagePath: [], controlId: 'gallery-apply', actionId: 'gallery-apply' }, context)
    expect(activated).toMatchObject({ kind: 'completed', feedback: { severity: 'info' } })
  })
})
