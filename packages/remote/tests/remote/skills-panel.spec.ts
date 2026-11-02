/** Reference wire skill browsing uses the native exact-selection catalog. @module tests/remote/skills-panel */
import { Context } from '@deepseek-ai/cordis'
import * as Provider from '@ephemeral-ai/mayfly-ui/provider'
import * as Frontend from '@ephemeral-ai/mayfly/frontend'
import { compileMayflyUiNode, MayflyComponentsService, visibleWidth, type MayflyComponentsDeps, type MayflySemanticColors } from '@ephemeral-ai/mayfly/core'
import type { MayflyUiActionEvent, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorSkills } from '../../src/remote/editor/skills.ts'
import { EditorSkillsPanel, REMOTE_SKILLS_METADATA_LIMITATION } from '../../src/remote/editor/skills-panel.ts'
import { deferred, denied, flush, wire } from './editor-feature-fixture.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
const skills = [
  { name: 'review', description: 'Review the current changes', whenToUse: 'Use after an implementation is ready', modelInvocable: true, path: '/private/project/.agents/skills/review/SKILL.md' },
  { name: 'publish', description: 'Publish a release', modelInvocable: false },
]

async function fixture() {
  const ctx = new Context()
  await ctx.plugin(Provider)
  await ctx.plugin(Frontend)
  const host = wire('one')
  host.listSkills.mockResolvedValue({ ok: true, value: { skills } } as never)
  let selected: typeof host.selected | undefined = host.selected
  const source = new EditorSkills(() => selected)
  const restoreFocus = vi.fn()
  const panel = new EditorSkillsPanel({ ctx, skills: source, session: () => selected, restoreFocus })
  cleanups.push(async () => { panel.close(); source.dispose(); await ctx.fiber.dispose() })
  const text = () => JSON.stringify(ctx.mayflyOverlays.list()[0]?.node)
  const action = (event: MayflyUiActionEvent) => {
    const current = ctx.mayflyOverlays.list()[0]!
    return current.events.prepare(event, { surfaceId: current.id, source: [], signal: new AbortController().signal, revision: current.revision, operationId: 'skills-action', report: vi.fn() })
  }
  return { ctx, host, source, panel, text, action, restoreFocus, select: (next: typeof selected) => { selected = next } }
}

describe('shared native skills browser', () => {
  it('opens a real editor wire surface with reference list/detail controls and an explicit API metadata gap', async () => {
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

  it('renders the actual reference browser within narrow and wide native widths', async () => {
    const f = await fixture()
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
