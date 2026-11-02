/** Standalone status uses the canonical registry/footer renderer and native facts. @module */
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { MayflyStatusService } from '@ephemeral-ai/mayfly-ui/provider'
import type { MayflyStatusEntry, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { compileMayflyUiNode } from '@ephemeral-ai/mayfly/core'
import { describe, expect, it, vi } from 'vitest'
import { plain, plainColors } from '../../../mayfly/tests/helpers.ts'
import { fakeMayflyComponents } from '../../../mayfly/tests/transcript/helpers.ts'
import { HostKey } from '../../src/client/types.ts'
import { mountRemoteStatus, type RemoteStatusHandle, type RemoteStatusSnapshot } from '../../src/remote/status.ts'
import type { RemotePresentationFacts } from '../../src/transcript/remote-model.ts'

const components = fakeMayflyComponents()
const colors = plainColors()

function facts(overrides: Partial<RemotePresentationFacts> = {}): RemotePresentationFacts {
  return {
    ref: { host: HostKey('local'), sessionId: SessionId('session-1') }, cwd: '/home/host/work/mayfly',
    title: 'Remote architecture', model: 'deepseek-chat', provider: 'deepseek', mode: undefined,
    status: undefined, queue: [], contextTokens: 999999, contextWindow: 2048,
    active: false, phase: 'idle', ...overrides,
  }
}

async function mount(initial: RemoteStatusSnapshot, paths?: { home?: () => string, directory?: () => string }) {
  const ctx = new Context()
  const status = new MayflyStatusService(ctx)
  const publications: (MayflyUiNode | null)[] = []
  const listeners = new Set<() => void>()
  const lane = { entries: [] as MayflyStatusEntry[], entered: false, active: undefined as string | undefined }
  const dispose = vi.fn()
  const screen = {
    mountNodeSlot: vi.fn(() => ({ set: (node: MayflyUiNode | null) => { publications.push(node) }, dispose })),
    views: {
      statusEntries: () => lane.entries,
      get isEntered() { return lane.entered },
      get active() { return lane.active },
      subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    },
  }
  ctx.reflect.provide('mayflyScreen')
  Object.assign(ctx, { mayflyScreen: screen })
  let snapshot = initial
  let handle!: RemoteStatusHandle
  const owner = await ctx.plugin({ name: 'remote-status-owner', apply(owner: Context) {
    handle = mountRemoteStatus(owner, () => snapshot, paths)
  } })
  const rows = (width: number): string[] => {
    const node = publications.at(-1)
    if (node == null) return []
    const compiled = compileMayflyUiNode(node, { components, colors, getViewport: () => ({ columns: width, rows: 24 }), screenMode: 'alternate', emit: () => {} })
    expect(compiled.ok).toBe(true)
    return plain((compiled.ok ? compiled.value.component : compiled.errorComponent).render(width)).map(row => row.trimEnd())
  }
  return { status, publications, screen, lane, listeners, owner, handle, rows, update(next: RemoteStatusSnapshot) { snapshot = next; handle.refresh() } }
}

describe('mountRemoteStatus', () => {
  it('renders native occupancy/cache and paired effort in the rc.2 single row', async () => {
    const current: RemoteStatusSnapshot = {
      presentation: facts(),
      values: {
        modelSelection: { next: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'max' } },
        contextPressure: { projectedTokens: 1024, pressureTokens: 2048, contextWindow: 2048 },
        tokenUsage: { uncachedInputTokens: 512, cacheReadTokens: 512, cacheWriteTokens: 0 },
      },
    }
    const mounted = await mount(current, { home: () => '/home/host' })
    expect(mounted.rows(160)).toHaveLength(1)
    const text = mounted.rows(160).join('\n')
    expect(text).toContain('deepseek/deepseek-chat Max')
    expect(text).toContain('~/work/mayfly')
    expect(text).toContain('cache')
    expect(text.match(/50%/gu)).toHaveLength(2)
    expect(text).not.toContain('Remote architecture')
    expect(mounted.screen.mountNodeSlot).toHaveBeenCalledWith('status.footer', { region: 'footer' })
    const revisions = mounted.status.list().map(entry => entry.revision)
    const before = mounted.publications.length
    mounted.handle.refresh()
    expect(mounted.publications).toHaveLength(before)
    mounted.update({ ...current, values: { ...current.values, modelSelection: { next: { provider: 'deepseek', model: 'deepseek-chat' } } } })
    expect(mounted.rows(160).join('\n')).not.toContain(' Max')
    expect(mounted.status.list().filter(entry => entry.id !== 'mayfly.status.basic').map(entry => entry.revision)).toEqual(revisions.slice(1))
    await mounted.owner.dispose()
  })

  it('keeps external status entries and entered views in the shared footer and stays within narrow widths', async () => {
    const mounted = await mount({ presentation: facts(), values: { contextPressure: { pressureTokens: 512, contextWindow: 2048 } } })
    const external = mounted.status.register({ id: 'feature', priority: 2 }, { kind: 'text', content: 'feature' })
    mounted.lane.entries = [{ id: 'views/jobs', definition: { id: 'views/jobs', priority: 12 }, node: { kind: 'text', content: 'jobs 2' }, revision: 1 }]
    mounted.lane.entered = true
    mounted.lane.active = 'jobs'
    for (const listener of mounted.listeners) listener()
    expect(mounted.rows(160)).toHaveLength(2)
    expect(mounted.rows(160)[0]).toContain('feature')
    expect(mounted.rows(160)[0]).toContain('jobs 2')
    expect(mounted.rows(160)[1]).toContain('━')
    for (const width of [1, 2, 3, 8, 12, 20, 40, 60, 80, 160]) {
      for (const row of mounted.rows(width)) expect(components.visibleWidth(row), `${width}: ${row}`).toBeLessThanOrEqual(width)
    }
    await mounted.handle.dispose()
    expect(mounted.status.list().map(entry => entry.id)).toEqual(['feature'])
    expect(mounted.screen.mountNodeSlot().dispose).toHaveBeenCalledOnce()
    expect(mounted.listeners.size).toBe(0)
    const before = mounted.publications.length
    mounted.update({ presentation: facts({ model: 'late' }), values: {} })
    expect(mounted.publications).toHaveLength(before)
    external.dispose()
    await mounted.owner.dispose()
  })

  it('shows startup paths, omits absent context, and releases registrations on Fiber unload', async () => {
    const mounted = await mount({ presentation: facts({ ref: undefined, model: undefined, provider: undefined, cwd: '' }), values: {} }, { directory: () => '/remote/start', home: () => '/remote' })
    expect(mounted.rows(80)).toEqual([' ~/start'])
    mounted.update({ presentation: facts({ model: undefined, provider: undefined, cwd: '' }), values: { contextPressure: { pressureTokens: 5500 } } })
    expect(mounted.rows(80)[0]).toContain('no model')
    expect(mounted.rows(80)[0]).toContain('ctx 5.4k')
    await mounted.owner.dispose()
    expect(mounted.status.list()).toEqual([])
    expect(mounted.listeners.size).toBe(0)
    const before = mounted.publications.length
    mounted.handle.refresh()
    expect(mounted.publications).toHaveLength(before)
  })

  it('keeps default reasoning effort before a Session and clears all empty facts', async () => {
    const startup = { ...facts({ ref: undefined }), reasoningEffort: 'max' }
    const mounted = await mount({ presentation: startup, values: {} })
    expect(mounted.rows(100)[0]).toContain('deepseek/deepseek-chat Max')
    mounted.update({ presentation: facts({ ref: undefined, model: undefined, provider: undefined, cwd: '' }), values: {} })
    expect(mounted.rows(100)).toEqual([])
    await mounted.handle.dispose()
    await mounted.handle.dispose()
    await mounted.owner.dispose()
  })
})
