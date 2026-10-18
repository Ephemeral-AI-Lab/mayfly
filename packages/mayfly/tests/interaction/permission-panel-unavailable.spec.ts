/** The permission panel when the overlay adapter returns no picker: it stops before subscribing.
 * @module @ephemeral-ai/mayfly/tests/interaction/permission-panel-unavailable
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import { fakeMayflyContext } from './fakes.ts'
import type { PermissionPresetsService } from '../../src/interaction/permission-panel.ts'

const { openUiOverlay } = vi.hoisted(() => ({ openUiOverlay: vi.fn() }))
vi.mock('../../src/interaction/ui-overlay.ts', () => ({ openUiOverlay }))

async function mount(): Promise<{ ctx: Context, agent: Agent }> {
  const { ctx } = fakeMayflyContext()
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create(SessionId('perm-unavailable'))
  const agent = { id: session.id, session, status: 'idle' } as unknown as Agent
  ctx.provide('testSession', { current: agent, modelRef: undefined })
  ctx.provide('permissionPresets', {
    catalog: () => ({ options: [{ value: 'read-only', name: 'read-only' }], defaultOptions: [], defaultPreset: 'read-only' }),
    current: () => 'read-only',
    resolve: () => ({ name: 'read-only', sandbox: 'read-only', approval: 'ask' }),
    optionOf: (name: string) => ({ value: name, name }),
  } as unknown as PermissionPresetsService)
  return { ctx, agent }
}

it('returns without listeners when the picker could not open', async () => {
  const { openPermissionPanel } = await import('../../src/interaction/permission-panel.ts')
  const { ctx, agent } = await mount()
  vi.spyOn(ctx.mayflyCurrentAgent, 'subscribe')
  openUiOverlay.mockReturnValueOnce(undefined)
  expect(() => openPermissionPanel(ctx)).not.toThrow()
  expect(openUiOverlay).toHaveBeenCalledWith(ctx, expect.objectContaining({ id: 'mayfly.permission' }), expect.anything(), expect.anything())
  expect(ctx.mayflyCurrentAgent.subscribe).not.toHaveBeenCalled()
  expect(ctx.mayflyOverlays.list()).toEqual([])
  expect(agent.session).toBeDefined()
})
