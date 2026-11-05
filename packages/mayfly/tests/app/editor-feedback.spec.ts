/** Actual editor teaching facts and operation-owned delayed notification waits. @module tests/remote/editor-feedback */
import { Context } from '@deepseek-ai/cordis'
import type { MayflyEditor } from '../../src/core.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteEditorFeedback } from '../../src/app/editor-feedback.ts'
import type { EditorToken } from '../../src/app/editor/types.ts'
import { submissionFixture } from './editor-feature-fixture.ts'

const owners: Context[] = []
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.fiber.dispose()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function fixture() {
  const ctx = new Context()
  owners.push(ctx)
  const recall = vi.fn()
  const hint = vi.fn()
  const wait = vi.fn()
  ctx.on('mayfly/prompt-recall-changed', recall)
  ctx.on('mayfly/prompt-hint-changed', hint)
  ctx.on('mayfly/prompt-wait-changed', wait)
  const feedback = new RemoteEditorFeedback(ctx, key => key)
  return { ctx, feedback, recall, hint, wait }
}

describe('Remote editor feedback', () => {
  it('reads actual history movement, deduplicates snapshots and clears recall on an ordinary draft', () => {
    const f = fixture()
    const { editor } = submissionFixture()
    editor.onChange = () => { f.feedback.recall(editor) }
    editor.addToHistory('first message')
    editor.addToHistory('second message')
    editor.handleInput?.('\x1b[A')
    expect(editor.getText()).toBe('second message')
    expect(f.recall).toHaveBeenLastCalledWith({ index: 1, total: 2 })
    f.feedback.recall(editor)
    expect(f.recall).toHaveBeenCalledOnce()
    editor.handleInput?.('\x1b[A')
    expect(f.recall).toHaveBeenLastCalledWith({ index: 2, total: 2 })
    editor.handleInput?.('\x1b[B')
    editor.handleInput?.('\x1b[B')
    expect(f.recall).toHaveBeenLastCalledWith(undefined)
    f.feedback.recall({} as MayflyEditor)
    expect(f.recall).toHaveBeenCalledTimes(4)
    f.feedback.dispose()
    f.feedback.recall(editor)
    expect(f.recall).toHaveBeenCalledTimes(4)
  })

  it('uses exact token teaching strings and releases its current hint and recall on unload', async () => {
    const f = fixture()
    f.feedback.token({ kind: 'image' } as EditorToken)
    expect(f.hint).toHaveBeenLastCalledWith('Ctrl+G shows it · Backspace removes')
    f.feedback.token({ kind: 'image' } as EditorToken)
    expect(f.hint).toHaveBeenCalledOnce()
    f.feedback.token({ kind: 'paste' } as EditorToken)
    expect(f.hint).toHaveBeenLastCalledWith('Ctrl+G opens · Backspace removes')
    f.feedback.token(undefined)
    expect(f.hint).toHaveBeenLastCalledWith(undefined)
    f.feedback.token({ kind: 'mention' } as EditorToken)
    f.feedback.recall({ getHistoryPosition: () => ({ index: 1, total: 3 }) } as MayflyEditor)
    await f.ctx.fiber.dispose()
    expect(f.hint).toHaveBeenLastCalledWith(undefined)
    expect(f.recall).toHaveBeenLastCalledWith(undefined)
    const count = f.hint.mock.calls.length
    f.feedback.token({ kind: 'image' } as EditorToken)
    f.feedback.dispose()
    expect(f.hint).toHaveBeenCalledTimes(count)
  })

  it('keeps quick and pre-aborted operations quiet, including a queued retired timeout', () => {
    vi.useFakeTimers()
    const f = fixture()
    const timer = vi.spyOn(globalThis, 'setTimeout')
    const signal = new AbortController()
    const remove = vi.spyOn(signal.signal, 'removeEventListener')
    const end = f.feedback.beginWait('quick', signal.signal)
    const queued = timer.mock.calls.at(-1)![0] as () => void
    vi.advanceTimersByTime(149)
    expect(f.wait).not.toHaveBeenCalled()
    end()
    end()
    queued()
    vi.advanceTimersByTime(1)
    expect(f.wait).not.toHaveBeenCalled()
    expect(remove).toHaveBeenCalledWith('abort', end)
    f.feedback.beginWait('aborted', AbortSignal.abort())()
    f.feedback.dispose()
    f.feedback.beginWait('unloaded', new AbortController().signal)()
    expect(vi.getTimerCount()).toBe(0)
    expect(f.wait).not.toHaveBeenCalled()
  })

  it('shows newest slow wait and restores the older live wait after cancellation', () => {
    vi.useFakeTimers()
    const f = fixture()
    const first = new AbortController()
    const second = new AbortController()
    const endFirst = f.feedback.beginWait('Searching files…', first.signal)
    vi.advanceTimersByTime(150)
    expect(f.wait).toHaveBeenLastCalledWith('Searching files…')
    f.feedback.beginWait('Reading the clipboard…', second.signal)
    vi.advanceTimersByTime(149)
    expect(f.wait).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(1)
    expect(f.wait).toHaveBeenLastCalledWith('Reading the clipboard…')
    second.abort()
    expect(f.wait).toHaveBeenLastCalledWith('Searching files…')
    endFirst()
    first.abort()
    expect(f.wait.mock.calls.map(call => call[0])).toEqual(['Searching files…', 'Reading the clipboard…', 'Searching files…', undefined])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears shown waits and pending timers when the owning Fiber unloads', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const active = new AbortController()
    const pending = new AbortController()
    const endActive = f.feedback.beginWait('active', active.signal)
    vi.advanceTimersByTime(150)
    const endPending = f.feedback.beginWait('pending', pending.signal)
    await f.ctx.fiber.dispose()
    expect(f.wait.mock.calls.map(call => call[0])).toEqual(['active', undefined])
    expect(vi.getTimerCount()).toBe(0)
    active.abort()
    pending.abort()
    endActive()
    endPending()
    vi.advanceTimersByTime(300)
    expect(f.wait).toHaveBeenCalledTimes(2)
  })
})
