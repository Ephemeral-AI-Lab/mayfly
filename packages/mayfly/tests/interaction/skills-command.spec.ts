/** Native skill discovery, exact-Agent command ownership and readonly browser lifetimes. @module */
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry, { type SkillRegistration } from '@deepseek-ai/dsh-skill'
import { createScope } from '@deepseek-ai/dsh-scope'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as skillsCommand from '../../src/interaction/skills-command.ts'
import { catalogFixture } from './catalog-fixture.ts'
import { activate, nativeAction, select } from './native-action-fixture.ts'
import { flushRequests } from './request-fixture.ts'

const contexts: Context[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
const skill = (name: string): SkillRegistration => ({ name, description: `${name} description`, content: `${name} instructions`, source: 'project-dsh' })

async function setup(empty = false) {
  const ctx = new Context(); contexts.push(ctx)
  const f = await catalogFixture(ctx)
  await ctx.plugin(SkillRegistry)
  const providers = []
  if (!empty) for (const target of [f.agent, f.other]) providers.push(await ctx.plugin({ name: `skills-${target.id}`, inject: ['skills'], apply(owner: Context) {
    const scope = createScope(owner, target)
    scope.ctx.skills.register(skill(target === f.agent ? 'alpha' : 'foreign-skill'))
    scope.ctx.skills.register({ ...skill(target === f.agent ? 'beta' : 'foreign-two'), invocation: { modelInvocable: false, userInvocable: true } })
    scope.ctx.skills.register({ ...skill(target === f.agent ? 'hidden' : 'foreign-hidden'), invocation: { modelInvocable: true, userInvocable: false } })
    owner.effect(() => () => scope.dispose())
  } }))
  await flushRequests()
  const fiber = [...ctx.registry.get(skillsCommand)!.fibers][0]!
  await fiber
  const model = () => ctx.mayflyUiInteraction.get('overlay', 'mayfly.skills')!
  const text = () => JSON.stringify(model().registration.node)
  const definition = ctx.commands.find(f.agent, 'skills')!
  const invoke = (signal = new AbortController().signal, agent = f.agent) => definition.handler({ agent, signal, rawInput: '' } as never)
  const open = async () => { const result = await invoke(); await flushRequests(); return result }
  return { ...f, fiber, providers, model, text, definition, invoke, open }
}

describe('native Skills command', () => {
  it('shows only human-invocable skills in the exact native Agent scope and focuses the existing panel', async () => {
    const f = await setup()
    const lookup = vi.spyOn(f.ctx.skills, 'snapshot')
    expect(await f.open()).toEqual({ kind: 'success' })
    expect(lookup.mock.calls.some(([options]) => options?.scope === f.agent)).toBe(true)
    expect(f.text()).toContain('alpha description')
    expect(f.text()).toContain('beta description')
    expect(f.text()).not.toContain('foreign-skill')
    expect(f.text()).not.toContain('hidden instructions')
    const model = f.model()
    await f.open()
    expect(f.model()).toBe(model)
    f.ctx.mayflyLocale.setPreference('zh')
    f.ctx.mayflyLocale.setPreference('en')
    expect(f.text()).toContain('Skills')
  })

  it('preserves wide selection, enters narrow detail, and consumes back before dismissal', async () => {
    const f = await setup()
    await f.open()
    expect(await nativeAction(f.model(), select('skills'))).toMatchObject({ kind: 'cancelled' })
    expect(await nativeAction(f.model(), select('skills', 'absent'))).toMatchObject({ kind: 'cancelled' })
    await nativeAction(f.model(), select('skills', 'beta'))
    expect((f.model().node as { title: string }).title).toBe('Skills')
    await nativeAction(f.model(), select('skills-narrow', 'alpha'))
    expect((f.model().node as { title: string }).title).toBe('alpha')
    expect(await nativeAction(f.model(), { kind: 'dismiss', pagePath: [] })).toMatchObject({ kind: 'completed', dismiss: false })
    expect((f.model().node as { title: string }).title).toBe('Skills')
    expect(await nativeAction(f.model(), { kind: 'dismiss', pagePath: [] })).toMatchObject({ kind: 'completed' })
    expect(await nativeAction(f.model(), select('foreign', 'alpha'))).toMatchObject({ kind: 'completed' })
    expect(await nativeAction(f.model(), activate('unrelated', 'skills-actions'))).toMatchObject({ kind: 'completed' })
    expect(await nativeAction(f.model(), activate('refresh', 'skills-actions'))).toMatchObject({ kind: 'completed' })
  })

  it('returns to its empty list when the selected native skill provider unloads and follows a fresh provider', async () => {
    const f = await setup()
    await f.open()
    await nativeAction(f.model(), select('skills-narrow', 'alpha'))
    await f.providers[0]!.dispose()
    await flushRequests()
    expect(f.text()).toContain('No skills available')
    expect((f.model().node as { title: string }).title).toBe('Skills')
    f.ctx.skills.register(skill('new-skill'))
    await flushRequests()
    expect(f.text()).toContain('new-skill description')
  })

  it('keeps the last complete native catalog visible when discovery is incomplete', async () => {
    const f = await setup()
    const original = f.ctx.skills.snapshot.bind(f.ctx.skills)
    vi.spyOn(f.ctx.skills, 'snapshot').mockImplementation(async options => ({ ...await original(options), complete: false }))
    await f.open()
    expect(f.text()).toContain('alpha')
    expect(f.text()).toContain('Skill catalog is incomplete')
  })

  it('opens an honest empty catalog and rejects stale Agents, cancelled callers and a retired command definition', async () => {
    const f = await setup(true)
    expect(await f.invoke(new AbortController().signal, f.other)).toEqual({ kind: 'error', text: 'no active session' })
    expect(await f.invoke(AbortSignal.abort())).toEqual({ kind: 'success' })
    expect(f.ctx.mayflyOverlays.list()).toHaveLength(0)
    await f.open()
    expect(f.text()).toContain('No skills available')
    await f.fiber.dispose()
    expect(f.ctx.commands.find(f.agent, 'skills')).toBeUndefined()
    expect(await f.invoke()).toEqual({ kind: 'success' })
  })

  it.each(['caller', 'consumer', 'Agent'] as const)('refuses a discovery result after its %s lifetime ends', async ended => {
    const f = await setup()
    const gate = Promise.withResolvers<void>()
    const original = f.ctx.skills.snapshot.bind(f.ctx.skills)
    const read = vi.spyOn(f.ctx.skills, 'snapshot').mockImplementationOnce(async options => { const result = await original(options); await gate.promise; return result })
    const caller = new AbortController()
    const opening = f.invoke(caller.signal)
    await vi.waitFor(() => { expect(read).toHaveBeenCalled() })
    if (ended === 'caller') caller.abort()
    else if (ended === 'consumer') await f.fiber.dispose()
    else f.ctx.mayflyConversations.selectPrimary(f.other)
    gate.resolve()
    expect(await opening).toEqual({ kind: 'success' })
    expect(f.ctx.mayflyOverlays.list()).toHaveLength(0)
  })

  it('closes if caller cancellation wins the native mount gap', async () => {
    const f = await setup()
    const caller = new AbortController()
    const off = f.ctx.mayflyOverlays.subscribe(delta => { if (delta.kind === 'upsert' && delta.entry.id === 'mayfly.skills') caller.abort() })
    await f.invoke(caller.signal)
    off()
    expect(f.ctx.mayflyOverlays.list()).toHaveLength(0)
  })

  it('ignores already queued back and selection publishes after its native registration closes', async () => {
    const f = await setup()
    await f.open()
    const model = f.model()
    await nativeAction(model, select('skills-narrow', 'alpha'))
    const queued = f.ctx.mayflyOverlays.list().find(entry => entry.id === 'mayfly.skills')!.definition.onEvent!.action!
    const context = { surfaceId: model.id, source: model.source, revision: model.revision, operationId: 'queued-before-close', signal: new AbortController().signal, report: vi.fn() }
    f.ctx.mayflyOverlays.close('mayfly.skills')
    const revision = model.revision
    expect(await queued({ kind: 'dismiss', pagePath: [] }, context)).toMatchObject({ kind: 'completed', dismiss: false })
    expect(await queued({ kind: 'selection-accept', pagePath: [], controlId: 'skills-narrow', selectedIds: ['beta'] }, context)).toMatchObject({ kind: 'completed' })
    expect(await queued({ kind: 'activate', pagePath: [], controlId: 'skills-actions', actionId: 'refresh' }, context)).toMatchObject({ kind: 'completed' })
    expect(model.revision).toBe(revision)
    expect(model.disposed).toBe(true)
  })
})
