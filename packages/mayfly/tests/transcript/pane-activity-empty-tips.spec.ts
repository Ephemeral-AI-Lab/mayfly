/** The activity pane when the teaching-tip content is empty: the rotation is a no-op.
 * @module @ephemeral-ai/mayfly/tests/transcript/pane-activity-empty-tips
 */
import { describe, expect, it, vi } from 'vitest'
import type { TickSource } from '../../src/transcript/tick.ts'

vi.mock('../../src/transcript/tips-content.ts', () => ({ STATUS_TIPS: [] }))

const activity = await import('../../src/transcript/pane-activity.ts')
const { bootPanePlugin } = await import('./pane-fakes.ts')
const { fakeAgent } = await import('./status-fakes.ts')
const { textDelta } = await import('./helpers.ts')

class FakeTick implements TickSource {
  subscribe(): () => void { return () => {} }
}

describe('mayfly-pane-activity without tips', () => {
  it('publishes a live row with no tip line when the rotation pool is empty', async () => {
    const agent = fakeAgent([])
    const harness = await bootPanePlugin(activity, agent, {
      mayflyTick: new FakeTick(),
      mayflyUiInteraction: { notificationSnapshot: (): readonly never[] => [], subscribe: () => () => {}, createNotificationOwner: () => ({ report() {}, clear() {}, clearAll() {}, dispose() {} }) },
    })
    harness.ctx.emit('session/event', agent.session as never, textDelta(1, 1, 'answering'))
    const lines = harness.screen.paneLines().filter(line => line.trim() !== '' && !line.includes('Alt+'))
    expect(lines[0]).toContain('Writing')
    expect(lines.some(line => line.includes('Tip:'))).toBe(false)
    await harness.dispose()
  })
})
