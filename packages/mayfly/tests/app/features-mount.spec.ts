/** Manifest composition uses one context, clears commands and unwinds partial mounts. @module */
import { Context } from '@deepseek-ai/cordis'
import { MayflyLocaleService } from '../../src/frontend/locale.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteFeatureContext, RemoteFeatureMountContext } from '../../src/app/features.ts'

const fixture = vi.hoisted(() => ({ mounts: Array.from({ length: 10 }, () => vi.fn<(context: RemoteFeatureContext) => void | (() => void)>()) }))
vi.mock('../../src/app/interactions/approval.ts', () => ({ mountApprovalInteractions: fixture.mounts[0] }))
vi.mock('../../src/app/interactions/questions.ts', () => ({ mountQuestionInteractions: fixture.mounts[1] }))
vi.mock('../../src/app/features/activity.ts', () => ({ mountActivityFeature: fixture.mounts[2] }))
vi.mock('../../src/app/features/goal.ts', () => ({ mountGoalFeature: fixture.mounts[3] }))
vi.mock('../../src/app/features/todo.ts', () => ({ mountTodoFeature: fixture.mounts[4] }))
vi.mock('../../src/app/features/plan.ts', () => ({ mountPlanFeature: fixture.mounts[5] }))
vi.mock('../../src/app/features/schedule.ts', () => ({ mountScheduleFeature: fixture.mounts[6] }))
vi.mock('../../src/app/features/jobs.ts', () => ({ mountJobsFeature: fixture.mounts[7] }))
vi.mock('../../src/app/features/git.ts', () => ({ mountGitFeature: fixture.mounts[8] }))
vi.mock('../../src/app/features/catalog.ts', () => ({ mountCatalogFeature: fixture.mounts[9] }))

import { mountRemoteFeatures } from '../../src/app/features.ts'

const contexts: Context[] = []
beforeEach(() => { for (const mount of fixture.mounts) mount.mockReset() })
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

function base() {
  const ctx = new Context()
  contexts.push(ctx)
  const locale = new MayflyLocaleService(ctx, { preference: 'en' })
  return { context: { ctx } as RemoteFeatureMountContext, locale }
}

describe('feature manifest composition', () => {
  it('shares the exact locale/command context and tears down registered lanes in reverse order once', async () => {
    const { context, locale } = base()
    const released: number[] = []
    fixture.mounts.forEach((mount, index) => mount.mockImplementation(owner => {
      owner.commands.register({ name: `lane-${index}`, description: `lane ${index}`, execute: () => {} })
      return index === 9 ? undefined : () => { released.push(index) }
    }))
    const handle = mountRemoteFeatures(context)
    for (const mount of fixture.mounts) expect(mount).toHaveBeenCalledExactlyOnceWith(handle.context)
    expect(handle.commands.list()).toHaveLength(10)
    expect(handle.context.t('Reject')).toBe('Reject')
    const changed = vi.fn()
    const off = handle.context.subscribeLocale(changed)
    const previous = changed.mock.calls.length
    locale.setPreference('zh')
    expect(changed.mock.calls.length).toBeGreaterThan(previous)
    expect(handle.context.t('Reject')).toBe('拒绝')
    off()
    handle.dispose()
    handle.dispose()
    expect(released).toEqual([8, 7, 6, 5, 4, 3, 2, 1, 0])
    expect(handle.commands.list()).toEqual([])
    expect(await handle.commands.execute('lane-0', '', new AbortController().signal)).toBe(false)
  })

  it('unwinds earlier mounts and their commands when a later lane refuses activation', () => {
    const { context } = base()
    const released: number[] = []
    fixture.mounts.slice(0, 3).forEach((mount, index) => mount.mockImplementation(owner => {
      owner.commands.register({ name: `lane-${index}`, description: 'partial mount', execute: () => {} })
      return () => { released.push(index) }
    }))
    fixture.mounts[3]!.mockImplementation(() => { throw new Error('lane startup failed') })
    expect(() => mountRemoteFeatures(context)).toThrow('lane startup failed')
    expect(released).toEqual([2, 1, 0])
    expect(fixture.mounts[0]!.mock.calls[0]![0].commands.list()).toEqual([])
    expect(fixture.mounts[4]).not.toHaveBeenCalled()
  })
})
