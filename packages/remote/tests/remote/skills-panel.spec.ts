/** Reference wire skill browsing uses the native exact-selection catalog. @module tests/remote/skills-panel */
import { Context } from '@deepseek-ai/cordis'
import * as Provider from '@ephemeral-ai/mayfly-ui/provider'
import * as Frontend from '@ephemeral-ai/mayfly/frontend'
import { compileMayflyUiNode, MayflyComponentsService, visibleWidth, type MayflyComponentsDeps, type MayflySemanticColors } from '@ephemeral-ai/mayfly/core'
import type { MayflyUiActionEvent, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorSkills } from '../../src/remote/editor/skills.ts'
import type { MayflyHostRemote, MayflySkillCatalog } from '../../src/frontend/host-contract.ts'
import { EditorSkillsPanel, REMOTE_SKILLS_METADATA_LIMITATION } from '../../src/remote/editor/skills-panel.ts'
import { deferred, denied, flush, wire } from './editor-feature-fixture.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
const skills = [
  { name: 'review', description: 'Review the current changes', whenToUse: 'Use after an implementation is ready', modelInvocable: true, path: '/private/project/.agents/skills/review/SKILL.md' },
  { name: 'publish', description: 'Publish a release', modelInvocable: false },
]

async function fixture(metadata = false) {
  const ctx = new Context()
  await ctx.plugin(Provider)
  await ctx.plugin(Frontend)
  const host = wire('one')
  host.listSkills.mockResolvedValue({ ok: true, value: { skills } } as never)
  const native: MayflySkillCatalog = { complete: true, skills: skills.map((skill, index) => ({
    ...skill, source: index === 0 ? 'project-agents' : 'user-dsh', provider: 'filesystem',
  })) }
  const catalog = vi.fn<MayflyHostRemote['skillCatalog']>(async () => ({ ok: true, value: native }))
  if (metadata) Object.assign(host.selected.client.remote, { mayflyHost: {
    capabilities: async () => ({ ok: true, value: { features: ['skillCatalog'] } }), skillCatalog: catalog,
  } })
  let selected: typeof host.selected | undefined = host.selected
  const source = new EditorSkills(() => selected)
  const restoreFocus = vi.fn()
  const panel = new EditorSkillsPanel({ ctx, skills: source, session: () => selected, restoreFocus })
  cleanups.push(async () => { panel.close(); source.dispose(); await ctx.fiber.dispose() })
  const text = () => JSON.stringify(ctx.mayflyOverlays.list()[0]?.node)
  const action = (event: MayflyUiActionEvent, signal = new AbortController().signal) => {
    const current = ctx.mayflyOverlays.list()[0]!
    return current.events.prepare(event, { surfaceId: current.id, source: [], signal, revision: current.revision, operationId: 'skills-action', report: vi.fn() })
  }
  return { ctx, host, source, panel, text, action, restoreFocus, catalog, native, select: (next: typeof selected) => { selected = next } }
}

describe('shared native skills browser', () => {
  it('opens a real editor wire surface and names the missing metadata capability only on a plain official Host', async () => {
    const f = await fixture()
    await f.panel.show()
    const overlay = f.ctx.mayflyOverlays.list()[0]!
    expect(overlay.definition.presentation).toBe('editor')
    expect(overlay.definition.scope).toEqual({ kind: 'session', sessionId: f.host.selected.ref.sessionId })
    expect(f.text()).toContain('"id":"skills"')
    expect(f.text()).toContain('"id":"skills-narrow"')
    expect(f.text()).toContain('"filterMode":"slash"')
    expect(f.text()).toContain('"marker":"selection"')
    expect(f.text()).toContain('user-only')
    expect(f.text()).toContain(REMOTE_SKILLS_METADATA_LIMITATION)
    expect(f.text()).not.toContain('/private/project')
    expect(f.host.listSkills).toHaveBeenCalledWith({ sessionId: f.host.selected.ref.sessionId }, expect.any(AbortSignal))
  })

  it('renders exact native source/provider groups without an API warning or exposing skill paths', async () => {
    const f = await fixture(true)
    await f.panel.show()
    expect(f.host.listSkills).not.toHaveBeenCalled()
    expect(f.catalog).toHaveBeenCalledWith({ sessionId: f.host.selected.ref.sessionId }, expect.any(AbortSignal))
    expect(f.text()).toContain('"group":"Project"')
    expect(f.text()).toContain('"group":"User"')
    expect(f.text()).toContain('project-agents')
    expect(f.text()).toContain('filesystem')
    expect(f.text()).not.toContain(REMOTE_SKILLS_METADATA_LIMITATION)
    expect(f.text()).not.toContain('/private/project')
    await f.action({ kind: 'selection-accept', controlId: 'skills-narrow', selectedIds: ['review'], pagePath: [] })
    expect(f.text()).toContain('project-agents')
    expect(f.text()).toContain('filesystem')
  })

  it('aborts an initial metadata read on close and fences connection replacement before a panel can mount', async () => {
    for (const retirement of ['close', 'connection'] as const) {
      const f = await fixture(true)
      let generation = 1
      Object.assign(f.host.selected.client.state, { getSnapshot: () => ({ generation }) })
      const pending = deferred<Awaited<ReturnType<MayflyHostRemote['skillCatalog']>>>()
      f.catalog.mockReturnValueOnce(pending.promise)
      const opening = f.panel.show()
      await vi.waitFor(() => { expect(f.catalog).toHaveBeenCalledOnce() })
      if (retirement === 'close') f.panel.close()
      else generation += 1
      pending.resolve({ ok: true, value: f.native })
      await opening
      expect(f.catalog.mock.calls[0]![1]!.aborted).toBe(true)
      expect(f.source.list()).toEqual([])
      expect(f.ctx.mayflyOverlays.list()).toEqual([])
    }
  })

  it('keeps native metadata after a caller cancels an in-flight refresh', async () => {
    const f = await fixture(true)
    await f.panel.show()
    const pending = deferred<Awaited<ReturnType<MayflyHostRemote['skillCatalog']>>>()
    f.catalog.mockReturnValueOnce(pending.promise)
    const caller = new AbortController()
    const refreshing = f.action({ kind: 'activate', controlId: 'skills-actions', actionId: 'refresh', pagePath: [] }, caller.signal)
    await vi.waitFor(() => { expect(f.catalog).toHaveBeenCalledTimes(2) })
    caller.abort()
    pending.resolve({ ok: true, value: { complete: true, skills: [] } })
    await refreshing
    expect(f.catalog.mock.calls[1]![1]!.aborted).toBe(true)
    expect(f.source.snapshot()).toMatchObject({ skills: f.native.skills, complete: true, metadataUnavailable: false })
  })

  it('reopens while an old Host read is pending and never lets the old opening restore a closed panel', async () => {
    const f = await fixture(true)
    const pending = deferred<Awaited<ReturnType<MayflyHostRemote['skillCatalog']>>>()
    f.catalog.mockReturnValueOnce(pending.promise)
    const oldOpening = f.panel.show()
    await vi.waitFor(() => { expect(f.catalog).toHaveBeenCalledOnce() })
    await f.panel.show()
    expect(f.catalog).toHaveBeenCalledTimes(2)
    expect(f.catalog.mock.calls[0]![1]!.aborted).toBe(true)
    expect(f.ctx.mayflyOverlays.list()).toHaveLength(1)
    f.panel.close()
    pending.resolve({ ok: true, value: { complete: true, skills: [] } })
    await oldOpening
    expect(f.ctx.mayflyOverlays.list()).toEqual([])
    expect(f.source.snapshot()).toMatchObject({ skills: f.native.skills, complete: true, metadataUnavailable: false })
  })

  it('uses native narrow detail/back behavior, focuses an already-open browser, and restores the shell on close', async () => {
    const f = await fixture()
    await f.panel.show()
    await f.action({ kind: 'selection-accept', controlId: 'skills-narrow', selectedIds: ['review'], pagePath: [] })
    expect(f.text()).toContain('"title":"review"')
    await f.panel.show()
    expect(f.ctx.mayflyOverlays.list()).toHaveLength(1)
    expect(f.host.listSkills).toHaveBeenCalledOnce()
    expect(f.text()).toContain('"title":"review"')
    await f.action({ kind: 'dismiss', pagePath: [] })
    expect(f.text()).toContain('"title":"Skills"')
    expect(f.restoreFocus).not.toHaveBeenCalled()
    await f.action({ kind: 'dismiss', pagePath: [] })
    expect(f.panel.open).toBe(false)
    expect(f.ctx.mayflyOverlays.list()).toEqual([])
    expect(f.restoreFocus).toHaveBeenCalledOnce()
  })

  it('retains the same-selection last-good catalog on refresh failure and clears missing detail after a real update', async () => {
    const f = await fixture()
    await f.panel.show()
    await f.action({ kind: 'selection-accept', controlId: 'skills-narrow', selectedIds: ['review'], pagePath: [] })
    f.host.listSkills.mockResolvedValueOnce(denied('catalog temporarily unavailable') as never)
    await f.action({ kind: 'activate', controlId: 'skills-actions', actionId: 'refresh', pagePath: [] })
    expect(f.text()).toContain('Skill catalog is incomplete; showing the last complete catalog')
    expect(f.text()).toContain('Review the current changes')
    f.host.listSkills.mockResolvedValueOnce({ ok: true, value: { skills: [] } })
    await f.source.refresh()
    expect(f.text()).toContain('No skills available')
    expect(f.text()).toContain('"title":"Skills"')
    expect(f.text()).not.toContain('Review the current changes')
  })

  it('rejects missing selections and cancelled selection routes without changing focus or data', async () => {
    const f = await fixture()
    f.select(undefined)
    await f.source.refresh()
    await f.panel.show()
    expect(f.host.listSkills).not.toHaveBeenCalled()
    expect(f.ctx.mayflyOverlays.list()).toEqual([])
    f.select(f.host.selected)
    await f.panel.show()
    const empty = await f.action({ kind: 'selection-accept', controlId: 'skills', selectedIds: [], pagePath: [] })
    expect(empty).toMatchObject({ reply: { kind: 'cancelled' } })
    const missing = await f.action({ kind: 'selection-accept', controlId: 'skills', selectedIds: ['missing'], pagePath: [] })
    expect(missing).toMatchObject({ reply: { kind: 'cancelled' } })
    expect(f.restoreFocus).not.toHaveBeenCalled()
  })

  it('keeps a wide selection in the shared browser and ignores unrelated actions', async () => {
    const f = await fixture()
    await f.panel.show()
    const selected = await f.action({ kind: 'selection-accept', controlId: 'skills', selectedIds: ['review'], pagePath: [] })
    expect(selected).toMatchObject({ reply: { kind: 'completed' } })
    expect(f.text()).toContain('"title":"Skills"')
    expect(f.text()).toContain('Use after an implementation is ready')
    const before = f.text()
    const unrelated = await f.action({ kind: 'activate', controlId: 'skills-actions', actionId: 'noop', pagePath: [] })
    expect(unrelated).toMatchObject({ reply: { kind: 'completed' } })
    expect(f.text()).toBe(before)
    expect(f.host.listSkills).toHaveBeenCalledOnce()
  })

  it('fences an initial list result after explicit close or a same-id Host replacement', async () => {
    for (const change of ['close', 'replace'] as const) {
      const f = await fixture()
      const pending = deferred<Awaited<ReturnType<typeof f.host.listSkills>>>()
      f.host.listSkills.mockReturnValueOnce(pending.promise)
      const opening = f.panel.show()
      if (change === 'close') f.panel.close()
      else f.select(wire('two').selected)
      pending.resolve({ ok: true, value: { skills } } as never)
      await opening
      expect(f.ctx.mayflyOverlays.list()).toEqual([])
      expect(f.restoreFocus).not.toHaveBeenCalled()
    }
  })

  it('handles reentrant overlay withdrawal during registration and a stale action before selection invalidation arrives', async () => {
    const withdrawn = await fixture()
    const off = withdrawn.ctx.mayflyOverlays.subscribe(delta => {
      if (delta.kind === 'upsert' && delta.entry.id === 'mayfly.skills') withdrawn.ctx.mayflyOverlays.close('mayfly.skills')
    })
    await withdrawn.panel.show()
    expect(withdrawn.panel.open).toBe(false)
    expect(withdrawn.ctx.mayflyOverlays.list()).toEqual([])
    off()
    const stale = await fixture()
    await stale.panel.show()
    stale.select(wire('two').selected)
    const result = await stale.action({ kind: 'activate', controlId: 'skills-actions', actionId: 'refresh', pagePath: [] })
    expect(result).toMatchObject({ reply: { kind: 'cancelled', dismiss: true } })
    expect(stale.host.listSkills).toHaveBeenCalledOnce()
    stale.panel.close()
  })

  it('closes a retired exact-binding browser and ignores its pending native refresh', async () => {
    const f = await fixture()
    await f.panel.show()
    const pending = deferred<Awaited<ReturnType<typeof f.host.listSkills>>>()
    f.host.listSkills.mockReturnValueOnce(pending.promise)
    const refreshing = f.action({ kind: 'activate', controlId: 'skills-actions', actionId: 'refresh', pagePath: [] })
    await flush()
    const replacement = wire('one')
    f.select(replacement.selected)
    f.source.syncSelection()
    expect(f.ctx.mayflyOverlays.list()).toEqual([])
    pending.reject(new Error('retired catalog error'))
    await refreshing
    expect(f.ctx.mayflyOverlays.list()).toEqual([])
    expect(f.source.list()).toEqual([])
  })

  it('refreshes translated wire content and releases subscriptions after external overlay removal', async () => {
    const f = await fixture()
    await f.panel.show()
    f.ctx.mayflyLocale.setPreference('zh')
    await vi.waitFor(() => { expect(f.text()).toContain('技能') })
    f.ctx.mayflyOverlays.close('mayfly.skills')
    expect(f.panel.open).toBe(false)
    await f.source.refresh()
    f.ctx.mayflyLocale.setPreference('en')
    expect(f.ctx.mayflyOverlays.list()).toEqual([])
    f.source.dispose()
    const reads = f.host.listSkills.mock.calls.length
    await f.source.refresh()
    const observer = vi.fn()
    f.source.subscribe(observer)()
    expect(observer).not.toHaveBeenCalled()
    expect(f.host.listSkills).toHaveBeenCalledTimes(reads)
  })

  it('publishes current transport failures while preserving the exact native last-good list', async () => {
    const f = await fixture()
    await f.panel.show()
    for (const error of [new Error('native discovery failed'), 'native discovery failed']) {
      f.host.listSkills.mockRejectedValueOnce(error)
      await f.source.refresh()
      expect(f.source.snapshot()).toMatchObject({ complete: false, error: 'native discovery failed', skills })
      expect(f.text()).toContain('Skill catalog is incomplete')
    }
  })

  it.each([false, true])('renders the actual reference browser within narrow and wide native widths, metadata=%s', async metadata => {
    const f = await fixture(metadata)
    await f.panel.show()
    const colors = new Proxy({}, { get: () => (text: string) => text }) as MayflySemanticColors
    const components = new MayflyComponentsService(f.ctx, { theme: { colors }, tui: { requestRender: () => {} } } as unknown as MayflyComponentsDeps)
    const paint = (node: MayflyUiNode): void => {
      for (const width of [1, 8, 20, 40, 80, 160]) {
        const compiled = compileMayflyUiNode(node, { emit: () => {}, components, colors, getViewport: () => ({ columns: width, rows: 40 }), screenMode: 'alternate' })
        if (!compiled.ok) throw new Error(compiled.message)
        for (const row of compiled.value.component.render(width)) expect(visibleWidth(row)).toBeLessThanOrEqual(width)
      }
    }
    paint(f.ctx.mayflyOverlays.list()[0]!.node!)
    await f.action({ kind: 'selection-accept', controlId: 'skills-narrow', selectedIds: ['review'], pagePath: [] })
    paint(f.ctx.mayflyOverlays.list()[0]!.node!)
  })
})
