/** Native skill discovery shares one exact owner with prompt grammar and rewrite. @module tests/remote/editor-skills */
import { describe, expect, it, vi } from 'vitest'
import type { MayflyHostRemote, MayflySkillCatalog } from '../../src/hosts/host-contract.ts'
import type { EditorFeatureSession } from '../../src/app/editor/types.ts'
import { EditorSkills, extractSkillPrefix, rewriteSkillTokens } from '../../src/app/editor/skills.ts'
import { deferred, denied, wire } from './editor-feature-fixture.ts'

const nativeCatalog: MayflySkillCatalog = { complete: true, skills: [
  { name: 'review', description: 'Review the changes', source: 'project-agents', provider: 'filesystem', modelInvocable: false, whenToUse: 'Before merge' },
] }

function hostCatalog(host: ReturnType<typeof wire>) {
  const capabilities = vi.fn<MayflyHostRemote['capabilities']>(async () => ({ ok: true, value: {
    protocolVersion: 1, hostVersion: '0.1.4-rc.2', requiredDshVersion: '0.2.2-alpha.2', features: ['skillCatalog'],
  } }))
  const catalog = vi.fn<MayflyHostRemote['skillCatalog']>(async () => ({ ok: true, value: nativeCatalog }))
  Object.assign(host.selected.client.remote, { mayflyHost: { capabilities, skillCatalog: catalog } })
  return { capabilities, catalog }
}

describe('native editor skills', () => {
  it('recognizes only the documented token boundary and rewrites actual settled skill names', () => {
    expect(['#', 'prefix #review', 'C#review', '#review ', '#review-name', 'ordinary'].map(extractSkillPrefix)).toEqual(['', 'review', null, null, 'review-name', null])
    const rows = [{ name: 'review', description: 'Review', modelInvocable: true }]
    expect(rewriteSkillTokens(' #review\n#unknown C#review #review. [image #3]', rows)).toBe(' /review\n#unknown C#review #review. [image #3]')
    expect(rewriteSkillTokens('#review', [])).toBe('#review')
  })

  it('shares one in-flight native read and drops every observer and read after disposal', async () => {
    const host = wire('one')
    const source = new EditorSkills(() => host.selected)
    const pending = deferred<Awaited<ReturnType<typeof host.listSkills>>>()
    host.listSkills.mockReturnValueOnce(pending.promise)
    const changed = vi.fn()
    const off = source.subscribe(changed)
    const first = source.refresh()
    const second = source.refresh()
    expect(first).toBe(second)
    expect(host.listSkills).toHaveBeenCalledOnce()
    pending.resolve({ ok: true, value: { skills: [{ name: 'review', description: 'Review' }] } })
    await first
    expect(source.rewrite('use #review')).toBe('use /review')
    expect(changed).toHaveBeenCalledOnce()
    off()
    source.dispose()
    expect(source.list()).toEqual([])
    expect(source.snapshot()).toMatchObject({ complete: false, skills: [] })
    expect(source.rewrite('#review')).toBe('#review')
    await source.refresh()
    expect(host.listSkills).toHaveBeenCalledOnce()
  })

  it('reads real Host metadata and preserves the last complete native catalog during incomplete discovery', async () => {
    const host = wire('native')
    const { catalog, capabilities } = hostCatalog(host)
    const source = new EditorSkills(() => host.selected)
    await source.refresh()
    expect(source.snapshot()).toEqual({ ...nativeCatalog, metadataUnavailable: false })
    expect(capabilities).toHaveBeenCalledOnce()
    expect(catalog).toHaveBeenCalledWith({ sessionId: host.selected.ref.sessionId }, expect.any(AbortSignal))
    expect(host.listSkills).not.toHaveBeenCalled()
    catalog.mockResolvedValueOnce({ ok: true, value: { complete: false, skills: [] } })
    await source.refresh()
    expect(source.snapshot()).toMatchObject({ complete: false, skills: nativeCatalog.skills, metadataUnavailable: false })
    source.dispose()
  })

  it('falls back only when the Host omits the capability and does not hide failed metadata reads', async () => {
    const host = wire('capabilities')
    const { capabilities, catalog } = hostCatalog(host)
    const source = new EditorSkills(() => host.selected)
    capabilities.mockResolvedValueOnce({ ok: true, value: { protocolVersion: 1, hostVersion: '0.1.4-rc.2', requiredDshVersion: '0.2.2-alpha.2', features: [] } })
    await source.refresh()
    expect(source.snapshot()).toMatchObject({ complete: true, metadataUnavailable: true })
    expect(host.listSkills).toHaveBeenCalledOnce()
    expect(catalog).not.toHaveBeenCalled()
    capabilities.mockResolvedValueOnce(denied('capability read failed'))
    await source.refresh()
    expect(source.snapshot()).toMatchObject({ complete: false, error: 'capability read failed', metadataUnavailable: true })
    catalog.mockResolvedValueOnce(denied('metadata read failed'))
    await source.refresh()
    expect(source.snapshot()).toMatchObject({ complete: false, error: 'metadata read failed', metadataUnavailable: false })
    expect(host.listSkills).toHaveBeenCalledOnce()
    source.dispose()
  })

  it.each(['capabilities', 'catalog'] as const)('cancels a %s read without publishing a late success or error', async stage => {
    for (const outcome of ['success', 'failure'] as const) {
      const host = wire('cancelled')
      const remote = hostCatalog(host)
      const source = new EditorSkills(() => host.selected)
      const request = new AbortController()
      const pending = deferred<never>()
      remote[stage].mockReturnValueOnce(pending.promise)
      const reading = source.refresh(request.signal)
      await vi.waitFor(() => { expect(remote[stage]).toHaveBeenCalledOnce() })
      request.abort()
      if (outcome === 'success') pending.resolve({ ok: true, value: stage === 'catalog' ? nativeCatalog : { features: ['skillCatalog'] } } as never)
      else pending.reject(new Error('cancelled native failure'))
      await reading
      expect(source.snapshot()).toMatchObject({ skills: [], complete: false, metadataUnavailable: false })
      expect(source.snapshot()).not.toHaveProperty('error')
      if (stage === 'capabilities') expect(remote.catalog).not.toHaveBeenCalled()
      else expect(remote.catalog.mock.calls[0]![1]!.aborted).toBe(true)
      source.dispose()
    }
  })

  it.each(['Host', 'Client', 'Session', 'binding', 'generation', 'connection', 'detach', 'dispose'] as const)('fences an exact native catalog across %s retirement before invalidation arrives', async retirement => {
    const host = wire('same')
    const { catalog } = hostCatalog(host)
    let selected: EditorFeatureSession | undefined = host.selected
    let connection = 1
    Object.assign(host.selected.client.state, { getSnapshot: () => ({ generation: connection }) })
    const source = new EditorSkills(() => selected)
    const pending = deferred<Awaited<ReturnType<MayflyHostRemote['skillCatalog']>>>()
    catalog.mockReturnValueOnce(pending.promise)
    const reading = source.refresh()
    await vi.waitFor(() => { expect(catalog).toHaveBeenCalledOnce() })
    if (retirement === 'Host') selected = wire('other').selected
    if (retirement === 'Client') selected = wire('same').selected
    if (retirement === 'Session') selected = { ...host.selected, ref: { ...host.selected.ref, sessionId: 'other-session' as typeof host.selected.ref.sessionId } }
    if (retirement === 'binding') selected = { ...host.selected, session: wire('same').selected.session }
    if (retirement === 'generation') selected = { ...host.selected, generation: 2 }
    if (retirement === 'connection') connection += 1
    if (retirement === 'detach') selected = undefined
    if (retirement === 'dispose') source.dispose()
    pending.resolve({ ok: true, value: nativeCatalog })
    await reading
    expect(catalog.mock.calls[0]![1]!.aborted).toBe(true)
    expect(source.list()).toEqual([])
    expect(source.snapshot()).toMatchObject({ complete: false, metadataUnavailable: false })
    source.dispose()
  })

  it('does not start an already cancelled read or replace a newer catalog with an older flight', async () => {
    const first = wire('first')
    const second = wire('second')
    const old = hostCatalog(first)
    const fresh = hostCatalog(second)
    let selected: EditorFeatureSession = first.selected
    const source = new EditorSkills(() => selected)
    await source.refresh(AbortSignal.abort())
    expect(old.capabilities).not.toHaveBeenCalled()
    const pending = deferred<Awaited<ReturnType<MayflyHostRemote['capabilities']>>>()
    old.capabilities.mockReturnValueOnce(pending.promise)
    const reading = source.refresh()
    selected = second.selected
    await source.refresh()
    expect(fresh.catalog).toHaveBeenCalledOnce()
    pending.reject(new Error('old Host failure'))
    await reading
    expect(source.snapshot()).toEqual({ ...nativeCatalog, metadataUnavailable: false })
    source.dispose()
  })

  it('starts a fresh native read while a cancelled predecessor still waits for its Host', async () => {
    const host = wire('retry')
    const { catalog } = hostCatalog(host)
    const source = new EditorSkills(() => host.selected)
    const pending = deferred<Awaited<ReturnType<MayflyHostRemote['skillCatalog']>>>()
    catalog.mockReturnValueOnce(pending.promise)
    const caller = new AbortController()
    const first = source.refresh(caller.signal)
    await vi.waitFor(() => { expect(catalog).toHaveBeenCalledOnce() })
    caller.abort()
    await source.refresh()
    expect(catalog).toHaveBeenCalledTimes(2)
    expect(source.snapshot()).toEqual({ ...nativeCatalog, metadataUnavailable: false })
    pending.resolve({ ok: true, value: { complete: true, skills: [] } })
    await first
    expect(source.snapshot()).toEqual({ ...nativeCatalog, metadataUnavailable: false })
    source.dispose()
  })
})
