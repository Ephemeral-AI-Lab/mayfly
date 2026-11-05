/** Standalone status uses the canonical registry/footer renderer and native facts. @module */
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { MayflyStatusService } from '@ephemeral-ai/mayfly-ui/provider'
import type { MayflyStatusEntry, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { compileMayflyUiNode } from '../../src/core/ui-compiler.ts'
import type { focusModeNode } from '../../src/transcript/status-focus.ts'
import { describe, expect, it, vi } from 'vitest'
import { plain, plainColors, fakeMayflyComponents } from './render-fixture.ts'
import { HostKey } from '../../src/client/types.ts'
import { mountRemoteStatus, type RemoteStatusHandle, type RemoteStatusSnapshot } from '../../src/app/status.ts'
import type { RemotePresentationFacts } from '../../src/transcript/remote-model.ts'

// Counts the shed builds (each clones its nodes) without changing what they return.
const shed = vi.hoisted(() => ({ builds: 0 }))
vi.mock('../../src/transcript/status-shed.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/transcript/status-shed.ts')>()
  return { ...actual, shedNode: (...args: Parameters<typeof actual.shedNode>) => { shed.builds += 1; return actual.shedNode(...args) } }
})

const components = fakeMayflyComponents()
const colors = plainColors()
type MayflyFocusMode = Parameters<typeof focusModeNode>[0]

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
  const on = vi.spyOn(ctx, 'on')
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
  return { ctx, on, status, publications, screen, lane, listeners, owner, handle, rows, update(next: RemoteStatusSnapshot) { snapshot = next; handle.refresh() } }
}

describe('mountRemoteStatus', () => {
  it.each(['resumable', 'readonly'] as const)('keeps cold history model and directory without Agent context or effort (%s)', async access => {
    const current = { presentation: facts({ reasoningEffort: 'high' }), values: {
      modelSelection: { next: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'max' } },
      contextPressure: { projectedTokens: 100, contextWindow: 1000 },
    }, conversation: 'subagent' as const, access }
    const mounted = await mount(current)
    try {
      expect(mounted.rows(160).join('\n')).toContain('deepseek/deepseek-chat')
      expect(mounted.rows(160).join('\n')).toContain('subagent')
      expect(mounted.rows(160).join('\n')).not.toMatch(/High|Max|ctx/u)
      mounted.update({ ...current, access: 'interactive' })
      expect(mounted.rows(160).join('\n')).toContain('Max')
      expect(mounted.rows(160).join('\n')).toContain('ctx')
    } finally { await mounted.owner.dispose() }
  })
  it('shows the shared inverse focus chip and withdraws it on prompt return and unload', async () => {
    const mounted = await mount({ presentation: facts(), values: {} })
    try {
      const queued = mounted.on.mock.calls.find(call => call[0] === 'mayfly/focus-mode-changed')?.[1] as ((mode: MayflyFocusMode) => void) | undefined
      expect(queued).toBeTypeOf('function')
      for (const mode of ['conversation', 'search', 'search-select', 'view'] as const) {
        mounted.ctx.emit('mayfly/focus-mode-changed', mode)
        const node = mounted.status.list().find(entry => entry.id === 'mayfly.status.focus')!.node
        expect(node).toMatchObject({ kind: 'rich-text', spans: [{ text: ` ${mode === 'search-select' ? 'search' : mode} `, tone: 'primary', styles: ['strong', 'inverse'] }] })
        expect(mounted.rows(160).join('\n')).toContain(mode === 'search-select' ? 'search' : mode)
        for (const width of [1, 8, 20, 40, 80, 160]) {
          expect(mounted.rows(width).every(row => components.visibleWidth(row) <= width)).toBe(true)
        }
      }
      mounted.ctx.emit('mayfly/focus-mode-changed', 'prompt')
      expect(mounted.status.list().find(entry => entry.id === 'mayfly.status.focus')!.node).toBeNull()
      await mounted.handle.dispose()
      queued!('conversation')
      mounted.ctx.emit('mayfly/focus-mode-changed', 'search')
      expect(mounted.status.list()).toEqual([])
    } finally { await mounted.owner.dispose() }
  })
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
    const revisions = mounted.status.list().filter(entry => entry.id !== 'mayfly.status.basic').map(entry => entry.revision)
    const before = mounted.publications.length
    mounted.handle.refresh()
    expect(mounted.publications).toHaveLength(before)
    mounted.update({ ...current, values: { ...current.values, modelSelection: { next: { provider: 'deepseek', model: 'deepseek-chat' } } } })
    expect(mounted.rows(160).join('\n')).not.toContain(' Max')
    expect(mounted.status.list().filter(entry => entry.id !== 'mayfly.status.basic').map(entry => entry.revision)).toEqual(revisions)
    await mounted.owner.dispose()
  })

  it('rebuilds a status node only when one of its inputs changes', async () => {
    const values = {
      modelSelection: { next: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'max' } },
      contextPressure: { projectedTokens: 1024, contextWindow: 2048 },
      tokenUsage: { uncachedInputTokens: 512, cacheReadTokens: 512, cacheWriteTokens: 0 },
    }
    const mounted = await mount({ presentation: facts(), values }, { home: () => '/home/host' })
    const builds = shed.builds
    expect(builds).toBeGreaterThan(0)
    // Each streamed chunk re-reads equal presentation facts.
    for (let chunk = 0; chunk < 10; chunk += 1) mounted.update({ presentation: facts(), values: { ...values } })
    expect(shed.builds).toBe(builds)
    mounted.update({ presentation: facts({ cwd: '/home/host/work/other' }), values })
    expect(shed.builds).toBe(builds + 1)
    expect(mounted.rows(160).join('\n')).toContain('~/work/other')
    mounted.update({ presentation: facts({ cwd: '/home/host/work/other' }), values: { ...values, contextPressure: { projectedTokens: 1536, contextWindow: 2048 } } })
    expect(shed.builds).toBeGreaterThan(builds + 1)
    expect(mounted.rows(160).join('\n')).toContain('75%')
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

  it('accepts native null model routes on first Session creation and retains the advertised default effort', async () => {
    const fallback = { ...facts(), reasoningEffort: 'max' }
    const mounted = await mount({ presentation: fallback, values: { modelSelection: { next: null, lastUsed: null } } })
    try {
      expect(mounted.rows(120)[0]).toContain('deepseek/deepseek-chat Max')
      expect(() => mounted.update({ presentation: fallback, values: { modelSelection: null } })).not.toThrow()
      expect(mounted.rows(120)[0]).toContain('Max')
      mounted.update({ presentation: fallback, values: { modelSelection: { next: null, lastUsed: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' } } } })
      expect(mounted.rows(120)[0]).toContain('High')
      mounted.update({ presentation: facts(), values: { modelSelection: { next: { provider: 'deepseek', model: 'deepseek-chat' }, lastUsed: null } } })
      expect(mounted.rows(120)[0]).not.toContain('Max')
    } finally { await mounted.owner.dispose() }
  })

  it('renders a used route effective effort and rejects a presentation from another route', async () => {
    const native = { provider: 'deepseek', model: 'deepseek-chat' }
    const mounted = await mount({ presentation: facts({ reasoningEffort: 'high' }), values: { modelSelection: { next: native, lastUsed: native } } })
    expect(mounted.rows(120)[0]).toContain('High')
    mounted.update({ presentation: facts({ reasoningEffort: 'high' }), values: { modelSelection: { next: { provider: 'other', model: 'deepseek-chat' } } } })
    expect(mounted.rows(120)[0]).not.toContain('High')
    mounted.update({ presentation: facts({ reasoningEffort: 'high' }), values: { modelSelection: { next: { provider: 'deepseek', model: 'other' } } } })
    expect(mounted.rows(120)[0]).not.toContain('High')
    await mounted.owner.dispose()
  })
})
