/** Independent command discovery, alias routing, file-mention, and draft contracts. @module mayfly-remote/tests/editor-contracts */
import { describe, expect, it, vi } from 'vitest'
import type { EditorHostFiles } from '../../src/remote/editor/types.ts'
import { activeMention, applyMention, formatMention, mentionItem, mentionPath, readHostFile } from '../../src/remote/editor/mentions.ts'
import { canonicalCommandLine, canonicalLocalCommand, editorCommandLabel, EditorDraftStore, errorMessage, filterEditorCommands, parseEditorCommand } from '../../src/remote/editor/utils.ts'
import { denied, deferred, submissionFixture, wire } from './editor-feature-fixture.ts'

describe('command discovery and invocation', () => {
  it('combines Host discovery with canonical local aliases and local names shadow Host names', async () => {
    const host = wire()
    const f = submissionFixture(host.selected)
    f.local.list = () => [{ name: 'host-only', description: 'Local override', aliases: ['h'], input: { hint: 'local arg' } }, { name: 'quit', description: 'Exit' }]
    await f.commands.refresh()
    expect(f.commands.list().map(command => command.name)).toEqual(['host-only', 'quit'])
    expect(f.commands.hint('host-only')).toBe('local arg')
    expect(f.commands.hint('absent')).toBeUndefined()
    f.local.execute = vi.fn<typeof f.local.execute>(async invocation => ({ kind: 'success', text: invocation.line }))
    const signal = new AbortController().signal
    expect(await f.commands.execute('/h  exactly\nthese args', [], signal)).toEqual({ handled: true, exit: false, accepted: true })
    expect(f.local.execute).toHaveBeenCalledWith(expect.objectContaining({ line: '/host-only  exactly\nthese args', rawInput: '  exactly\nthese args', signal }))
    expect(host.executeCommand).not.toHaveBeenCalled()
    expect(f.notices.at(-1)).toBe('/host-only  exactly\nthese args')
  })

  it('deduplicates concurrent list requests and fences same-SessionId responses by Host and reconnect generation', async () => {
    const a = wire('one')
    const b = wire('two')
    const pending = deferred<Awaited<ReturnType<typeof a.listCommands>>>()
    a.listCommands.mockImplementationOnce(() => pending.promise)
    const f = submissionFixture(a.selected)
    const stale = f.commands.refresh()
    expect(f.commands.refresh()).toBe(stale)
    f.select(b.selected)
    expect(f.commands.list()).toEqual([])
    await f.commands.refresh()
    pending.resolve({ ok: true, value: [{ name: 'retired-host-command', description: 'Stale', input: { hint: 'stale' } }] })
    await stale
    expect(f.commands.list().map(command => command.name)).toEqual(['host-only'])
    f.select({ ...b.selected, generation: 2 })
    expect(f.commands.list()).toEqual([])
    b.listCommands.mockRejectedValueOnce(new Error('reconnect list failed'))
    await f.commands.refresh()
    expect(f.commands.list()).toEqual([])
    await f.commands.refresh()
    expect(f.commands.hint('host-only')).toBe('<value>')
    f.select(undefined)
    await f.commands.refresh()
    expect(f.commands.list()).toEqual([])
  })

  it('keeps the last same-generation catalog after a refused refresh and restores it on retry', async () => {
    const host = wire()
    const f = submissionFixture(host.selected)
    await f.commands.refresh()
    host.listCommands.mockResolvedValueOnce(denied('catalog offline') as never)
    await f.commands.refresh()
    expect(f.commands.list().map(command => command.name)).toEqual(['host-only'])
    expect(f.notices).toEqual([])
  })

  it('forwards declined local commands with the original line and images to the exact Host', async () => {
    const host = wire('other')
    const f = submissionFixture(host.selected)
    f.local.list = () => [{ name: 'host-only', aliases: ['h'], description: 'Local decline' }]
    const image = { type: 'image' as const, mediaType: 'image/png' as const, data: 'YWJj' }
    const signal = new AbortController().signal
    const outcome = await f.commands.execute('/h  original', [image], signal)
    expect(outcome.accepted).toBe(true)
    expect(host.executeCommand).toHaveBeenCalledWith(host.selected.ref.sessionId, '/h  original', [image], signal)
    expect(f.notices.at(-1)).toBe('Host completed')
  })

  it('passes native ordered file receipts and complete encoded image metadata to the captured Host command', async () => {
    const host = wire('other')
    const f = submissionFixture(host.selected)
    const attachments = [
      { type: 'file' as const, receiptId: 'native-receipt-2' },
      { type: 'image' as const, mediaType: 'image/png' as const, data: 'YWJj', name: 'diagram.png' },
      { type: 'file' as const, receiptId: 'native-receipt-1' },
    ]
    const signal = new AbortController().signal
    expect(await f.commands.execute('/host-only  untouched', attachments, signal)).toEqual({ handled: true, exit: false, accepted: true })
    expect(host.executeCommand).toHaveBeenCalledExactlyOnceWith(host.selected.ref.sessionId, '/host-only  untouched', attachments, signal)
    expect(host.executeCommand.mock.calls[0]![2]).toBe(attachments)
  })

  it.each(['abort', 'Host', 'binding'] as const)('never dispatches a local-declined file command after %s retirement', async transition => {
    const host = wire()
    const f = submissionFixture(host.selected)
    const pending = deferred<{ kind: 'unhandled' }>()
    f.local.list = () => [{ name: 'host-only', description: 'Local decline' }]
    f.local.execute = vi.fn(() => pending.promise)
    const controller = new AbortController()
    const command = f.commands.execute('/host-only', [{ type: 'file', receiptId: 'receipt' }], controller.signal)
    if (transition === 'abort') controller.abort()
    else f.select(transition === 'Host' ? wire('two').selected : { ...host.selected, session: wire().selected.session })
    pending.resolve({ kind: 'unhandled' })
    expect(await command).toEqual({ handled: true, exit: false, accepted: false })
    expect(host.executeCommand).not.toHaveBeenCalled()
    expect(f.notices).toEqual([])
  })

  it('admits no local or native command after the caller has already aborted', async () => {
    const host = wire()
    const f = submissionFixture(host.selected)
    f.local.list = () => [{ name: 'host-only', description: 'Local command' }]
    f.local.execute = vi.fn()
    const controller = new AbortController()
    controller.abort()
    expect(await f.commands.execute('/host-only', [{ type: 'file', receiptId: 'receipt' }], controller.signal)).toEqual({ handled: true, exit: false, accepted: false })
    expect(f.local.execute).not.toHaveBeenCalled()
    expect(host.executeCommand).not.toHaveBeenCalled()
    expect(f.notices).toEqual([])
  })

  it('does not send invalid/sessionless commands or pretend unknown Host commands succeeded', async () => {
    const host = wire()
    const f = submissionFixture(host.selected)
    const signal = new AbortController().signal
    expect((await f.commands.execute('ordinary prompt', [], signal)).accepted).toBe(false)
    f.select(undefined)
    expect((await f.commands.execute('/need-session', [], signal)).accepted).toBe(false)
    expect(host.executeCommand).not.toHaveBeenCalled()
    f.select(host.selected)
    host.executeCommand.mockResolvedValueOnce({ ok: true, value: undefined } as never)
    expect((await f.commands.execute('/unknown', [], signal)).accepted).toBe(false)
    expect(f.notices.at(-1)).toBe('unknown command: /unknown')
    host.executeCommand.mockResolvedValueOnce(denied('command transport failed') as never)
    await expect(f.commands.execute('/host-only', [], signal)).rejects.toThrow('command transport failed')
    host.executeCommand.mockResolvedValueOnce({ ok: true, value: { result: { kind: 'error', text: 'Host refused' } } } as never)
    expect((await f.commands.execute('/host-only', [], signal)).accepted).toBe(true)
    expect(f.notices.at(-1)).toBe('Host refused')
    expect(f.commands.failure(null)).toBe('command execution failed')
  })

  it.each(['other Host', 'new client', 'reconnect'] as const)('does not publish a Host command result after selecting %s', async transition => {
    const host = wire()
    const response = deferred<Awaited<ReturnType<typeof host.executeCommand>>>()
    host.executeCommand.mockImplementationOnce(() => response.promise)
    const f = submissionFixture(host.selected)
    const command = f.commands.execute('/host-only', [], new AbortController().signal)
    f.select(transition === 'reconnect' ? { ...host.selected, generation: 2 } : wire(transition === 'new client' ? 'one' : 'two').selected)
    response.resolve({ ok: true, value: { result: { kind: 'success', text: 'old Host completed' } } })
    expect((await command).accepted).toBe(true)
    expect(f.notices).toEqual([])
    expect(host.executeCommand).toHaveBeenCalledOnce()
  })

  it('suppresses a late unknown-command result after caller cancellation', async () => {
    const host = wire()
    const response = deferred<Awaited<ReturnType<typeof host.executeCommand>>>()
    host.executeCommand.mockReturnValueOnce(response.promise)
    const f = submissionFixture(host.selected)
    const abort = new AbortController()
    const command = f.commands.execute('/unknown', [], abort.signal)
    abort.abort()
    response.resolve({ ok: true, value: undefined } as never)
    expect(await command).toEqual({ handled: true, exit: false, accepted: false })
    expect(f.notices).toEqual([])
  })
})

describe('editor command and draft data contracts', () => {
  it('preserves arguments while rejecting accidental slash prefixes and noncanonical command spelling', () => {
    expect(parseEditorCommand('/model  name\nother')).toEqual({ name: 'model', rawInput: '  name\nother' })
    expect(parseEditorCommand('/model')).toEqual({ name: 'model', rawInput: '' })
    for (const line of ['//model', '/Model', '/1model', '/model@host', ' /model', '/']) expect(parseEditorCommand(line)).toBeUndefined()
    const commands = [{ name: 'quit', description: 'Exit', aliases: ['q', 'exit'] }]
    const match = canonicalLocalCommand(commands, 'q')!
    expect(canonicalCommandLine(match, '  now')).toBe('/quit  now')
    expect(canonicalLocalCommand(commands, 'unknown')).toBeUndefined()
  })

  it('ranks real fuzzy matches by canonical names before aliases and requires every query token', () => {
    const f = submissionFixture()
    const commands = [
      { name: 'commit', description: 'Commit', aliases: ['save'] },
      { name: 'save', description: 'Save' },
      { name: 'unrelated', description: 'Other' },
      { name: 'store', description: 'Store', aliases: ['save-item', 'save'] },
    ]
    expect(filterEditorCommands(commands, '', f.components).map(match => match.command.name)).toEqual(commands.map(command => command.name))
    const matched = filterEditorCommands(commands, 'save', f.components)
    expect(matched[0]).toMatchObject({ command: { name: 'save' }, viaAlias: false })
    expect(matched.map(editorCommandLabel)).toContain('/commit (save)')
    expect(filterEditorCommands(commands, 'unrelated missing', f.components)).toEqual([])
    expect(editorCommandLabel({ command: commands[1]!, viaAlias: false })).toBe('/save')
    expect(editorCommandLabel({ command: commands[1]!, viaAlias: true })).toBe('/save ()')
  })

  it('bounds multiline feedback and preserves independent history, mode and paste tables across remounts', () => {
    expect(errorMessage(new Error(' first\nsecond\r\nthird '))).toBe('first · second · third')
    expect(errorMessage('   ', 'fallback')).toBe('fallback')
    expect(errorMessage({ unsafe: true })).toBe('operation failed')
    expect(errorMessage('x'.repeat(2500))).toHaveLength(2000)
    const a = new EditorDraftStore()
    const b = new EditorDraftStore()
    const pastes = new Map([[1, 'pasted lines']])
    const history = ['one']
    const historyPastes = [pastes]
    a.stashDraft({ raw: '[paste #1]', pastes })
    a.stashMode('bash')
    a.stashHistory(history, historyPastes)
    history.push('mutated caller array')
    historyPastes.push(new Map())
    expect(a.currentHistory()).toEqual(['one'])
    expect(a.currentHistoryPastes()).toEqual([pastes])
    expect(a.currentDraft().pastes.get(1)).toBe('pasted lines')
    expect(a.currentMode()).toBe('bash')
    expect(b.currentDraft().raw).toBe('')
    a.clearDraft()
    expect(a.currentDraft()).toEqual({ raw: '', pastes: new Map() })
    expect(a.currentMode()).toBe('prompt')
  })
})

describe('Host mention completion and file preview contracts', () => {
  it('recognizes cursor-local quoted tokens without matching emails and leaves unsafe paths unavailable', () => {
    expect(activeMention('contact a@b.com', 15)).toBeUndefined()
    expect(activeMention('read @src/file then', 14)).toEqual({ prefix: '@src/file', query: 'src/file', quoted: false })
    expect(activeMention('read @"my files', 15)).toEqual({ prefix: '@"my files', query: 'my files', quoted: true })
    expect(formatMention({ kind: 'file', path: 'src/a.ts' }, false)).toBe('@src/a.ts')
    expect(formatMention({ kind: 'file', path: 'my file.ts' }, false)).toBe('@"my file.ts"')
    expect(formatMention({ kind: 'directory', path: 'my files' }, false)).toBe('@"my files/')
    expect(mentionItem({ kind: 'directory', path: 'my files' }, true)).toEqual({ value: '@"my files/"', label: 'my files/' })
    for (const path of ['line\nbreak', 'a"b', '\u0000bad']) {
      expect(formatMention({ kind: 'file', path }, false)).toBeUndefined()
      expect(mentionItem({ kind: 'file', path }, false)).toBeUndefined()
    }
    expect(mentionPath('@src/a.ts')).toBe('src/a.ts')
    expect(mentionPath('@"my file"')).toBe('my file')
    expect(mentionPath("@'my file'")).toBe('my file')
    expect(mentionPath('@"incomplete')).toBe('incomplete')
  })

  it('applies a file completion without a duplicate quote and keeps directory caret inside its quote', () => {
    const file = mentionItem({ kind: 'file', path: 'my file.ts' }, true)!
    expect(applyMention([], 0, 0, file, '')).toEqual({ lines: [], cursorLine: 0, cursorCol: file.value.length + 1 })
    expect(applyMention(['read @"my" after'], 0, 9, file, '@"my')).toEqual({ lines: ['read @"my file.ts"  after'], cursorLine: 0, cursorCol: 19 })
    const directory = mentionItem({ kind: 'directory', path: 'my files' }, true)!
    const entered = applyMention(['@"my', 'second line'], 0, 4, directory, '@"my')
    expect(entered.lines).toEqual(['@"my files/"', 'second line'])
    expect(entered.cursorCol).toBe(11)
  })

  it('reads exact selected Host UTF-8 bytes and forwards cancellation without trusting Remote-local paths', async () => {
    const host = wire('host-files')
    const signal = new AbortController().signal
    const files: EditorHostFiles = {
      stat: vi.fn<EditorHostFiles['stat']>(async () => ({ ok: true, value: { absolutePath: '/host/文档.md', version: 'v1' } })),
      readBytes: vi.fn<EditorHostFiles['readBytes']>(async () => ({ ok: true, value: { absolutePath: '/host/文档.md', version: 'v1', data: new TextEncoder().encode('真实 Host 内容') } })),
      openWorkspacePath: vi.fn<EditorHostFiles['openWorkspacePath']>(async () => ({ ok: true, value: { opened: true } })),
    }
    expect(await readHostFile(host.selected, files, '文档.md', signal)).toEqual({ absolutePath: '/host/文档.md', version: 'v1', text: '真实 Host 内容' })
    expect(files.stat).toHaveBeenCalledWith(host.selected.ref.sessionId, '文档.md', signal)
    expect(files.readBytes).toHaveBeenCalledWith(host.selected.ref.sessionId, '文档.md', signal)
    vi.mocked(files.stat).mockResolvedValueOnce(denied('Host stat denied'))
    await expect(readHostFile(host.selected, files, '/private', signal)).rejects.toThrow('Host stat denied')
    vi.mocked(files.readBytes).mockResolvedValueOnce(denied('Host read denied'))
    await expect(readHostFile(host.selected, files, 'denied', signal)).rejects.toThrow('Host read denied')
    vi.mocked(files.readBytes).mockResolvedValueOnce({ ok: true, value: { absolutePath: '/host/binary', version: 'v2', data: new Uint8Array([0xff]) } })
    await expect(readHostFile(host.selected, files, 'binary', signal)).rejects.toThrow()
  })
})
