/** External editor handoff preserves local drafts and cleans every staging outcome. @module */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { editLocalText, quoteLocalShellArg, resolveExternalEditorCommand } from '../../src/app/local/external-editor.ts'

const local = vi.hoisted(() => ({
  mkdtemp: vi.fn(async () => '/private editor stage'),
  writeFile: vi.fn(async () => {}),
  readFile: vi.fn(async () => 'edited draft'),
  rm: vi.fn(async () => {}),
  runInheritedShell: vi.fn(async () => 0),
}))
vi.mock('node:fs/promises', () => local)
vi.mock('../../src/app/local/process.ts', () => ({ runInheritedShell: local.runInheritedShell }))
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs() })

describe('Remote-local external editor', () => {
  it('resolves explicit configuration before VISUAL and EDITOR, trimming blank values', () => {
    expect(resolveExternalEditorCommand({ VISUAL: ' vim ', EDITOR: 'emacs' }, ' code --wait ')).toBe('code --wait')
    expect(resolveExternalEditorCommand({ VISUAL: ' vim ', EDITOR: 'emacs' })).toBe('vim')
    expect(resolveExternalEditorCommand({ VISUAL: ' ', EDITOR: ' nano ' })).toBe('nano')
    expect(resolveExternalEditorCommand({})).toBeUndefined()
    vi.stubEnv('VISUAL', 'default-env-editor')
    expect(resolveExternalEditorCommand()).toBe('default-env-editor')
  })

  it('quotes a local path as one argument on POSIX and Windows', () => {
    expect(quoteLocalShellArg("a'b $(literal)", 'linux')).toBe("'a'\\''b $(literal)'")
    expect(quoteLocalShellArg('a"b', 'win32')).toBe('"a\\"b"')
    expect(quoteLocalShellArg('a path')).toBe(process.platform === 'win32' ? '"a path"' : "'a path'")
  })

  it('seeds Unicode text, invokes the exact local command, and reads back only a successful exit', async () => {
    const signal = new AbortController().signal
    expect(await editLocalText('  中文\n draft  ', 'code --wait', signal)).toBe('edited draft')
    expect(local.writeFile).toHaveBeenCalledExactlyOnceWith('/private editor stage/prompt.md', '  中文\n draft  ', 'utf8')
    expect(local.runInheritedShell).toHaveBeenCalledExactlyOnceWith(`code --wait ${quoteLocalShellArg('/private editor stage/prompt.md')}`, signal)
    expect(local.readFile).toHaveBeenCalledExactlyOnceWith('/private editor stage/prompt.md', 'utf8')
    expect(local.rm).toHaveBeenCalledExactlyOnceWith('/private editor stage', { recursive: true, force: true })
  })

  it.each(['exit', 'abort'] as const)('keeps the caller draft after %s', async reason => {
    const lifetime = new AbortController()
    local.runInheritedShell.mockImplementationOnce(async () => {
      if (reason === 'abort') lifetime.abort()
      return reason === 'exit' ? 1 : 0
    })
    expect(await editLocalText('keep me', 'editor', lifetime.signal)).toBeUndefined()
    expect(local.readFile).not.toHaveBeenCalled()
    expect(local.rm).toHaveBeenCalledOnce()
  })

  it('cleans an editor staging directory even when seeding the draft fails', async () => {
    local.writeFile.mockRejectedValueOnce(new Error('disk full'))
    await expect(editLocalText('keep me', 'editor', new AbortController().signal)).rejects.toThrow('disk full')
    expect(local.runInheritedShell).not.toHaveBeenCalled()
    expect(local.rm).toHaveBeenCalledOnce()
  })

  it('preserves a readback or spawn failure and ignores only cleanup errors', async () => {
    local.runInheritedShell.mockRejectedValueOnce(new Error('launch failed'))
    await expect(editLocalText('keep me', 'editor', new AbortController().signal)).rejects.toThrow('launch failed')
    local.readFile.mockRejectedValueOnce(new Error('read failed'))
    local.rm.mockRejectedValueOnce(new Error('cleanup failed'))
    await expect(editLocalText('keep me', 'editor', new AbortController().signal)).rejects.toThrow('read failed')
    expect(local.rm).toHaveBeenCalledTimes(2)
  })
})
