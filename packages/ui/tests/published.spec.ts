/** Built entry-point contract for immutable snapshot sharing.
 * @module @ephemeral-ai/mayfly-ui/tests/published
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('shares trusted snapshots between built root and provider entries', () => {
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    import { Context } from '@deepseek-ai/cordis'
    import { ui, freezeWire } from './lib/index.js'
    import { apply } from './lib/provider.js'
    const ctx = new Context()
    const owner = await ctx.plugin({ name: 'published-test', apply })
    const node = ui.list({ id: 'large', mode: 'single', items: Array.from({ length: 100_000 }, (_, index) => ({ id: String(index), label: String(index) })) })
    const pane = ctx.mayflyPanes.register({ id: 'published.pane', placement: 'bottom' }, node)
    assert.equal(ctx.mayflyPanes.list()[0].node, node)
    const updated = ui.list({ ...node, filter: 'updated' })
    pane.set(updated)
    assert.equal(ctx.mayflyPanes.list()[0].node, updated)
    assert.equal(updated.items, node.items)
    assert.equal(freezeWire(updated), updated)
    const raw = { kind: 'text', content: 'raw' }
    pane.set(raw)
    raw.content = 'changed'
    assert.equal(ctx.mayflyPanes.list()[0].node.content, 'raw')
    await owner.dispose()
    process.stdout.write('published snapshot identity passed')
  `], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' })
  expect(output).toBe('published snapshot identity passed')
})
