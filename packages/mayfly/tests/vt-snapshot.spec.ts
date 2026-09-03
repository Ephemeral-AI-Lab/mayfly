/** Headless terminal evidence for the direct-service whole tree.
 * @module @ephemeral-ai/mayfly/tests/vt-snapshot
 */

import { afterEach, describe, expect, it } from 'vitest'
import { waitForRender } from './core/fake-terminal.ts'
import { cwdNormalizer, VtTerminal } from './vt-terminal.ts'
import { bootDirectMayfly, currentAgent, executeDirectOverlay, resetDirectMayfly } from './e2e-boot.ts'

afterEach(async () => { await resetDirectMayfly() })

async function frame(columns: number, overlay = false): Promise<string> {
  const terminal = new VtTerminal(columns, 16)
  const tree = await bootDirectMayfly({ terminal })
  await currentAgent(tree)
  if (overlay) await executeDirectOverlay(tree)
  tree.ctx.mayflyScreen.requestRender(true)
  await waitForRender()
  return terminal.frame(cwdNormalizer())
}

describe('direct-service VT frames', () => {
  it.each([32, 80])('renders the sibling pane within %i columns', async (columns) => {
    const output = await frame(columns)
    expect(output).toContain('native dsh + Mayfly seam')
    for (const row of output.split('\n')) expect([...row]).toHaveLength(Math.min(columns, [...row].length))
  })

  it('renders the direct capturing overlay over the same tree', async () => {
    const output = await frame(80, true)
    expect(output).toContain('Direct overlay')
    expect(output).toContain('opened through the direct Mayfly service')
  })
})
