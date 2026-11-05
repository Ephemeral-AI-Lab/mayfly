/** Exact-Host completion, skill/slash grammar, cancellation and accepted token semantics. @module */
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorAutocomplete } from '../../src/app/editor/autocomplete.ts'
import type { EditorFeatureSession } from '../../src/app/editor/types.ts'
import { deferred, denied, submissionFixture, wire } from './editor-feature-fixture.ts'

const owners: EditorAutocomplete[] = []
afterEach(() => { for (const owner of owners.splice(0)) owner.dispose() })

async function fixture() {
  const host = wire('autocomplete')
  const listFiles = vi.fn(async (_sessionId: SessionId, _query: string, _signal: AbortSignal): Promise<unknown> => ({ ok: true, value: [{ kind: 'file', path: 'src/index.ts' }, { kind: 'directory', path: 'my files' }, { kind: 'file', path: 'line\nbreak' }] }))
  Object.assign(host.selected.client.remote, { fileReferences: { list: listFiles } })
  let selected: EditorFeatureSession | undefined = host.selected
  let bash = false
  const f = submissionFixture(selected)
  f.local.list = () => [{ name: 'rename', aliases: ['title'], description: 'Rename a session', input: { hint: '<title>' } }, { name: 'new', description: 'New session' }, { name: 'plain', description: 'No arguments', input: { hint: '' } }]
  await f.commands.refresh()
  const notice = { set: vi.fn() }
  const beginWait = vi.fn(() => vi.fn())
  const autocomplete = new EditorAutocomplete({ session: () => selected, commands: f.commands, skills: f.skills, components: f.components, notice, t: (key, values) => key.replace('{command}', String(values?.command)), bash: () => bash, beginWait })
  owners.push(autocomplete)
  const provider = autocomplete.source()
  const suggest = (line: string, signal = new AbortController().signal) => provider.getSuggestions([line], 0, line.length, { signal })
  return { ...f, host, listFiles, autocomplete, provider, notice, suggest, beginWait,
    select(next: EditorFeatureSession | undefined) { selected = next; f.select(next) },
    shell(value: boolean) { bash = value },
  }
}

describe('editor autocomplete', () => {
  it('lists canonical fuzzy slash matches and local aliases with real argument hints', async () => {
    const f = await fixture()
    expect(await f.suggest('/title')).toMatchObject({ prefix: '/title', items: [{ value: '/rename', label: '/rename (title)', description: '<title> — Rename a session' }] })
    expect(await f.suggest('/new')).toMatchObject({ items: [{ description: 'New session' }] })
    expect(await f.suggest('/nothing-matches')).toEqual({ prefix: '/nothing-matches', items: [] })
    expect(f.autocomplete.ghost('/rename')).toBe(' <title>')
    expect(f.autocomplete.ghost('/title ')).toBe('<title>')
    for (const line of ['ordinary', '/missing', '/plain', '/rename with args']) expect(f.autocomplete.ghost(line)).toBeUndefined()
    expect(f.autocomplete.slashHint('/nothing-matches')).toBe('no matching command: /nothing-matches')
    expect(f.autocomplete.slashHint('/nothing-matches with arguments')).toBe('no matching command: /nothing-matches')
    for (const line of ['ordinary', '/new', '/rename with args', '/123', '/?', '/']) expect(f.autocomplete.slashHint(line)).toBeUndefined()
    f.shell(true)
    expect(f.autocomplete.ghost('/rename')).toBeUndefined()
    expect(await f.suggest('/rename')).toBeNull()
    expect(await f.suggest('ordinary')).toBeNull()
  })

  it('queries only the selected Host and filters unsafe paths without a local filesystem probe', async () => {
    const f = await fixture()
    const request = new AbortController()
    expect(await f.suggest('read @src', request.signal)).toMatchObject({ prefix: '@src', items: [{ value: '@src/index.ts', label: 'src/index.ts' }, { value: '@"my files/"', label: 'my files/' }] })
    expect(f.listFiles).toHaveBeenCalledWith(f.host.selected.ref.sessionId, 'src', expect.any(AbortSignal))
    expect(f.beginWait).toHaveBeenCalledWith('Searching files…', expect.any(AbortSignal))
    expect(f.beginWait.mock.results[0]!.value).toHaveBeenCalledOnce()
    const childSignal = f.listFiles.mock.calls[0]![2] as AbortSignal
    request.abort()
    expect(childSignal.aborted).toBe(true)
    expect(f.provider.shouldTriggerFileCompletion?.(['read @src'], 0, 9)).toBe(true)
    expect(f.provider.shouldTriggerFileCompletion?.([], 0, 0)).toBe(false)
    f.select(undefined)
    expect(await f.suggest('@src')).toBeNull()
    expect(f.listFiles).toHaveBeenCalledOnce()
  })

  it('reports an empty settled file match and contains refusals, throws and cancellation', async () => {
    const f = await fixture()
    f.listFiles.mockResolvedValueOnce({ ok: true, value: [] })
    expect(await f.suggest('@missing')).toBeNull()
    expect(f.notice.set).toHaveBeenLastCalledWith('no matching files under the session cwd')
    f.listFiles.mockResolvedValueOnce(denied('no file access'))
    expect(await f.suggest('@private')).toBeNull()
    f.listFiles.mockRejectedValueOnce(new Error('Host offline'))
    expect(await f.suggest('@offline')).toBeNull()
    expect(await f.suggest('@cancelled', AbortSignal.abort())).toBeNull()
    expect(f.notice.set).toHaveBeenCalledOnce()
    expect(f.beginWait.mock.results.every(result => result.value.mock.calls.length === 1)).toBe(true)
  })

  it.each(['new query', 'edit', 'dispose', 'Host', 'Session', 'generation'] as const)('drops a late file catalog after %s', async transition => {
    const f = await fixture()
    const pending = deferred<unknown>()
    f.listFiles.mockReturnValueOnce(pending.promise)
    const reading = f.suggest('@old')
    if (transition === 'new query') await f.suggest('/new')
    if (transition === 'edit') f.autocomplete.invalidate()
    if (transition === 'dispose') f.autocomplete.dispose()
    if (transition === 'Host') f.select(wire('other-host').selected)
    if (transition === 'Session') f.select({ ...f.host.selected, ref: { ...f.host.selected.ref, sessionId: SessionId('other-session') } })
    if (transition === 'generation') f.select({ ...f.host.selected, generation: 2 })
    pending.resolve({ ok: true, value: [{ kind: 'file', path: 'retired.ts' }] })
    expect(await reading).toBeNull()
    expect(f.notice.set).not.toHaveBeenCalled()
    if (transition === 'dispose') expect(await f.suggest('@later')).toBeNull()
  })

  it('offers actual human skills with invocation metadata and lazily refreshes an empty catalog', async () => {
    const f = await fixture()
    expect(await f.suggest('#review')).toBeNull()
    await f.skills.refresh()
    f.host.listSkills.mockResolvedValueOnce({ ok: true, value: { skills: [
      { name: 'review', description: 'Review code', modelInvocable: true },
      { name: 'human', description: 'Human invocation only', modelInvocable: false },
    ] } } as never)
    await f.skills.refresh()
    expect(await f.suggest('#review')).toEqual({ items: [{ value: '#review', label: '#review', description: 'Review code' }], prefix: '#review' })
    expect(await f.suggest('#human')).toMatchObject({ items: [{ description: 'user-only · Human invocation only' }] })
    expect(await f.suggest('#missing')).toBeNull()
    f.shell(true)
    expect(await f.suggest('#review')).toBeNull()
  })

  it('applies only admitted current tokens, remembers accepted files and keeps directory acceptance explicit', async () => {
    const f = await fixture()
    const file = { value: '@src/file.ts', label: 'src/file.ts' }
    expect(f.provider.applyCompletion(['read @src'], 0, 9, file, '@src')).toEqual({ lines: ['read @src/file.ts '], cursorLine: 0, cursorCol: 18 })
    const directory = { value: '@"my files/"', label: 'my files/' }
    f.provider.applyCompletion(['@"my'], 0, 4, directory, '@"my')
    expect(f.autocomplete.tokenSpans('none')).toEqual([])
    expect(f.autocomplete.tokenSpans('@unknown')).toEqual([])
    expect(f.autocomplete.tokenSpans('@src/file.ts @"my files/"')).toEqual([{ start: 0, end: 12, kind: 'mention' }])
    f.autocomplete.acceptDirectory(directory.value)
    expect(f.autocomplete.tokenSpans('@src/file.ts @"my files/"').map(span => span.kind)).toEqual(['mention', 'mention'])
    expect(f.provider.applyCompletion(['#rev rest', 'second'], 0, 4, { value: '#review', label: '#review' }, '#rev')).toEqual({ lines: ['#review rest', 'second'], cursorLine: 0, cursorCol: 8 })
    expect(f.provider.applyCompletion(['/ren rest', 'second'], 0, 4, { value: '/rename', label: '/rename' }, '/ren')).toEqual({ lines: ['/rename rest', 'second'], cursorLine: 0, cursorCol: 8 })
    expect(f.provider.applyCompletion(['changed draft'], 0, 4, file, '@src')).toEqual({ lines: ['changed draft'], cursorLine: 0, cursorCol: 4 })
    expect(f.provider.applyCompletion([], 0, 0, { value: '#review', label: '#review' }, '#review')).toEqual({ lines: [], cursorLine: 0, cursorCol: 0 })
    expect(await f.provider.getSuggestions([], 0, 0, { signal: new AbortController().signal })).toBeNull()
  })
})
