/** Initial native plan preparation owns an exact binding before draft admission. @module tests/remote/editor-preparation */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorSubmit } from '../../src/app/editor/submit.ts'
import type { EditorFeatureSession } from '../../src/app/editor/types.ts'
import { deferred, flush, submissionFixture, translate, wire } from './editor-feature-fixture.ts'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

function fixture() {
  const host = wire('one')
  const prep = deferred<void>()
  let current: EditorFeatureSession | undefined
  const f = submissionFixture()
  const select = (selected: EditorFeatureSession | undefined): void => { current = selected; f.select(selected) }
  const preparePrompt = vi.fn((_selected: EditorFeatureSession, _signal: AbortSignal) => prep.promise)
  const ensureSession = vi.fn(async () => { select(host.selected); return host.selected })
  f.submit.dispose()
  const submit = new EditorSubmit({
    editor: f.editor, screen: f.screen, session: () => current, ensureSession, preparePrompt,
    commands: f.commands, skills: f.skills, attachments: f.attachments, draft: f.draft,
    notice: { set: text => { f.notices.push(text) } }, t: translate, exit: f.exit,
  })
  f.editor.onSubmit = value => { submit.submit(value) }
  cleanups.push(() => { submit.dispose() })
  return { ...f, submit, select, host, prep, preparePrompt, ensureSession }
}

describe('initial prompt preparation', () => {
  it('assigns the created exact binding and waits before beginSubmission or prompt', async () => {
    const f = fixture()
    f.enter('first prompt')
    await flush()
    expect(f.ensureSession).toHaveBeenCalledOnce()
    expect(f.preparePrompt).toHaveBeenCalledWith(f.host.selected, expect.any(AbortSignal))
    expect(f.host.begin).toEqual([])
    expect(f.host.prompt).not.toHaveBeenCalled()
    f.prep.resolve()
    await flush()
    expect(f.host.begin[0]!.text).toBe('first prompt')
    expect(f.host.prompt).toHaveBeenCalledOnce()
    expect(f.editor.getText()).toBe('')
  })

  it('restores exact whitespace and paste data, removes failed history, and reports an exact-selection failure', async () => {
    const f = fixture()
    const pasted = Array.from({ length: 20 }, (_, index) => `  source line ${String(index)}  `).join('\n')
    f.editor.setText('  prefix ')
    f.editor.handleInput?.(`\x1b[200~${pasted}\x1b[201~`)
    const captured = f.editor.captureDraft!()
    expect(captured.pastes.size).toBeGreaterThan(0)
    const expanded = f.editor.getExpandedText()
    f.editor.handleInput?.('\r')
    await flush()
    f.prep.reject(new Error('plan command unavailable'))
    await flush()
    expect(f.editor.captureDraft!()).toEqual(captured)
    expect(f.editor.getExpandedText()).toBe(expanded)
    expect(f.editor.getHistory()).toEqual([])
    expect(f.editor.getHistoryPastes()).toEqual([])
    expect(f.draft.currentDraft()).toEqual(captured)
    expect(f.notices).toEqual([expect.stringContaining('plan command unavailable')])
    expect(f.host.begin).toEqual([])
    expect(f.host.prompt).not.toHaveBeenCalled()
  })

  it.each(['host', 'client', 'generation', 'clear'] as const)('never restores or admits a retired preparation after %s changes', async kind => {
    const f = fixture()
    f.enter('retired first prompt')
    await flush()
    const other = wire('two')
    f.select(kind === 'clear' ? undefined : kind === 'host' ? other.selected : {
      ...f.host.selected,
      ...kind === 'client' ? { client: other.selected.client } : { generation: f.host.selected.generation + 1 },
    })
    f.prep.reject(new Error('retired error'))
    await flush()
    expect(f.editor.getText()).toBe('')
    expect(f.notices).toEqual([])
    expect(f.host.begin).toEqual([])
    expect(f.host.prompt).not.toHaveBeenCalled()
    expect(other.prompt).not.toHaveBeenCalled()
  })

  it('does not overwrite a newer draft on failure', async () => {
    const f = fixture()
    f.enter('submitted prompt')
    await flush()
    f.editor.setText('new draft')
    f.prep.reject(new Error('preparation failed'))
    await flush()
    expect(f.editor.getText()).toBe('new draft')
    expect(f.host.prompt).not.toHaveBeenCalled()
  })

  it('fences late preparation success after clearing back to sessionless', async () => {
    const f = fixture()
    f.enter('do not send after clear')
    await flush()
    f.select(undefined)
    f.prep.resolve()
    await flush()
    expect(f.host.begin).toEqual([])
    expect(f.host.prompt).not.toHaveBeenCalled()
    expect(f.editor.getText()).toBe('')
    expect(f.notices).toEqual([])
  })

  it('aborts local preparation on disposal without restoring or writing later', async () => {
    const f = fixture()
    f.enter('do not send after dispose')
    await flush()
    const signal = f.preparePrompt.mock.calls[0]![1] as AbortSignal
    f.submit.dispose()
    expect(signal.aborted).toBe(true)
    f.prep.resolve()
    await flush()
    expect(f.host.begin).toEqual([])
    expect(f.host.prompt).not.toHaveBeenCalled()
    expect(f.editor.getText()).toBe('')
    expect(f.notices).toEqual([])
  })
})
