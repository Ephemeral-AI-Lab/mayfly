/** Native skill discovery shares one exact owner with prompt grammar and rewrite. @module tests/remote/editor-skills */
import { describe, expect, it, vi } from 'vitest'
import { EditorSkills, extractSkillPrefix, rewriteSkillTokens } from '../../src/remote/editor/skills.ts'
import { deferred, wire } from './editor-feature-fixture.ts'

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
})
