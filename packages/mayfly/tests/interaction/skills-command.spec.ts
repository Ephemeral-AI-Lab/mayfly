/** Shared skills UI and catalog lifetime over the native skill registry.
 * @module @ephemeral-ai/mayfly/tests/interaction/skills-command
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SkillRegistry, { type SkillCandidate, type SkillProviderControl } from '@deepseek-ai/dsh-skill'
import { createScope } from '@deepseek-ai/dsh-scope'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { informationFixture } from './information-fixture.ts'
import { flushRequests, renderRequest } from './request-fixture.ts'
import { rewriteSkillTokens } from '../../src/interaction/skills-catalog.ts'
import { skillGroup, skillsNode } from '../../src/interaction/skills-command.ts'
import { ADVERSARIAL, SCAN_WIDTHS, expectLinesFit } from '../core/width-scan.ts'

const candidate = (name: string, options: Partial<SkillCandidate> = {}): SkillCandidate => ({ name, description: `${name} description`, source: 'custom', provider: 'catalog-test', rank: 1, locator: name, invocation: { userInvocable: true, modelInvocable: true }, ...options })
const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
async function setup() {
  const ctx = new Context(); contexts.push(ctx)
  const bench = await informationFixture(ctx)
  const skillsOwner = await ctx.plugin(SkillRegistry)
  let control!: SkillProviderControl
  let candidates = [candidate('first', { whenToUse: 'Use for the first task.' }), candidate('user-only', { source: 'user-dsh', invocation: { userInvocable: true, modelInvocable: false } }), candidate('model-only', { invocation: { userInvocable: false, modelInvocable: true } })]
  let complete = true
  const get = vi.fn(async () => undefined)
  const list = vi.fn(async (_options: { signal?: AbortSignal }) => ({ candidates, complete }))
  const provider = await ctx.plugin({ name: 'skill-candidates', inject: ['skills'], apply(owner: Context) {
    owner.skills.registerProvider(next => { control = next; return { name: 'catalog-test', list, get } })
  } })
  await ctx.mayflySkillsCatalog.refresh()
  const publish = async (next: SkillCandidate[], done = true) => { candidates = next; complete = done; control.invalidate(); await ctx.mayflySkillsCatalog.refresh(); await flushRequests() }
  return { ...bench, skillsOwner, provider, list, get, publish, invalidate: () => control.invalidate() }
}

describe('shared skills listing', () => {
  it('shares the user-invocable catalog with prompt rewriting and exposes guidance through detail', async () => {
    const bench = await setup()
    await bench.run('/skills')
    const model = bench.model('mayfly.skills')
    const node = JSON.stringify(model.node)
    expect(node).toContain('first')
    expect(node).toContain('user-only')
    expect(node).not.toContain('model-only')
    expect(rewriteSkillTokens(bench.ctx, '#first #model-only')).toBe('/first #model-only')
    model.emit({ kind: 'selection-accept', pagePath: [], controlId: 'skills', selectedIds: ['first'] })
    await flushRequests()
    const detail = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.skills.detail')!
    expect(JSON.stringify(detail.node)).toContain('Use for the first task.')
    expect(bench.get).not.toHaveBeenCalled()
    detail.requestClose()
    await flushRequests()
    expect(model.disposed).toBe(false)
    await bench.run('/skills')
    expect(bench.model('mayfly.skills')).toBe(model)
  })

  it('retains last complete data during incomplete discovery and closes removed details after settlement', async () => {
    const bench = await setup()
    await bench.run('/skills')
    const model = bench.model('mayfly.skills')
    model.emit({ kind: 'selection-accept', pagePath: [], controlId: 'skills', selectedIds: ['first'] })
    await flushRequests()
    const detail = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.skills.detail')!
    await bench.publish([candidate('next')], false)
    expect(bench.ctx.mayflySkillsCatalog.userInvocable().map(item => item.name)).toContain('first')
    expect(JSON.stringify(detail.node)).toContain('last complete catalog')
    await bench.publish([candidate('next')])
    expect(detail.disposed).toBe(true)
    expect(model.choice({ pagePath: [], controlId: 'skills' })!.definition.items.map(item => item.id)).toEqual(['next'])
  })

  it('drops old scoped skills when a different Agent with the same Session ID is selected', async () => {
    const bench = await setup()
    await bench.ctx.plugin({ name: 'agent-skill', inject: ['skills'], apply(owner: Context) {
      const scope = createScope(owner, bench.agent)
      scope.ctx.skills.register({ name: 'old-only', description: 'Old scope', source: 'runtime', content: 'body' })
      owner.effect(() => () => scope.dispose())
    } })
    await bench.ctx.mayflySkillsCatalog.refresh()
    expect(bench.ctx.mayflySkillsCatalog.userInvocable().map(skill => skill.name)).toContain('old-only')
    await bench.run('/skills')
    const old = bench.model('mayfly.skills')
    const replacement = { ...bench.agent } as Agent
    bench.agents.set(bench.agent.id, replacement)
    bench.ctx.mayflyCurrentAgent.select(replacement)
    await bench.ctx.mayflySkillsCatalog.refresh()
    expect(old.disposed).toBe(true)
    expect(bench.ctx.mayflySkillsCatalog.userInvocable().map(skill => skill.name)).not.toContain('old-only')
  })

  it('aborts old discovery and cannot publish its late result after switching Agent', async () => {
    const bench = await setup()
    const gate = Promise.withResolvers<{ candidates: SkillCandidate[], complete: boolean }>()
    let signal!: AbortSignal
    bench.list.mockImplementationOnce(options => { signal = options.signal!; return gate.promise })
    bench.invalidate()
    const pending = bench.ctx.mayflySkillsCatalog.refresh()
    await vi.waitFor(() => expect(signal).toBeDefined())
    bench.ctx.mayflyCurrentAgent.select(bench.other)
    expect(signal.aborted).toBe(true)
    gate.resolve({ candidates: [candidate('stale')], complete: true })
    await pending
    await bench.ctx.mayflySkillsCatalog.refresh()
    expect(bench.ctx.mayflySkillsCatalog.userInvocable().map(skill => skill.name)).not.toContain('stale')
  })

  it.each(['skills', 'frontend', 'parent'] as const)('withdraws the view tree on %s disposal', async reason => {
    const bench = await setup()
    await bench.run('/skills')
    const model = bench.model('mayfly.skills')
    model.emit({ kind: 'selection-accept', pagePath: [], controlId: 'skills', selectedIds: ['first'] })
    await flushRequests()
    const detail = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.skills.detail')!
    if (reason === 'parent') model.requestClose()
    else await (reason === 'skills' ? bench.skillsOwner : bench.front).dispose()
    await flushRequests()
    expect(model.disposed).toBe(true)
    expect(detail.disposed).toBe(true)
  })

  it('contains observer failures without blocking catalog or prompt gesture updates', async () => {
    const bench = await setup()
    const off = bench.ctx.mayflySkillsCatalog.subscribe(() => { throw new Error('observer failure') })
    await bench.publish([candidate('fresh')])
    expect(rewriteSkillTokens(bench.ctx, '#fresh')).toBe('/fresh')
    off()
  })

  it('keeps group and invocation facts in shared list metadata', () => {
    expect(skillGroup('project-dsh')).toBe('Project')
    expect(skillGroup('project-agents')).toBe('Project')
    expect(skillGroup('user-agents')).toBe('User')
    const node = skillsNode([candidate('custom'), candidate('project', { source: 'project-dsh' }), candidate('user', { source: 'user-dsh' })], true, key => key)
    expect(JSON.stringify(node)).toContain('"group":"Project"')
    expect(JSON.stringify(node)).toContain('"group":"User"')
    expect(JSON.stringify(skillsNode([candidate('z'), candidate('a')], true, key => key))).toMatch(/a.*z/u)
  })

  it('handles refresh, removed skills, and details without optional guidance', async () => {
    const bench = await setup()
    await bench.run('/skills')
    const browser = bench.model('mayfly.skills')
    browser.invoke('refresh')
    await flushRequests()
    const entry = bench.ctx.mayflyOverlays.list().find(item => item.id === browser.id)!
    const context = { surfaceId: entry.id, operationId: 'missing', source: entry.source, revision: entry.revision, signal: new AbortController().signal, report: vi.fn() }
    expect(await entry.definition.onEvent!.action!({ kind: 'selection-accept', pagePath: [], controlId: 'skills', selectedIds: ['missing'] }, context)).toMatchObject({ kind: 'cancelled' })
    browser.emit({ kind: 'selection-accept', pagePath: [], controlId: 'skills', selectedIds: ['user-only'] })
    await flushRequests()
    const detail = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.skills.detail')!
    expect(JSON.stringify(detail.node)).toContain('user-only description')
  })

  it('contains aborted, wrong-Agent, post-refresh, and unloaded command calls', async () => {
    const bench = await setup()
    const command = bench.ctx.commands.find(bench.agent, 'skills')!
    const aborted = new AbortController()
    aborted.abort()
    expect(await command.handler({ agent: bench.agent, signal: aborted.signal } as never)).toEqual({ kind: 'success' })
    expect(await command.handler({ agent: bench.other, signal: new AbortController().signal } as never)).toEqual({ kind: 'error', text: 'no active session' })

    const gate = Promise.withResolvers<void>()
    vi.spyOn(bench.ctx.mayflySkillsCatalog, 'refresh').mockReturnValueOnce(gate.promise)
    const duringRefresh = new AbortController()
    const pending = command.handler({ agent: bench.agent, signal: duringRefresh.signal } as never)
    duringRefresh.abort()
    gate.resolve()
    expect(await pending).toEqual({ kind: 'success' })

    const retained = command.handler
    await bench.front.dispose()
    expect(await retained({ agent: bench.agent, signal: new AbortController().signal } as never)).toEqual({ kind: 'success' })
  })

  it('closes a browser when the invocation aborts during its opening publication', async () => {
    const bench = await setup()
    const controller = new AbortController()
    bench.ctx.mayflyOverlays.subscribe(delta => { if (delta.kind === 'upsert' && delta.entry.id === 'mayfly.skills') controller.abort() })
    const command = bench.ctx.commands.find(bench.agent, 'skills')!
    expect(await command.handler({ agent: bench.agent, signal: controller.signal } as never)).toEqual({ kind: 'success' })
    expect(bench.ctx.mayflyOverlays.list().some(entry => entry.id === 'mayfly.skills')).toBe(false)
  })

  it.each(ADVERSARIAL)('contains skills metadata and guidance: $name', async ({ name, text }) => {
    const bench = await setup()
    await bench.publish([candidate('adversarial', { description: text, whenToUse: text })])
    await bench.run('/skills')
    const browser = bench.model('mayfly.skills')
    browser.emit({ kind: 'selection-accept', pagePath: [], controlId: 'skills', selectedIds: ['adversarial'] })
    await flushRequests()
    const detail = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.skills.detail')!
    for (const model of [browser, detail]) {
      const viewport = { columns: 80, rows: 20 }
      const renderer = renderRequest(model, viewport)
      for (const width of SCAN_WIDTHS) for (const height of [20, 7, 3]) {
        viewport.columns = width; viewport.rows = height
        const rows = renderer.component.render(width)
        expectLinesFit(`skills/${name}/${height}`, rows, width)
        expect(rows.length).toBeLessThanOrEqual(height)
      }
      renderer.runtime.dispose()
    }
  })
})
