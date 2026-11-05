import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostClient } from '../../src/client/types.ts'
import { createRemoteSettingsEditor } from '../../src/app/features/settings-editor.ts'

const client = {} as HostClient
afterEach(() => vi.unstubAllEnvs())

describe('settings document editor handoff', () => {
  it('uses the native local editor path from the environment and handles an absent command', async () => {
    vi.stubEnv('VISUAL', undefined)
    vi.stubEnv('EDITOR', undefined)
    const editor = createRemoteSettingsEditor({ suspend: run => run() })
    await expect(editor(client, 'unchanged native file\n', new AbortController().signal)).rejects.toThrow('Set $VISUAL or $EDITOR')
    vi.stubEnv('VISUAL', 'true')
    await expect(editor(client, 'unchanged native file\n', new AbortController().signal)).resolves.toBe('unchanged native file\n')
  })

  it('suspends the terminal around a local editor and returns the unchanged document verbatim', async () => {
    const order: string[] = []
    const signal = new AbortController().signal
    const edit = vi.fn(async () => { order.push('edit'); return 'changed\n' })
    const editor = createRemoteSettingsEditor({
      command: () => 'visual --wait',
      edit,
      async suspend(run) {
        order.push('suspend')
        try { return await run() } finally { order.push('resume') }
      },
    })
    expect(await editor(client, 'original\n', signal)).toBe('changed\n')
    expect(edit).toHaveBeenCalledWith('original\n', 'visual --wait', signal)
    expect(order).toEqual(['suspend', 'edit', 'resume'])
  })

  it('refuses concurrent editors and discards a result after cancellation', async () => {
    const abort = new AbortController()
    let finish!: (value: string) => void
    const editor = createRemoteSettingsEditor({
      command: () => 'visual',
      suspend: run => run(),
      edit: () => new Promise(done => { finish = done }),
    })
    const pending = editor(client, 'original', abort.signal)
    await expect(editor(client, 'other', abort.signal)).rejects.toThrow('already open')
    abort.abort()
    finish('late edit')
    await expect(pending).resolves.toBeUndefined()
    await expect(editor(client, 'cancelled', abort.signal)).resolves.toBeUndefined()
  })

  it('releases exclusivity after a failed suspension and checks cancellation before spawning', async () => {
    const edit = vi.fn(async () => 'new')
    const abort = new AbortController()
    let fails = true
    const editor = createRemoteSettingsEditor({
      command: () => 'visual',
      edit,
      async suspend(run) {
        if (fails) throw new Error('screen unavailable')
        abort.abort()
        return await run()
      },
    })
    await expect(editor(client, 'original', abort.signal)).rejects.toThrow('screen unavailable')
    fails = false
    await expect(editor(client, 'original', abort.signal)).resolves.toBeUndefined()
    expect(edit).not.toHaveBeenCalled()
  })

  it('requires an editor command and propagates editing failures after terminal restoration', async () => {
    const editor = createRemoteSettingsEditor({ command: () => '', suspend: run => run() })
    await expect(editor(client, '', new AbortController().signal)).rejects.toThrow('Set $VISUAL or $EDITOR')
    const resume = vi.fn()
    const failing = createRemoteSettingsEditor({
      command: () => 'visual',
      edit: async () => { throw new Error('spawn failed') },
      async suspend(run) { try { return await run() } finally { resume() } },
    })
    await expect(failing(client, '', new AbortController().signal)).rejects.toThrow('spawn failed')
    expect(resume).toHaveBeenCalledOnce()
  })
})
